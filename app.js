import {
  addDays, categories, countLabel, dateLabel, dateOf, dayLabel, firstOfMonth,
  interpret, monthDays, months, moveMonth, pad, shortLabel, sortEvents, stamp, today, weekLabels, weekStart,
} from './planner.js'
import {cloudEnabled, openAccount} from './accounts.js'

const $ = id => document.getElementById(id)
const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>'
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const theaterUrl = 'https://nmdt.ru/afisha/events/'
const dialog = $('modal')
const initialChat = $('chat-log').innerHTML
const state = {date:today(), view:'month', panel:'calendar', account:null, personal:[], feed:{months:[],events:[],stale:false}, feedLoading:true}
let toastTimer
let previousFocus
let mutating = false
let eventsRevision = 0

function byDay() {
  const map = new Map()
  for (const event of sortEvents([...state.personal, ...state.feed.events])) {
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
  $('agenda-heading').textContent = selected === current ? 'Сегодня, ' + shortLabel(date) : dayLabel(date)
  const agenda = map.get(selected) || []
  $('agenda-count').textContent = countLabel(agenda.length)
  $('agenda-list').innerHTML = agenda.length ? agenda.map(event => eventRow(event)).join('') : '<p class="empty">На этот день пока нет событий.</p>'
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

function updateAccountButton() {
  $('account-button').querySelector('span').textContent = state.account?.login || 'Войти'
  $('account-button').setAttribute('aria-label', state.account ? 'Аккаунт ' + state.account.login : 'Войти')
}

function accountDialog(create = false, after = null, notice = '') {
  if (state.account) {
    showDialog(state.account.login,'МОЙ АККАУНТ',`<p class="dialog-copy">${cloudEnabled ? 'События синхронизируются через облако.' : 'События зашифрованы и хранятся в этом браузере.'}</p><div class="dialog-actions"><button class="button" type="button" id="sign-out">Выйти из аккаунта</button></div>`)
    $('sign-out').onclick = () => {
      if (mutating) return
      const account = state.account
      state.account = null
      state.personal = []
      $('chat-log').innerHTML = initialChat
      $('message').value = ''
      updateAccountButton()
      renderCalendar()
      dialog.close()
      account.signOut().catch(() => {})
      notify('Вы вышли из аккаунта')
    }
    return
  }
  const mode = cloudEnabled ? 'События сохраняются в аккаунте и доступны с разных устройств.' : 'Локальный аккаунт. События зашифрованы и хранятся в этом браузере.'
  showDialog(create ? 'Создать аккаунт' : 'Войти в планер','ЛИЧНОЕ РАСПИСАНИЕ',`
    <p class="dialog-copy">${create ? 'Выбери логин и пароль, чтобы сохранять свои события.' : 'Войди, чтобы сохранять события и спрашивать о личных планах.'}</p>
    <form class="dialog-form" id="auth-form">
      <label>${cloudEnabled ? 'Email (логин)' : 'Логин'}<input name="login" type="${cloudEnabled ? 'email' : 'text'}" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="${cloudEnabled ? 254 : 64}" required></label>
      <label>Пароль<input name="password" type="password" autocomplete="${create ? 'new-password' : 'current-password'}" minlength="${create ? 8 : 1}" maxlength="128" ${create ? 'placeholder="От 8 символов"' : ''} required></label>
      <p class="form-message" role="status">${escape(notice)}</p>
      <div class="dialog-actions"><button class="text-button" id="switch-auth" type="button">${create ? 'Уже есть аккаунт' : 'Создать аккаунт'}</button><button class="button primary" type="submit">${create ? 'Зарегистрироваться' : 'Войти'}</button></div>
    </form><p class="account-note">${icon('lock')}${mode}</p>`)
  $('switch-auth').onclick = () => accountDialog(!create,after)
  $('auth-form').onsubmit = async event => {
    event.preventDefault()
    const form = event.target
    const button = form.querySelector('[type=submit]')
    const fields = new FormData(form)
    const message = form.querySelector('.form-message')
    if (button.disabled) return
    button.disabled = true
    $('switch-auth').disabled = true
    message.textContent = create ? 'Создаём аккаунт…' : 'Открываем расписание…'
    try {
      const account = await openAccount(fields.get('login'), fields.get('password'), create)
      if (!dialog.open || !form.isConnected) return
      if (account.confirmation) {
        accountDialog(false,after,'Проверь почту и подтверди адрес, затем войди.')
        return
      }
      const events = await account.load()
      if (!dialog.open || !form.isConnected) return
      state.account = account
      state.personal = events
      updateAccountButton()
      renderCalendar()
      dialog.close()
      notify(create ? 'Аккаунт создан' : 'Вы вошли в планер')
      after?.()
    } catch (error) {
      message.textContent = error.message
    } finally {
      button.disabled = false
      const toggle = form.querySelector('#switch-auth')
      if (toggle) toggle.disabled = false
    }
  }
}

async function changeEvent(event, remove = false) {
  if (!state.account || mutating) throw new Error('Дождись окончания сохранения и попробуй ещё раз.')
  const account = state.account
  mutating = true
  eventsRevision += 1
  try {
    if (remove) await account.remove(event.id)
    else await account.save(event)
    state.personal = state.personal.filter(item => item.id !== event.id)
    if (!remove) state.personal.push(event)
  } finally {
    mutating = false
  }
}

async function refreshEvents(account) {
  if (mutating) return
  const revision = eventsRevision
  const events = await account.load()
  if (state.account === account && revision === eventsRevision && !mutating) state.personal = events
}

window.addEventListener('focus', async () => {
  if (!state.account || dialog.open || document.activeElement === $('message')) return
  try {
    await refreshEvents(state.account)
    renderCalendar()
  } catch {
    notify('Не удалось обновить расписание')
  }
})

function editor(event = null) {
  if (!state.account) return accountDialog(false,() => editor(event))
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
      else jump(record.date)
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
  const personal = state.personal.find(event => event.id === id)
  if (personal) return editor(personal)
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
  if (!state.account) return accountDialog(false,() => { $('message').value = text; void send(text) })
  $('message').value = ''
  chatMessage('user',text)
  submit.disabled = true
  const account = state.account
  try {
    await refreshEvents(account)
    if (state.account !== account) return
    const result = interpret(text,[...state.personal,...state.feed.events],today(),state.feed)
    if (result.event) {
      const exists = state.personal.some(item => item.date === result.event.date && item.time === result.event.time && item.title.toLowerCase() === result.event.title.toLowerCase())
      if (exists) {
        chatMessage('bot','Такое событие уже есть в календаре.',result.date)
        return
      }
      await changeEvent({...result.event,id:crypto.randomUUID()})
      state.date = dateOf(result.date)
      if (state.view === 'year') state.view = 'month'
    }
    renderCalendar()
    chatMessage('bot',result.reply,result.date)
  } catch (error) {
    if (state.account !== account) return
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
$('account-button').onclick = () => accountDialog()
$('add-event').onclick = () => editor()
$('prev').onclick = () => shift(-1)
$('next').onclick = () => shift(1)
$('period').onclick = picker

document.addEventListener('click', event => {
  const button = event.target.closest('button')
  if (!button) return
  const {panel,view,day,month,prompt,event:id,jump:date} = button.dataset
  if (button.hasAttribute('data-close')) dialog.close()
  if (panel === 'theater') theaterDialog()
  else if (panel) setPanel(panel)
  if (view) {
    state.view = view
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
  if (cloudEnabled) accountDialog(false,null,'Войди после подтверждения адреса электронной почты.')
}
renderCalendar()
void loadFeed()
