import {
  addDays, categories, countLabel, dateLabel, dateOf, dayLabel, firstOfMonth,
  eventTime, interpret, monthDays, months, moveMonth, pad, scheduleFragment, scheduleFromFragment,
  shortLabel, sortEvents, stamp, today, weekLabels, weekStart,
} from './planner.js'
import {readSync, rememberSync, syncConnection, syncEnabled, validSchedule, writeSync} from './sync.js'

const $ = id => document.getElementById(id)
const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>'
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const theaterUrl = 'https://nmdt.ru/afisha/events/'
const scheduleKey = 'antrakt:calendar:v2'
const hiddenShowsKey = 'antrakt:hidden-shows:v1'
const plannerKey = 'antrakt:calendar:v3'
const dialog = $('modal')
const initialChat = $('chat-log').innerHTML
const state = {date:today(), view:'month', panel:'calendar', filter:'all', personal:[], hiddenShows:[], importantShows:[], cloud:null, shared:null, feed:{months:[],events:[],stale:false}, feedLoading:true}
let toastTimer
let previousFocus
let mutating = false

function visibleShows() {
  const hidden = new Set(state.shared?.hiddenShows ?? state.hiddenShows)
  const important = new Set(state.shared?.importantShows ?? state.importantShows)
  return state.feed.events.filter(event => !hidden.has(event.id)).map(event => important.has(event.id) ? {...event,important:true} : event)
}

function calendarEvents() {
  return [...(state.shared?.events ?? state.personal), ...visibleShows()]
}

function byDay() {
  const map = new Map()
  for (const event of sortEvents(calendarEvents())) {
    const matches = state.filter === 'mine'
      ? event.source === 'theater' && event.myShow === true
      : state.filter === 'all' || event.type === state.filter
    if (!matches) continue
    if (!map.has(event.date)) map.set(event.date, [])
    map.get(event.date).push(event)
  }
  return map
}

function notify(message) {
  const toast = $('toast')
  toast.textContent = message
  toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.hidden = true }, 3300)
}

function eventTone(event) {
  return event.source === 'theater' && event.myShow !== true ? 'other-show' : event.type
}

function eventRow(event, withDate = false) {
  const type = categories[event.type] || categories.personal
  const detail = [withDate ? shortLabel(dateOf(event.date)) : '', eventTime(event) || 'Без времени', event.source ? 'Афиша театра' : type.label].filter(Boolean).join(' · ')
  return `<button class="event-row ${eventTone(event)}${event.important ? ' important' : ''}" type="button" data-event="${escape(event.id)}"><span class="event-icon ${eventTone(event)}">${icon(type.icon)}</span><span class="event-text"><strong>${escape(event.title)}</strong><small>${escape(detail)}${event.important ? ' · Важно' : ''}</small></span>${icon('right')}</button>`
}

function dayTimeline(events) {
  const minutes = clock => +clock.slice(0,2) * 60 + +clock.slice(3)
  const marks = events.filter(event => event.time).map(event => {
    const start = minutes(event.time)
    const offset = 100 * start / 1440
    if (!event.endTime) return `<i class="busy-point" style="left:${offset}%"></i>`
    const width = 100 * (minutes(event.endTime) - start) / 1440
    return `<i class="busy-block" style="left:${offset}%;width:${width}%"></i>`
  }).join('')
  if (!marks) return ''
  return `<div class="day-timeline" aria-hidden="true"><div class="busy-track">${marks}</div><div class="busy-hours"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div></div>`
}

function renderCalendar(restoreFocus = false) {
  const date = state.date
  const current = stamp(today())
  const selected = stamp(date)
  const first = firstOfMonth(date)
  const monthStart = weekStart(first)
  const map = byDay()
  const month = months[date.getMonth()]
  let label = month + ' ' + date.getFullYear()
  let contents

  if (state.view === 'year') {
    label = String(date.getFullYear())
    const counts = new Map()
    for (const [day, events] of map) {
      const key = day.slice(0,7)
      counts.set(key,(counts.get(key) || 0) + events.length)
    }
    contents = '<div class="year-grid">' + months.map((name, index) => {
      const count = counts.get(label + '-' + pad(index + 1)) || 0
      return `<button class="year-month" type="button" data-month="${index}" aria-pressed="${index === date.getMonth()}"><strong>${name}</strong><small>${countLabel(count)}</small></button>`
    }).join('') + '</div>'
  } else if (state.view === 'day') {
    label = shortLabel(date) + ' ' + date.getFullYear()
    contents = `<div class="day-banner"><strong>${pad(date.getDate())}</strong><span>${dayLabel(date)}</span></div>` + dayTimeline(map.get(selected) || [])
  } else {
    const isWeek = state.view === 'week'
    const start = isWeek ? weekStart(date) : monthStart
    const offset = (first.getDay() + 6) % 7
    const length = isWeek ? 7 : Math.ceil((offset + monthDays(date)) / 7) * 7
    if (isWeek) label = shortLabel(start) + ' – ' + shortLabel(addDays(start, 6))
    const cells = Array.from({length}, (_, index) => {
      const day = addDays(start, index)
      const key = stamp(day)
      const events = map.get(key) || []
      const outside = !isWeek && day.getMonth() !== date.getMonth()
      const filming = events.find(event => event.type === 'filming')
      const important = events.find(event => event.important)
      const flags = [outside ? 'outside' : '', key === current ? 'current' : '', key === selected ? 'selected' : '', filming ? 'filming-day' : '', important ? 'important-day' : ''].join(' ')
      const dots = [...new Set(events.map(eventTone))].map(type => `<i class="dot ${type}"></i>`).join('')
      const firstEvent = important || filming || events.find(event => eventTone(event) !== 'other-show') || events[0]
      const preview = firstEvent ? `<span class="cell-preview ${eventTone(firstEvent)}${firstEvent.important ? ' important' : ''}">${escape((firstEvent.time ? eventTime(firstEvent) + ' ' : '') + firstEvent.title)}${events.length > 1 ? ' +' + (events.length - 1) : ''}</span>` : ''
      const labels = [dayLabel(day), countLabel(events.length), filming ? 'День съёмок' : '', important ? 'Важное событие' : ''].filter(Boolean).join(', ')
      return `<button type="button" class="calendar-cell ${flags}" data-day="${key}" aria-pressed="${key === selected}" ${key === current ? 'aria-current="date"' : ''} aria-label="${labels}"><span class="cell-number">${day.getDate()}</span><span class="cell-dots" aria-hidden="true">${dots}</span>${preview}</button>`
    })
    contents = '<div class="weekday-grid" aria-hidden="true">' + weekLabels.map(day => '<span>' + day + '</span>').join('') + '</div><div class="calendar-grid">' + cells.join('') + '</div>'
  }

  $('period-label').textContent = label
  $('calendar-content').innerHTML = contents
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)))
  document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)))
  const castStatus = $('cast-status')
  let castMessage = ''
  if (state.filter === 'mine') {
    if (state.feedLoading) castMessage = 'Загружаем афишу…'
    else if (!state.feed.months.length) castMessage = 'Афиша пока недоступна.'
    else if (state.feed.events.some(event => typeof event.myShow !== 'boolean')) castMessage = 'Состав некоторых спектаклей пока не удалось проверить.'
  }
  castStatus.textContent = castMessage
  castStatus.hidden = !castMessage
  $('agenda-heading').textContent = selected === current ? 'Сегодня, ' + shortLabel(date) : dayLabel(date)
  const agenda = map.get(selected) || []
  $('agenda-count').textContent = countLabel(agenda.length)
  $('agenda-list').innerHTML = agenda.length ? agenda.map(event => eventRow(event)).join('') : '<p class="empty">' + (state.filter === 'all' ? 'На этот день пока нет событий.' : 'На этот день нет событий выбранного типа.') + '</p>'
  if (restoreFocus) $('calendar-content').querySelector('[data-day="' + selected + '"]')?.focus({preventScroll:true})
}

function feedStatus() {
  if (state.feedLoading) return 'Загружаем расписание театра…'
  if (!state.feed.months.length) return 'Афиша пока недоступна.'
  const date = new Date(state.feed.updatedAt)
  const formatted = new Intl.DateTimeFormat('ru-RU', {day:'numeric', month:'long', timeZone:'Europe/Moscow'}).format(date)
  return (state.feed.stale ? 'Последняя доступная версия · ' : 'Обновлено · ') + formatted
}

function renderTheater() {
  $('theater-status').textContent = feedStatus()
  const upcoming = visibleShows().find(event => event.date >= stamp(today()))
  $('theater-next').innerHTML = upcoming ? eventRow(upcoming,true) : '<p class="empty">Нет ближайших показов.</p>'
}

async function loadFeed() {
  try {
    const response = await fetch('./afisha.json', {cache:'no-cache', signal:AbortSignal.timeout(12000)})
    if (!response.ok) throw new Error()
    const data = await response.json()
    const events = data.events.filter(event => datePattern.test(event.date) && typeof event.title === 'string' && /^https:\/\/nmdt\.ru\/performance\/\d+\/?$/.test(event.url)).map(event => ({...event,type:'show',source:'theater'}))
    const stale = data.stale === true || Date.now() - new Date(data.updatedAt).getTime() > 96 * 60 * 60 * 1000
    state.feed = {...data, stale, events:sortEvents(events)}
  } catch {
    state.feed = {months:[],events:[],stale:true}
  } finally {
    state.feedLoading = false
    renderCalendar()
    renderTheater()
  }
}

function setPanel(panel, scroll = true) {
  state.panel = panel
  $('workspace').dataset.active = panel
  document.querySelectorAll('.navigation button').forEach(button => {
    if (button.dataset.panel === panel) button.setAttribute('aria-current','page')
    else button.removeAttribute('aria-current')
  })
  const target = panel === 'chat' ? $('chat-panel') : $('calendar-panel')
  if (scroll) target.scrollIntoView({block:'nearest'})
  if (panel === 'chat') $('chat-log').scrollTop = $('chat-log').scrollHeight
}

function jump(date) {
  state.date = dateOf(date)
  if (state.view === 'year') state.view = 'month'
  renderCalendar()
  setPanel('calendar')
}

function reveal(type) {
  if (state.filter !== 'all' && state.filter !== type) state.filter = 'all'
}

function shift(direction) {
  const months = {month:1,year:12}
  const date = months[state.view] ? moveMonth(state.date, direction * months[state.view]) : addDays(state.date, direction * (state.view === 'week' ? 7 : 1))
  if (date.getFullYear() >= 1900 && date.getFullYear() <= 2199) state.date = date
  renderCalendar()
}

function showDialog(title, label, content) {
  $('modal-content').innerHTML = `<div class="dialog-inner"><div class="dialog-heading"><div><p class="eyebrow">${label}</p><h2 id="dialog-title">${escape(title)}</h2></div><button class="icon-button" type="button" data-close aria-label="Закрыть">${icon('close')}</button></div>${content}</div>`
  if (!dialog.open) {
    previousFocus = document.activeElement
    dialog.showModal()
  }
}

dialog.addEventListener('close', () => {
  if (!dialog.open && previousFocus?.isConnected) previousFocus.focus({preventScroll:true})
})
dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close()
})

function picker() {
  const current = state.date
  const monthOptions = months.map((month,index) => `<option value="${index}" ${index === current.getMonth() ? 'selected' : ''}>${month}</option>`).join('')
  showDialog('Перейти к дате','КАЛЕНДАРЬ',`<form class="dialog-form" id="period-form"><div class="fields"><label>Месяц<select name="month">${monthOptions}</select></label><label>Год<input type="number" inputmode="numeric" min="1900" max="2199" name="year" value="${current.getFullYear()}" required></label></div><label>День<input type="number" inputmode="numeric" min="1" max="31" name="day" value="${current.getDate()}" required></label><div class="dialog-actions"><button class="button primary">Перейти</button></div></form>`)
  $('period-form').addEventListener('submit', event => {
    event.preventDefault()
    const fields = new FormData(event.target)
    const date = new Date(+fields.get('year'),+fields.get('month'),1,12)
    date.setDate(Math.min(+fields.get('day'),monthDays(date)))
    state.date = date
    dialog.close()
    renderCalendar()
  })
}

function readLocalSchedule() {
  const stored = localStorage.getItem(plannerKey)
  const data = stored ? JSON.parse(stored) : {
    events:JSON.parse(localStorage.getItem(scheduleKey) ?? '[]'),
    hiddenShows:JSON.parse(localStorage.getItem(hiddenShowsKey) ?? '[]'),
    importantShows:[],
  }
  if (!validSchedule(data)) throw new Error('Не удалось прочитать события в этом браузере.')
  return data
}

function applySchedule(data) {
  state.personal = data.events
  state.hiddenShows = data.hiddenShows
  state.importantShows = data.importantShows
}

function refreshLocalSchedule() {
  if (state.cloud) return
  try {
    applySchedule(readLocalSchedule())
  } catch {
    notify('Не удалось прочитать события в этом браузере.')
  }
}

function isReadOnly() {
  return Boolean(state.shared || (state.cloud && !state.cloud.canEdit))
}

async function updatePlanner(change) {
  if (isReadOnly()) throw new Error('Расписание доступно для просмотра.')
  if (mutating) throw new Error('Дождись окончания сохранения и попробуй ещё раз.')
  mutating = true
  try {
    const cloud = state.cloud
    if (cloud) {
      const snapshot = await writeSync(cloud.connection,change)
      if (state.cloud === cloud) applyCloudSnapshot(cloud,snapshot)
      return
    }
    const save = () => {
      const updated = change(readLocalSchedule())
      localStorage.setItem(plannerKey, JSON.stringify(updated))
      applySchedule(updated)
    }
    if (navigator.locks) await navigator.locks.request(plannerKey, save)
    else save()
  } finally {
    mutating = false
  }
}

function updateSchedule(change) {
  return updatePlanner(data => ({...data, events:change(data.events)}))
}

function changeEvent(event, remove = false) {
  return updateSchedule(events => {
    if (remove) return events.filter(item => item.id !== event.id)
    const index = events.findIndex(item => item.id === event.id)
    if (index === -1) events.push(event)
    else events[index] = event
    return events
  })
}

async function setShowFlag(key, id, enabled) {
  await updatePlanner(data => {
    const ids = new Set(data[key])
    if (enabled) ids.add(id)
    else ids.delete(id)
    return {...data,[key]:[...ids]}
  })
  renderCalendar()
  renderTheater()
}

window.addEventListener('storage', event => {
  if (state.cloud || (event.key !== plannerKey && event.key !== scheduleKey && event.key !== hiddenShowsKey && event.key !== null)) return
  refreshLocalSchedule()
  if (!state.shared) {
    renderCalendar()
    renderTheater()
  }
})

function updateAccessUI() {
  $('sync-banner').hidden = !state.cloud || Boolean(state.shared)
  $('sync-status').textContent = state.cloud?.status || ''
  $('add-event').hidden = isReadOnly()
  document.querySelectorAll('[data-creates-event]').forEach(button => { button.hidden = isReadOnly() })
}

function applyCloudSnapshot(cloud, snapshot) {
  if (snapshot.revision < cloud.revision) return false
  const changed = snapshot.revision !== cloud.revision || snapshot.canEdit !== cloud.canEdit
  cloud.revision = snapshot.revision
  cloud.canEdit = snapshot.canEdit
  cloud.status = snapshot.canEdit ? 'Синхронизация включена' : 'Только просмотр · обновляется автоматически'
  applySchedule(snapshot.data)
  updateAccessUI()
  return changed
}

let refreshingCloud = false
async function refreshCloud() {
  const cloud = state.cloud
  if (!cloud || mutating || refreshingCloud || document.hidden) return
  refreshingCloud = true
  try {
    const snapshot = await readSync(cloud.connection)
    if (state.cloud !== cloud || mutating) return
    if (applyCloudSnapshot(cloud,snapshot)) {
      renderCalendar()
      renderTheater()
    }
  } catch {
    if (state.cloud !== cloud || mutating) return
    cloud.status = 'Нет связи с общим календарём'
    updateAccessUI()
  } finally {
    refreshingCloud = false
  }
}

let connectionAttempt = 0
async function applyLocation() {
  const attempt = ++connectionAttempt
  const fragment = location.hash
  if (syncEnabled && fragment.startsWith('#sync=')) {
    const connection = syncConnection(fragment)
    try {
      if (!connection) throw new Error('Ссылка на общий календарь повреждена.')
      const snapshot = await readSync(connection)
      if (attempt !== connectionAttempt || fragment !== location.hash) return
      const cloud = {connection,revision:-1,canEdit:false,status:''}
      rememberSync(connection)
      state.cloud = cloud
      applyCloudSnapshot(cloud,snapshot)
      history.replaceState(null,'',location.pathname + location.search)
    } catch (error) {
      if (attempt !== connectionAttempt) return
      notify(error.message)
    }
  }
  await applySharedLink()
}

function syncSettings() {
  if (!state.cloud) return
  const importButton = state.cloud.canEdit ? '<button class="button primary" type="button" id="sync-import">Перенести записи с этого устройства</button>' : ''
  showDialog('Общий календарь','СИНХРОНИЗАЦИЯ',`
    <p class="dialog-copy">${escape(state.cloud.status)}</p><p class="form-message" id="sync-message" role="status"></p>
    <div class="dialog-actions"><button class="button" type="button" id="sync-disconnect">Отключить на этом устройстве</button>${importButton}</div>`)
  $('sync-disconnect').onclick = () => {
    if (mutating) return
    connectionAttempt += 1
    rememberSync(null)
    state.cloud = null
    refreshLocalSchedule()
    updateAccessUI()
    renderCalendar()
    renderTheater()
    dialog.close()
  }
  const button = $('sync-import')
  if (button) button.onclick = async () => {
    const message = $('sync-message')
    button.disabled = true
    try {
      const local = readLocalSchedule()
      await updatePlanner(data => {
        const ids = new Set(data.events.map(event => event.id))
        return {
          events:[...data.events, ...local.events.filter(event => !ids.has(event.id))],
          hiddenShows:[...new Set([...data.hiddenShows,...local.hiddenShows])],
          importantShows:[...new Set([...data.importantShows,...local.importantShows])],
        }
      })
      renderCalendar()
      renderTheater()
      if (button.isConnected && dialog.open) dialog.close()
      notify('Записи с этого устройства перенесены в общий календарь')
    } catch (error) {
      message.textContent = error.message
      button.disabled = false
    }
  }
}

async function shareDialog() {
  showDialog('Поделиться расписанием','КАЛЕНДАРЬ',`
    <p class="dialog-copy">Ссылка открывает копию личных событий на момент её создания. Расписание увидит любой, у кого есть ссылка.</p>
    <div id="share-controls" class="dialog-form">
      <label id="share-field" hidden>Ссылка для просмотра<input id="share-link" type="text" readonly></label>
      <p class="form-message" role="status">Готовим ссылку…</p>
      <div class="dialog-actions"><button id="copy-link" type="button" class="button primary" disabled>Скопировать ссылку</button></div>
    </div>`)
  const controls = $('share-controls')
  const message = controls.querySelector('.form-message')
  try {
    const fragment = await scheduleFragment(state.personal,today(),state.hiddenShows,state.importantShows)
    if (!controls.isConnected || !dialog.open) return
    const link = new URL(location.pathname, location.origin)
    link.hash = fragment
    const input = $('share-link')
    input.value = link.href
    $('share-field').hidden = false
    const button = $('copy-link')
    button.disabled = false
    message.textContent = ''
    button.onclick = async () => {
      try {
        await navigator.clipboard.writeText(input.value)
        message.textContent = 'Ссылка скопирована.'
      } catch {
        input.focus()
        input.select()
        message.textContent = 'Скопируй выделенную ссылку.'
      }
    }
  } catch (error) {
    message.textContent = error.message
  }
}

async function applySharedLink() {
  const fragment = location.hash
  let snapshot = null
  if (fragment.startsWith('#schedule=')) {
    try {
      snapshot = await scheduleFromFragment(fragment)
    } catch {
      if (fragment === location.hash) notify('Не удалось открыть ссылку на расписание.')
    }
  }
  if (fragment !== location.hash) return
  const wasShared = state.shared
  state.shared = snapshot
  $('shared-banner').hidden = !snapshot
  $('share-button').hidden = Boolean(snapshot)
  updateAccessUI()
  $('chat-log').innerHTML = initialChat
  $('chat-greeting').textContent = snapshot
    ? 'Спроси о съёмках, спектаклях или свободных днях в этом расписании.'
    : 'Привет! Напиши, что у тебя запланировано, или спроси о расписании.'
  if (snapshot) {
    state.date = dateOf(snapshot.date)
    $('shared-date').textContent = 'Копия от ' + dateLabel(state.date) + ' · только просмотр'
    const relevant = snapshot.events.find(event => event.date >= snapshot.date) || snapshot.events.at(-1)
    if (relevant) state.date = dateOf(relevant.date)
  } else if (wasShared) {
    state.date = today()
  }
  renderCalendar()
  renderTheater()
}

function editor(event = null) {
  if (isReadOnly()) return
  const options = Object.entries(categories).map(([key,value]) => `<option value="${key}" ${(event?.type || 'personal') === key ? 'selected' : ''}>${value.label}</option>`).join('')
  showDialog(event ? 'Редактировать событие' : 'Новое событие','КАЛЕНДАРЬ',`
    <form class="dialog-form" id="event-form">
      <label>Название<input name="title" required maxlength="250" placeholder="Например, репетиция" value="${escape(event?.title || '')}"></label>
      <div class="fields"><label>Дата<input name="date" type="date" min="1900-01-01" max="2199-12-31" required value="${event?.date || stamp(state.date)}"></label><label>Категория<select name="type">${options}</select></label></div>
      <div class="fields"><label>Начало<input name="time" type="time" value="${event?.time || ''}"></label><label>Окончание<input name="endTime" type="time" value="${event?.endTime || ''}"></label></div>
      <label class="important-control"><input name="important" type="checkbox" ${event?.important ? 'checked' : ''}><span>Важное событие</span></label>
      <p class="form-message" role="status"></p>
      <div class="dialog-actions">${event ? '<button type="button" class="button" id="remove-event">Удалить событие</button>' : ''}<button class="button primary" type="submit">Сохранить</button></div>
    </form>`)
  const form = $('event-form')
  const save = async remove => {
    if (mutating) return
    const fields = new FormData(form)
    const message = form.querySelector('.form-message')
    const title = fields.get('title').trim()
    if (!remove && !title) {
      message.textContent = 'Введи название события.'
      return
    }
    const record = {id:event?.id || crypto.randomUUID(),title,date:fields.get('date'),time:fields.get('time'),endTime:fields.get('endTime'),type:fields.get('type'),important:fields.has('important')}
    if (!remove && record.endTime && (!record.time || record.endTime <= record.time)) {
      message.textContent = 'Укажи начало и окончание позже начала в пределах одного дня.'
      return
    }
    const buttons = [...form.querySelectorAll('button')]
    buttons.forEach(button => { button.disabled = true })
    try {
      await changeEvent(record,remove)
      if (form.isConnected && dialog.open) dialog.close()
      if (remove) renderCalendar()
      else {
        reveal(record.type)
        jump(record.date)
      }
      notify(remove ? 'Событие удалено' : 'Событие сохранено')
    } catch (error) {
      message.textContent = error.message || 'Не удалось сохранить событие.'
    } finally {
      buttons.forEach(button => { button.disabled = false })
    }
  }
  form.onsubmit = submit => { submit.preventDefault(); void save(false) }
  const remove = $('remove-event')
  if (remove) remove.onclick = () => {
    if (remove.dataset.confirmed === 'yes') void save(true)
    else {
      remove.dataset.confirmed = 'yes'
      remove.textContent = 'Подтвердить удаление'
    }
  }
}

function theaterDialog() {
  const upcoming = visibleShows().filter(event => event.date >= stamp(today()))
  const hidden = isReadOnly() ? [] : state.feed.events.filter(event => state.hiddenShows.includes(event.id))
  const hiddenList = hidden.length
    ? `<details class="hidden-shows"><summary>Скрытые показы · ${hidden.length}</summary>${hidden.map(event => eventRow(event,true)).join('')}</details>`
    : ''
  showDialog('Афиша театра','НОВОШАХТИНСКИЙ ДРАМАТИЧЕСКИЙ ТЕАТР',`<p class="dialog-copy">${escape(feedStatus())}</p>${hiddenList}${upcoming.length ? upcoming.map(event => eventRow(event,true)).join('') : '<p class="empty">Нет ближайших показов.</p>'}<div class="dialog-actions"><a href="${theaterUrl}" target="_blank" rel="noopener noreferrer">Сайт театра ↗</a></div>`)
}

function openEvent(id) {
  const personal = (state.shared?.events ?? state.personal).find(event => event.id === id)
  if (personal) {
    if (!isReadOnly()) return editor(personal)
    showDialog(personal.title,categories[personal.type].label.toLocaleUpperCase('ru-RU'),`<p class="dialog-copy">${dateLabel(dateOf(personal.date))}${personal.time ? ' · ' + eventTime(personal) + ' (МСК)' : ''}</p><div class="dialog-actions"><button class="button" type="button" data-jump="${personal.date}">К дате</button></div>`)
    return
  }
  const show = state.feed.events.find(event => event.id === id)
  if (!show) return
  const hidden = state.hiddenShows.includes(id)
  const important = state.importantShows.includes(id)
  const actions = isReadOnly() ? '' : `
    <button class="button" id="show-important" type="button">${important ? 'Снять отметку «Важное»' : 'Отметить важным'}</button>
    <button class="button" id="show-visibility" type="button">${hidden ? 'Вернуть в календарь' : 'Убрать из календаря'}</button>`
  showDialog(show.title,'ИЗ АФИШИ ТЕАТРА',`<p class="dialog-copy">${dayLabel(dateOf(show.date))} · ${escape(show.time)} (МСК)</p><p id="show-message" class="form-message" role="status"></p><div class="dialog-actions">${actions}<button class="button" type="button" data-jump="${show.date}">К дате</button><a class="button primary" href="${escape(show.url)}" target="_blank" rel="noopener noreferrer">На сайте театра ↗</a></div>`)
  const bind = (button, key, enabled, confirmation) => {
    if (!button) return
    const message = $('show-message')
    button.onclick = async () => {
      button.disabled = true
      try {
        await setShowFlag(key,id,enabled)
        if (button.isConnected && dialog.open) dialog.close()
        notify(confirmation)
      } catch (error) {
        message.textContent = error.message
        button.disabled = false
      }
    }
  }
  bind($('show-visibility'),'hiddenShows',!hidden,hidden ? 'Показ возвращён в календарь' : 'Показ убран из календаря')
  bind($('show-important'),'importantShows',!important,important ? 'Отметка снята' : 'Показ отмечен как важный')
}

function chatMessage(who, text, date = null) {
  const log = $('chat-log')
  const row = document.createElement('div')
  row.className = 'chat-message ' + who
  row.innerHTML = (who === 'bot' ? '<span class="message-label">АНТРАКТ</span>' : '') + '<p>' + escape(text) + '</p>'
  if (date) {
    const link = document.createElement('button')
    link.type = 'button'
    link.className = 'text-button'
    link.textContent = 'Показать в календаре'
    link.dataset.jump = date
    row.append(link)
  }
  log.append(row)
  while (log.children.length > 41) log.children[1].remove()
  log.scrollTop = log.scrollHeight
  return row
}

async function saveChatEvent({event, events:batch, reply, date}) {
  const candidates = (batch || [event]).map(item => ({...item,id:crypto.randomUUID()}))
  let added = []
  await updateSchedule(events => {
    added = candidates.filter(candidate => !events.some(item => item.date === candidate.date && eventTime(item) === eventTime(candidate) && item.title.toLowerCase() === candidate.title.toLowerCase()))
    return [...events,...added]
  })
  if (!added.length) {
    chatMessage('bot',batch ? 'Эти события уже есть в календаре.' : 'Такое событие уже есть в календаре.',date)
    return
  }
  reveal(added[0].type)
  state.date = dateOf(added[0].date)
  if (state.view === 'year') state.view = 'month'
  renderCalendar()
  const message = batch && added.length !== batch.length
    ? 'Добавлено на ' + added.map(item => dateLabel(dateOf(item.date))).join(', ') + '. Остальные записи уже есть в календаре.'
    : batch ? 'Добавлено ' + countLabel(added.length) + '. ' + reply : reply
  chatMessage('bot',message,added[0].date)
}

function confirmChatEvent(result) {
  const {event} = result
  const date = dateOf(event.date)
  const row = chatMessage('bot','Сохранить «' + event.title + '» на ' + dateLabel(date) + ', ' + eventTime(event) + '?')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'text-button'
  button.textContent = 'Сохранить на ' + shortLabel(date)
  row.append(button)
  $('chat-log').scrollTop = $('chat-log').scrollHeight
  button.onclick = async () => {
    button.disabled = true
    try {
      await saveChatEvent(result)
      button.remove()
    } catch (error) {
      chatMessage('bot',error.message || 'Не удалось сохранить событие.')
      button.disabled = false
    }
  }
}

async function send(text) {
  const submit = $('chat-form').querySelector('[type=submit]')
  if (submit.disabled) return
  $('message').value = ''
  chatMessage('user',text)
  submit.disabled = true
  try {
    if (!state.shared && !state.cloud) applySchedule(readLocalSchedule())
    const result = interpret(text,calendarEvents(),today(),state.feed,state.date)
    if (result.event || result.events) {
      if (isReadOnly()) {
        chatMessage('bot','Это копия для просмотра. Чтобы добавить событие, открой свой календарь.')
      } else if (result.confirm) confirmChatEvent(result)
      else await saveChatEvent(result)
      return
    }
    renderCalendar()
    chatMessage('bot',result.reply,result.date)
  } catch (error) {
    chatMessage('bot',error.message || 'Попробуй ещё раз.')
    $('message').value = text
  } finally {
    submit.disabled = false
  }
}

$('chat-form').addEventListener('submit', event => {
  event.preventDefault()
  const text = $('message').value.trim()
  if (text) void send(text)
})
$('share-button').onclick = () => void shareDialog()
$('sync-settings').onclick = syncSettings
$('my-calendar').onclick = () => {
  history.replaceState(null,'',location.pathname + location.search)
  void applySharedLink()
  setPanel('calendar')
  $('share-button').focus()
}
$('add-event').onclick = () => editor()
$('prev').onclick = () => shift(-1)
$('next').onclick = () => shift(1)
$('period').onclick = picker

document.addEventListener('click', event => {
  const button = event.target.closest('button')
  if (!button) return
  const {panel,view,filter,day,month,prompt,event:id,jump:date} = button.dataset
  if (button.hasAttribute('data-close')) dialog.close()
  if (panel === 'theater') theaterDialog()
  else if (panel) setPanel(panel)
  if (view) {
    state.view = view
    renderCalendar()
  }
  if (filter) {
    state.filter = filter
    renderCalendar()
  }
  if (day) {
    state.date = dateOf(day)
    renderCalendar(true)
  }
  if (month !== undefined) {
    state.date = new Date(state.date.getFullYear(),+month,1,12)
    state.view = 'month'
    renderCalendar()
    $('period').focus()
  }
  if (button.hasAttribute('data-today')) jump(stamp(today()))
  if (id) openEvent(id)
  if (date) {
    if (dialog.open) dialog.close()
    state.filter = 'all'
    jump(date)
  }
  if (prompt) {
    $('message').value = prompt
    $('message').focus()
  }
})

const now = today()
$('today-number').textContent = pad(now.getDate())
$('today-month').textContent = months[now.getMonth()].toLocaleLowerCase('ru-RU')
if (syncEnabled) {
  const connection = syncConnection()
  if (connection) state.cloud = {connection,revision:-1,canEdit:false,status:'Подключаем общий календарь…'}
  setInterval(() => void refreshCloud(),15000)
  document.addEventListener('visibilitychange',() => void refreshCloud())
}
refreshLocalSchedule()
await applyLocation()
void refreshCloud()
window.addEventListener('hashchange', () => void applyLocation())
void loadFeed()
