import {supabase} from './config.js'

const prefix = 'antrakt:v1:'
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const toBytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0))
const toBase64 = value => btoa(Array.from(new Uint8Array(value), byte => String.fromCharCode(byte)).join(''))
export const cloudEnabled = Boolean(supabase.url && supabase.publishableKey)

async function deriveKey(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {name:'PBKDF2', salt, iterations:600000, hash:'SHA-256'},
    material, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt'],
  )
}

async function localAccount(login, password, create) {
  if (!globalThis.crypto?.subtle) throw new Error('Для входа открой планер по HTTPS или через localhost.')
  if (!/^[\p{L}\p{N}_.@+-]{3,64}$/u.test(login)) {
    throw new Error('Логин должен содержать от 3 до 64 букв, цифр или символов _.@+- без пробелов.')
  }
  const storageKey = prefix + login
  const read = () => JSON.parse(localStorage.getItem(storageKey))
  const existing = read()
  if (create && existing) throw new Error('Этот логин уже занят в данном браузере.')
  if (!create && !existing) throw new Error('Проверь логин и пароль.')

  const salt = existing ? toBytes(existing.salt) : crypto.getRandomValues(new Uint8Array(16))
  const key = await deriveKey(password, salt)
  const algorithm = iv => ({name:'AES-GCM', iv, additionalData:encoder.encode(storageKey)})
  const load = async () => {
    const account = read()
    if (!account) throw new Error('Аккаунт удалён из хранилища браузера.')
    const bytes = await crypto.subtle.decrypt(algorithm(toBytes(account.iv)), key, toBytes(account.data))
    return JSON.parse(decoder.decode(bytes))
  }
  const save = async events => {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = await crypto.subtle.encrypt(algorithm(iv), key, encoder.encode(JSON.stringify(events)))
    localStorage.setItem(storageKey, JSON.stringify({salt:toBase64(salt), iv:toBase64(iv), data:toBase64(data)}))
  }
  const lock = callback => navigator.locks ? navigator.locks.request(storageKey, callback) : callback()
  if (create) {
    await lock(async () => {
      if (read()) throw new Error('Этот логин уже занят в данном браузере.')
      await save([])
    })
  } else {
    try {
      await load()
    } catch {
      throw new Error('Проверь логин и пароль.')
    }
  }
  return {
    login,
    load,
    save: event => lock(async () => {
      const events = (await load()).filter(item => item.id !== event.id)
      await save([...events, event])
    }),
    remove: id => lock(async () => save((await load()).filter(item => item.id !== id))),
    signOut: async () => {},
  }
}

function friendlyError(data) {
  if (data.code === 'email_not_confirmed' || data.error_code === 'email_not_confirmed') return 'Подтверди email по ссылке из письма, затем войди.'
  if (data.code === 'invalid_credentials' || data.error_code === 'invalid_credentials' || data.error === 'invalid_grant') return 'Проверь логин и пароль.'
  if (data.code === 'weak_password' || data.error_code === 'weak_password') return 'Пароль не соответствует требованиям проекта. Попробуй более длинный пароль.'
  if (data.code === 'over_email_send_rate_limit' || data.error_code === 'over_email_send_rate_limit') return 'Письма отправлялись слишком часто. Попробуй чуть позже.'
  return 'Сервис аккаунтов временно недоступен. Попробуй ещё раз.'
}

async function request(path, {method='GET', token, body, prefer} = {}) {
  let response
  try {
    response = await fetch(supabase.url.replace(/\/+$/,'') + path, {
      method, cache:'no-store',
      headers:{
        apikey:supabase.publishableKey,
        ...(token ? {Authorization:'Bearer ' + token} : {}),
        ...(prefer ? {Prefer:prefer} : {}),
        ...(body ? {'Content-Type':'application/json'} : {}),
      },
      body:body ? JSON.stringify(body) : undefined,
      signal:AbortSignal.timeout(12000),
    })
  } catch {
    throw new Error('Не удалось связаться с сервером. Проверь подключение и попробуй ещё раз.')
  }
  if (response.status === 204) return null
  const text = await response.text()
  let data = null
  if (text) {
    try { data = JSON.parse(text) } catch { throw new Error('Сервер вернул неожиданный ответ.') }
  }
  if (!response.ok) throw new Error(friendlyError(data || {}))
  return data
}

async function cloudAccount(login, password, create) {
  const credentials = {email:login, password}
  const redirect = new URL('./', location.href).href
  let session = create
    ? await request('/auth/v1/signup?redirect_to=' + encodeURIComponent(redirect), {method:'POST',body:credentials})
    : await request('/auth/v1/token?grant_type=password', {method:'POST',body:credentials})
  if (create && !session?.access_token) return {confirmation:true}
  if (!session?.user?.id || !session.access_token) throw new Error('Сервис аккаунтов вернул неполный ответ.')
  const userId = session.user.id
  const table = '/rest/v1/planner_events'
  let validUntil = Date.now() + session.expires_in * 1000
  let refreshing
  async function access() {
    if (Date.now() < validUntil - 30000) return session.access_token
    refreshing ??= request('/auth/v1/token?grant_type=refresh_token', {
      method:'POST', body:{refresh_token:session.refresh_token},
    }).then(value => {
      session = value
      validUntil = Date.now() + value.expires_in * 1000
      return value.access_token
    }).finally(() => { refreshing = null })
    return refreshing
  }
  return {
    login,
    load: async () => {
      const token = await access()
      const events = []
      const pageSize = 500
      for (let offset = 0; ; offset += pageSize) {
        const rows = await request(table + '?select=id,title,date,time,type&order=id&limit=' + pageSize + '&offset=' + offset, {token})
        events.push(...rows.map(row => ({...row, time:row.time?.slice(0,5) || ''})))
        if (rows.length < pageSize) return events
      }
    },
    save: async event => {
      await request(table + '?on_conflict=id', {
        method:'POST', token:await access(), prefer:'resolution=merge-duplicates,return=minimal',
        body:{...event, time:event.time || null, user_id:userId},
      })
    },
    remove: async id => {
      await request(table + '?id=eq.' + encodeURIComponent(id), {method:'DELETE', token:await access(), prefer:'return=minimal'})
    },
    signOut: async () => {
      await request('/auth/v1/logout?scope=local', {method:'POST',token:await access()})
    },
  }
}

export function openAccount(input, password, create) {
  const login = input.trim().normalize('NFKC').toLowerCase()
  if (create && password.length < 8) throw new Error('Придумай пароль длиной от 8 символов.')
  return cloudEnabled ? cloudAccount(login, password, create) : localAccount(login, password, create)
}

export async function readLegacyEvents(input, password) {
  const login = input.trim().normalize('NFKC').toLowerCase()
  const account = await localAccount(login, password, false)
  return account.load()
}
