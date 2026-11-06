import {syncConfig} from './sync-config.js'
import {isCalendarEvent, isTheaterId} from './planner.js'

export const syncEnabled = Boolean(syncConfig.url && syncConfig.publishableKey)
const connectionKey = 'antrakt:sync:v1'
const linkPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.[a-f\d]{64}$/

export function syncConnection(fragment = '') {
  const link = fragment.startsWith('#sync=') ? fragment.slice(6) : localStorage.getItem(connectionKey)
  if (!link || !linkPattern.test(link)) return null
  const [calendarId, token] = link.split('.')
  return {calendarId, token, link}
}

export function rememberSync(connection) {
  if (connection) localStorage.setItem(connectionKey, connection.link)
  else localStorage.removeItem(connectionKey)
}

export function validSchedule(data) {
  return data && Array.isArray(data.events) && data.events.every(isCalendarEvent)
    && [data.hiddenShows,data.importantShows].every(ids => Array.isArray(ids) && ids.every(isTheaterId))
}

async function rpc(name, connection, args = {}) {
  const response = await fetch(syncConfig.url.replace(/\/+$/,'') + '/rest/v1/rpc/' + name, {
    method:'POST', cache:'no-store', signal:AbortSignal.timeout(10000),
    headers:{apikey:syncConfig.publishableKey,'Content-Type':'application/json'},
    body:JSON.stringify({calendar_id:connection.calendarId,access_token:connection.token,...args}),
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('Ссылка больше не открывает общий календарь.')
    throw new Error('Синхронизация временно недоступна. Попробуй ещё раз.')
  }
  return response.json()
}

export async function readSync(connection) {
  const snapshot = await rpc('antrakt_read',connection)
  if (!snapshot || !Number.isSafeInteger(snapshot.revision) || typeof snapshot.canEdit !== 'boolean' || !validSchedule(snapshot.data)) {
    throw new Error('Не удалось открыть общий календарь.')
  }
  return snapshot
}

export async function writeSync(connection, change) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = await readSync(connection)
    if (!snapshot.canEdit) throw new Error('Эта ссылка доступна только для просмотра.')
    const data = change(snapshot.data)
    if (!validSchedule(data)) throw new Error('Проверь данные события.')
    const revision = await rpc('antrakt_write',connection,{expected_revision:snapshot.revision,next_data:data})
    if (Number.isSafeInteger(revision)) return {data,revision,canEdit:true}
  }
  throw new Error('Расписание изменилось на другом устройстве. Повтори сохранение.')
}
