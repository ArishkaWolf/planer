import {
  addDays, categories, countLabel, dateLabel, dateOf, dayLabel, firstOfMonth,
  interpret, isCalendarEvent, monthDays, months, moveMonth, pad, scheduleFragment, scheduleFromFragment,
  shortLabel, sortEvents, stamp, today, weekLabels, weekStart,
} from './planner.js'

const $ = id => document.getElementById(id)
const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>'
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const theaterUrl = 'https://nmdt.ru/afisha/events/'
const scheduleKey = 'antrakt:calendar:v2'
const legacyPrefix = 'antrakt:v1:'
const dialog = $('modal')
const initialChat = $('chat-log').innerHTML
const state = {date:today(), view:'month', panel:'calendar', filter:'all', personal:[], shared:null, feed:{months:[],events:[],stale:false}, feedLoading:true}
let toastTimer
let previousFocus
let mutating = false

function calendarEvents() {
  return [...(state.shared?.events ?? state.personal), ...state.feed.events]
}

function byDay() {
  const map = new Map()
  for (const event of sortEvents(calendarEvents())) {
    if (state.filter !== 'all' && event.type !== state.filter) continue
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

function eventRow(event, withDate = false) {
  const type = categories[event.type] || categories.personal
  const detail = [withDate ? shortLabel(dateOf(event.date)) : '', event.time || 'Без времени', event.source ? 'Афиша театра' : type.label].filter(Boolean).join(' · ')
  return `<button class="event-row" type="button" data-event="${escape(event.id)}"><span class="event-icon ${event.type}">${icon(type.icon)}</span><span class="event-text"><strong>${escape(event.title)}</strong><small>${escape(detail)}</small></span>${icon('right')}</button>`
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
    contents = `<div class="day-banner"><strong>${pad(date.getDate())}</strong><span>${dayLabel(date)}</span></div>`
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
      const flags = [outside ? 'outside' : '', key === current ? 'current' : '', key === selected ? 'selected' : ''].join(' ')
      const dots = [...new Set(events.map(event => event.type))].map(type => `<i class="dot ${type}"></i>`).join('')
      const firstEvent = events[0]
      const preview = firstEvent ? `<span class="cell-preview ${firstEvent.type}">${escape((firstEvent.time ? firstEvent.time + ' ' : '') + firstEvent.title)}${events.length > 1 ? ' +' + (events.length - 1) : ''}</span>` : ''
      return `<button type="button" class="calendar-cell ${flags}" data-day="${key}" aria-pressed="${key === selected}" ${key === current ? 'aria-current="date"' : ''} aria-label="${dayLabel(day)}, ${countLabel(events.length)}"><span class="cell-number">${day.getDate()}</span><span class="cell-dots" aria-hidden="true">${dots}</span>${preview}</button>`
    })
    contents = '<div class="weekday-grid" aria-hidden="true">' + weekLabels.map(day => '<span>' + day + '</span>').join('') + '</div><div class="calendar-grid">' + cells.join('') + '</div>'
  }

  $('period-label').textContent = label
  $('calendar-content').innerHTML = contents
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === state.view)))
  document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === state.filter)))
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
  const upcoming = state.feed.events.find(event => event.date >= stamp(today()))
  $('theater-next').innerHTML = upcoming ? eventRow(upcoming,true) : '<p class="empty">Ближайшие показы пока не опубликованы.</p>'
}

async function loadFeed() {
  try {
    const response = await fetch('./afisha.json', {cache:'no-cache', signal:AbortSignal.timeout(12000)})
    if (!response.ok) throw new Error()
    const data = await response.json()
    const events = data.events.filter(event => datePattern.test(event.date) && typeof event.title === 'string' && /^https:\/\/nmdt\.ru\/performance\/\d+\/?$/.test(event.url)).map(event => ({...event,type:'show',source:'theater'}))
    const stale = data.stale === true || Date.now() - new Date(data.updatedAt).getTime() > 36 * 60 * 60 * 1000
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
  const events = JSON.parse(localStorage.getItem(scheduleKey) ?? '[]')
  if (!Array.isArray(events) || !events.every(isCalendarEvent)) throw new Error('Не удалось прочитать события в этом браузере.')
  return events
}

function refreshLocalSchedule() {
  try {
    state.personal = readLocalSchedule()
  } catch {
    notify('Не удалось прочитать события в этом браузере.')
  }
}

async function updateSchedule(change) {
  if (state.shared) throw new Error('Расписание по ссылке доступно для просмотра.')
  if (mutating) throw new Error('Дождись окончания сохранения и попробуй ещё раз.')
  mutating = true
  const save = () => {
    const updated = change(readLocalSchedule())
    localStorage.setItem(scheduleKey, JSON.stringify(updated))
    state.personal = updated
  }
  try {
    if (navigator.locks) await navigator.locks.request(scheduleKey, save)
    else save()
  } finally {
    mutating = false
  }
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

window.addEventListener('storage', event => {
  if (event.key !== scheduleKey && event.key !== null) return
  refreshLocalSchedule()
  if (!state.shared) renderCalendar()
})

function hasLegacySchedule() {
  try {
    return Object.keys(localStorage).some(key => key.startsWith(legacyPrefix))
  } catch {
    return false
  }
}

async function shareDialog() {
  const legacy = hasLegacySchedule() ? '<button class="text-button" id="restore-legacy" type="button">Перенести старые записи</button>' : ''
  showDialog('Поделиться расписанием','КАЛЕНДАРЬ',`
    <p class="dialog-copy">Ссылка открывает копию личных событий на момент её создания. Расписание увидит любой, у кого есть ссылка.</p>
    <div id="share-controls" class="dialog-form">
      <label id="share-field" hidden>Ссылка для просмотра<input id="share-link" type="text" readonly></label>
      <p class="form-message" role="status">Готовим ссылку…</p>
      <div class="dialog-actions">${legacy}<button id="copy-link" type="button" class="button primary" disabled>Скопировать ссылку</button></div>
    </div>`)
  const controls = $('share-controls')
  const message = controls.querySelector('.form-message')
  const restore = $('restore-legacy')
  if (restore) restore.onclick = restoreLegacy
  try {
    const fragment = await scheduleFragment(readLocalSchedule())
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

function restoreLegacy() {
  showDialog('Перенести старые записи','КАЛЕНДАРЬ',`
    <p class="dialog-copy">Введи прежние логин и пароль, чтобы открыть сохранённые в этом браузере записи. Вход для дальнейшей работы не понадобится.</p>
    <form class="dialog-form" id="restore-form">
      <label>Прежний логин<input name="login" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required></label>
      <label>Прежний пароль<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label>
      <p class="form-message" role="status"></p>
      <div class="dialog-actions"><button class="button primary" type="submit">Перенести записи</button></div>
    </form>`)
  $('restore-form').onsubmit = async event => {
    event.preventDefault()
    const form = event.target
    const fields = new FormData(form)
    const button = form.querySelector('[type=submit]')
    const message = form.querySelector('.form-message')
    button.disabled = true
    try {
      const {readLegacyEvents} = await import('./accounts.js')
      const saved = await readLegacyEvents(fields.get('login'),fields.get('password'))
      if (!form.isConnected || !dialog.open) return
      const restored = saved.filter(isCalendarEvent)
      let added = 0
      await updateSchedule(events => {
        const known = new Set(events.map(event => event.id))
        const newEvents = restored.filter(event => !known.has(event.id))
        added = newEvents.length
        return [...events, ...newEvents]
      })
      dialog.close()
      renderCalendar()
      notify(added ? 'Записи перенесены: ' + added : 'Новых записей для переноса нет.')
    } catch (error) {
      message.textContent = error.message
    } finally {
      button.disabled = false
    }
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
  $('add-event').hidden = Boolean(snapshot)
  $('chat-log').innerHTML = initialChat
  $('chat-greeting').textContent = snapshot
    ? 'Спроси о съёмках, спектаклях или свободных днях в этом расписании.'
    : 'Привет! Напиши, что у тебя запланировано, или спроси о расписании.'
  document.querySelector('[data-prompt="Съёмка 10 ноября"]').hidden = Boolean(snapshot)
  if (snapshot) {
    state.date = dateOf(snapshot.date)
    $('shared-date').textContent = 'Копия от ' + dateLabel(state.date) + ' · только просмотр'
    const relevant = snapshot.events.find(event => event.date >= snapshot.date) || snapshot.events.at(-1)
    if (relevant) state.date = dateOf(relevant.date)
  } else if (wasShared) {
    state.date = today()
  }
  renderCalendar()
}

function editor(event = null) {
  if (state.shared) return
  const options = Object.entries(categories).map(([key,value]) => `<option value="${key}" ${(event?.type || 'personal') === key ? 'selected' : ''}>${value.label}</option>`).join('')
  showDialog(event ? 'Редактировать событие' : 'Новое событие','КАЛЕНДАРЬ',`
    <form class="dialog-form" id="event-form">
      <label>Название<input name="title" required maxlength="250" placeholder="Например, репетиция" value="${escape(event?.title || '')}"></label>
      <div class="fields"><label>Дата<input name="date" type="date" min="1900-01-01" max="2199-12-31" required value="${event?.date || stamp(state.date)}"></label><label>Время<input name="time" type="time" value="${event?.time || ''}"></label></div>
      <label>Категория<select name="type">${options}</select></label><p class="form-message" role="status"></p>
      <div class="dialog-actions">${event ? '<button type="button" class="button" id="remove-event">Удалить</button>' : ''}<button class="button primary" type="submit">Сохранить</button></div>
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
    const record = {id:event?.id || crypto.randomUUID(),title,date:fields.get('date'),time:fields.get('time'),type:fields.get('type')}
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
  const upcoming = state.feed.events.filter(event => event.date >= stamp(today()))
  showDialog('Афиша театра','НОВОШАХТИНСКИЙ ДРАМАТИЧЕСКИЙ ТЕАТР',`<p class="dialog-copy">${escape(feedStatus())}</p>${upcoming.length ? upcoming.map(event => eventRow(event,true)).join('') : '<p class="empty">Ближайшие показы пока не опубликованы.</p>'}<div class="dialog-actions"><a href="${theaterUrl}" target="_blank" rel="noopener noreferrer">Сайт театра ↗</a></div>`)
}

function openEvent(id) {
  const personal = (state.shared?.events ?? state.personal).find(event => event.id === id)
  if (personal) {
    if (!state.shared) return editor(personal)
    showDialog(personal.title,categories[personal.type].label.toLocaleUpperCase('ru-RU'),`<p class="dialog-copy">${dateLabel(dateOf(personal.date))}${personal.time ? ' · ' + personal.time + ' (МСК)' : ''}</p><div class="dialog-actions"><button class="button" type="button" data-jump="${personal.date}">К дате</button></div>`)
    return
  }
  const show = state.feed.events.find(event => event.id === id)
  if (!show) return
  showDialog(show.title,'ИЗ АФИШИ ТЕАТРА',`<p class="dialog-copy">${dayLabel(dateOf(show.date))} · ${escape(show.time)} (МСК)</p><div class="dialog-actions"><button class="button" type="button" data-jump="${show.date}">К дате</button><a class="button primary" href="${escape(show.url)}" target="_blank" rel="noopener noreferrer">На сайте театра ↗</a></div>`)
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
}

async function send(text) {
  const submit = $('chat-form').querySelector('[type=submit]')
  if (submit.disabled) return
  $('message').value = ''
  chatMessage('user',text)
  submit.disabled = true
  try {
    if (!state.shared) state.personal = readLocalSchedule()
    const result = interpret(text,calendarEvents(),today(),state.feed)
    if (result.event) {
      if (state.shared) {
        chatMessage('bot','Это копия для просмотра. Чтобы добавить событие, открой свой календарь.')
        return
      }
      const exists = state.personal.some(item => item.date === result.event.date && item.time === result.event.time && item.title.toLowerCase() === result.event.title.toLowerCase())
      if (exists) {
        chatMessage('bot','Такое событие уже есть в календаре.',result.date)
        return
      }
      await changeEvent({...result.event,id:crypto.randomUUID()})
      reveal(result.event.type)
      state.date = dateOf(result.date)
      if (state.view === 'year') state.view = 'month'
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
if (/(?:^|[&#])(?:access_token|error_code)=/.test(location.hash)) {
  history.replaceState(null,'',location.pathname + location.search)
}
refreshLocalSchedule()
await applySharedLink()
window.addEventListener('hashchange', () => void applySharedLink())
void loadFeed()
