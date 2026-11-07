import {syncConfig} from './sync-config.js'
import {validSchedule} from './sync.js'

export const accountEnabled = Boolean(syncConfig.url && syncConfig.publishableKey)
export const accountKey = 'antrakt:account:v1'
const tokenPattern = /^[a-f0-9]{64}$/
const namePattern = /^[\p{L}\p{N} _.-]{2,40}$/u

export function canEditAccount(cloud) {
  return Boolean(cloud?.canEdit === true && !cloud.expired
    && tokenPattern.test(cloud.connection?.token)
    && Date.parse(cloud.connection?.expiresAt) > Date.now())
}

export function accountSession() {
  try {
    const value = JSON.parse(localStorage.getItem(accountKey) || 'null')
    if (!value || !tokenPattern.test(value.token) || typeof value.username !== 'string' || !namePattern.test(value.username) || Date.parse(value.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(value.expiresAt))) return null
    return value
  } catch { return null }
}

export function rememberAccount(session) {
  if (session) localStorage.setItem(accountKey,JSON.stringify({token:session.token,username:session.username,expiresAt:session.expiresAt}))
  else localStorage.removeItem(accountKey)
}

function accountError(message, kind = 'connection') {
  return Object.assign(new Error(message),{kind})
}

async function rpc(name, args) {
  if (!accountEnabled) throw accountError('Вход пока недоступен. Можно продолжать пользоваться календарём без входа.')
  let response
  try {
    response = await fetch(syncConfig.url.replace(/\/+$/,'') + '/rest/v1/rpc/' + name,{
      method:'POST',cache:'no-store',signal:AbortSignal.timeout(12000),
      headers:{apikey:syncConfig.publishableKey,'Content-Type':'application/json'},body:JSON.stringify(args),
    })
  } catch { throw accountError('Не удалось связаться с календарём. Проверь интернет и попробуй ещё раз.') }
  if (!response.ok) throw accountError('Не удалось связаться с календарём. Попробуй ещё раз.')
  const value = await response.json()
  if (value?.error === 'credentials') throw accountError('Имя или код не подошли. Проверь их и попробуй ещё раз.','credentials')
  if (value?.error === 'exists') throw accountError('Это имя уже занято. Войди с ним или выбери другое имя.','exists')
  if (value?.error === 'limited') throw accountError('Слишком много попыток. Попробуй через 15 минут.','limited')
  if (value?.error === 'session') throw accountError('Войди снова, чтобы открыть своё расписание.','session')
  if (value?.error) throw accountError('Не удалось сохранить расписание. Проверь данные и попробуй ещё раз.')
  return value
}

function snapshotOf(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.username !== 'string' || !namePattern.test(value.username) || !validSchedule(value.data)) {
    throw accountError('Не удалось прочитать расписание. Попробуй ещё раз.')
  }
  return {...value,canEdit:true}
}

export async function signInAccount(username, pin, create = false) {
  username = username.normalize('NFKC').trim().replace(/\s+/gu,' ')
  if (!namePattern.test(username)) throw accountError('Введи имя от 2 до 40 символов. Подойдут буквы, цифры, пробел, точка, дефис и подчёркивание.','input')
  if (!/^\d{4}$/.test(pin)) throw accountError('Код должен состоять ровно из четырёх цифр.','input')
  const value = await rpc('antrakt_account_sign_in',{account_name:username,pin_code:pin,create_account:create})
  const snapshot = snapshotOf(value)
  if (!tokenPattern.test(value.token) || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
    throw accountError('Не удалось войти. Попробуй ещё раз.')
  }
  return {connection:{token:value.token,username:value.username,expiresAt:value.expiresAt},snapshot}
}

export async function readAccount(connection) {
  return snapshotOf(await rpc('antrakt_account_read',{session_token:connection.token}))
}

export async function writeAccount(connection, change) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = await readAccount(connection)
    const data = change(snapshot.data)
    if (!validSchedule(data)) throw accountError('Проверь данные события.','input')
    const result = await rpc('antrakt_account_write',{session_token:connection.token,expected_revision:snapshot.revision,next_data:data})
    if (result && Number.isSafeInteger(result.revision)) return {...snapshot,data,revision:result.revision}
  }
  throw accountError('Расписание изменилось на другом устройстве. Повтори сохранение.')
}

export async function signOutAccount(connection) {
  await rpc('antrakt_account_sign_out',{session_token:connection.token})
}
