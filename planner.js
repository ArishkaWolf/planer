export const categories = {
  filming: {label: 'Съёмка', icon: 'film'},
  rehearsal: {label: 'Репетиция', icon: 'clock'},
  show: {label: 'Спектакль', icon: 'ticket'},
  personal: {label: 'Личное', icon: 'calendar'},
}

export const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const monthCases = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
const monthWord = monthCases.concat(months.map(month => month.toLowerCase())).join('|')
export const weekLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const fullDay = new Intl.DateTimeFormat('ru-RU', {weekday:'long', day:'numeric', month:'long'})
const shortDay = new Intl.DateTimeFormat('ru-RU', {day:'numeric', month:'short'})
const longDate = new Intl.DateTimeFormat('ru-RU', {day:'numeric', month:'long', year:'numeric'})
const dateParts = new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Moscow', year:'numeric', month:'2-digit', day:'2-digit'})

export const pad = value => String(value).padStart(2, '0')
export const stamp = date => [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-')
export const dateOf = value => new Date(value + 'T12:00:00')
export const today = () => dateOf(dateParts.format(new Date()))
export const capitalize = value => value.charAt(0).toLocaleUpperCase('ru-RU') + value.slice(1)
export const dayLabel = date => capitalize(fullDay.format(date))
export const shortLabel = date => shortDay.format(date)
export const dateLabel = date => longDate.format(date).replace(/\s*г\.$/, '')
export const addDays = (date, count) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + count, 12)
export const weekStart = date => addDays(date, -((date.getDay() + 6) % 7))
export const firstOfMonth = date => new Date(date.getFullYear(), date.getMonth(), 1, 12)
export const monthDays = date => new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
export const moveMonth = (date, amount) => {
  const target = new Date(date.getFullYear(), date.getMonth() + amount, 1, 12)
  target.setDate(Math.min(date.getDate(), monthDays(target)))
  return target
}
export const sortEvents = events => [...events].sort((a, b) => (a.date + (a.time || '00:00')).localeCompare(b.date + (b.time || '00:00')) || a.title.localeCompare(b.title, 'ru'))
export const countLabel = count => count + ' ' + ({one:'событие', few:'события', many:'событий'}[new Intl.PluralRules('ru').select(count)] || 'события')

const maxLinkLength = 60_000
const maxSnapshotBytes = 1_000_000
const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const theaterId = /^theater-[a-z0-9-]{1,80}$/

export const isCalendarDate = value => typeof value === 'string'
  && /^(?:19|20|21)\d{2}-\d{2}-\d{2}$/.test(value) && stamp(dateOf(value)) === value

export const eventTime = ({time, endTime}) => endTime ? time + '–' + endTime : time
export const isTheaterId = id => typeof id === 'string' && theaterId.test(id)

export function isCalendarEvent(event) {
  return event && typeof event.id === 'string' && typeof event.title === 'string'
    && event.title.trim().length > 0 && event.title.length <= 250
    && isCalendarDate(event.date) && typeof event.time === 'string'
    && (event.time === '' || clockPattern.test(event.time))
    && (event.endTime === undefined || event.endTime === '' ||
      (typeof event.endTime === 'string' && event.time && clockPattern.test(event.endTime) && event.endTime > event.time))
    && (event.important === undefined || typeof event.important === 'boolean')
    && typeof event.type === 'string' && Object.hasOwn(categories, event.type)
}

export async function scheduleFragment(events, date = today(), hiddenShows = [], importantShows = []) {
  const rows = sortEvents(events).map(({title, date, time, type, endTime, important}) => {
    const row = [title, date, time, type]
    if (endTime || important) row.push(endTime || '')
    if (important) row.push(true)
    return row
  })
  const bytes = new TextEncoder().encode(JSON.stringify([stamp(date), rows, hiddenShows, importantShows]))
  if (bytes.length > maxSnapshotBytes) throw new Error('Для одной ссылки событий слишком много.')
  const compressed = typeof CompressionStream === 'function'
  const data = compressed
    ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
    : bytes
  if (data.length > maxLinkLength * 0.75) throw new Error('Для одной ссылки событий слишком много.')
  const text = btoa(Array.from(data, byte => String.fromCharCode(byte)).join(''))
    .replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,'')
  return '#schedule=' + (compressed ? 'gz' : 'v1') + '.' + text
}

export async function scheduleFromFragment(fragment) {
  const match = /^#schedule=(gz|v1)\.([a-zA-Z0-9_-]+)$/.exec(fragment)
  if (!match || match[2].length > maxLinkLength) throw new Error('Не удалось открыть ссылку на расписание.')
  const data = Uint8Array.from(atob(match[2].replaceAll('-','+').replaceAll('_','/')), char => char.charCodeAt(0))
  let stream = new Blob([data]).stream()
  if (match[1] === 'gz') stream = stream.pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', {fatal:true})
  let size = 0
  let json = ''
  while (true) {
    const {value, done} = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxSnapshotBytes) {
      await reader.cancel()
      throw new Error('Ссылка на расписание слишком большая.')
    }
    json += decoder.decode(value, {stream:true})
  }
  const payload = JSON.parse(json + decoder.decode())
  if (!Array.isArray(payload) || !isCalendarDate(payload[0]) || !Array.isArray(payload[1])) throw new Error('Не удалось открыть ссылку на расписание.')
  const events = payload[1].map((row, index) => {
    if (!Array.isArray(row) || row.length < 4 || row.length > 6) throw new Error('В ссылке есть повреждённые события.')
    const [title, date, time, type, endTime, important] = row
    const event = {id:'shared-' + index, title, date, time, type, endTime, important}
    if (!isCalendarEvent(event)) throw new Error('В ссылке есть повреждённые события.')
    return event
  })
  const hiddenShows = payload[2] === undefined ? [] : payload[2]
  const importantShows = payload[3] === undefined ? [] : payload[3]
  if (![hiddenShows,importantShows].every(ids => Array.isArray(ids) && ids.every(isTheaterId))) throw new Error('В ссылке повреждён список показов.')
  return {date:payload[0], events, hiddenShows, importantShows}
}

function exactDate(year, month, day) {
  if (year < 1900 || year > 2199) return null
  const date = new Date(year, month - 1, day, 12)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null
}

function parseDate(text, base) {
  const relative = /(?<![а-я])(?:послезавтра|завтра|сегодня)(?![а-я])/u.exec(text)
  if (relative) return {date:addDays(base, {сегодня:0, завтра:1, послезавтра:2}[relative[0]]), match:relative}

  const iso = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/u.exec(text)
  if (iso) return {date:exactDate(+iso[1], +iso[2], +iso[3]), match:iso}

  const numeric = /(?<![\d.:])(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?(?![\d:])/u.exec(text)
  const named = new RegExp('(?<![\\d:])(\\d{1,2})\\s+(' + monthWord + ')(?![а-я])(?:\\s+(\\d{4})(?![\\d:]))?', 'u').exec(text)
  const match = named || numeric
  if (!match) return null

  const day = +match[1]
  const month = named ? (monthCases.indexOf(match[2]) + 1 || months.findIndex(value => value.toLowerCase() === match[2]) + 1) : +match[2]
  if (match[3]) {
    const year = +match[3] + (match[3].length === 2 ? 2000 : 0)
    return {date:exactDate(year, month, day), match}
  }
  if (month < 1 || month > 12 || day < 1 || day > new Date(2024, month, 0).getDate()) return {date:null, match}
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = exactDate(base.getFullYear() + offset, month, day)
    if (date && date >= base) return {date, match}
  }
  return {date:null, match}
}

export function categoryOf(text) {
  const phrase = text.toLowerCase().replaceAll('ё','е')
  if (/с[ъь]?ем|кинопроб|кастинг/u.test(phrase)) return 'filming'
  if (/репети|прогон/u.test(phrase)) return 'rehearsal'
  if (/спектакл|премьер|показ/u.test(phrase)) return 'show'
  return 'personal'
}

function questionRange(phrase, date, base) {
  if (date) return [stamp(date), stamp(date)]
  if (/следующ[а-я]* (недел|месяц)|будущей недел/u.test(phrase)) {
    if (/месяц/u.test(phrase)) {
      const first = firstOfMonth(moveMonth(base, 1))
      return [stamp(first), stamp(addDays(first, monthDays(first) - 1))]
    }
    const first = addDays(weekStart(base), 7)
    return [stamp(first), stamp(addDays(first, 6))]
  }
  if (/на (этой )?недел|на выходных/u.test(phrase)) {
    const first = weekStart(base)
    const start = /на выходных/u.test(phrase) ? addDays(first, 5) : base
    return [stamp(start < base ? base : start), stamp(addDays(first, 6))]
  }
  if (/в этом месяце/u.test(phrase)) return [stamp(base), stamp(addDays(firstOfMonth(base), monthDays(base) - 1))]
  return [stamp(base), null]
}

function parseTimeRange(text) {
  return /(?<![а-я\d])с\s+(\d{1,2})(?:[:.](\d{2}))?\s+(?:до|по)\s+(\d{1,2})(?:[:.](\d{2}))?(?![\d:.])/iu.exec(text)
    || /(?<![\d.])(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})(?![\d:.])/u.exec(text)
}

function parseDayList(text, base, selectedDate) {
  const list = /(?<![\d.:/\-])\d{1,2}(?:\s*(?:,\s*(?:и\s+)?|и\s+)\d{1,2})+(?![\d.:/\-])/u.exec(text)
  if (!list) return null
  const days = [...new Set(list[0].match(/\d+/g).map(Number))]
  const suffix = new RegExp('^\\s+(?:' + monthWord + ')(?![а-я])(?:\\s+\\d{4}(?![\\d:]))?', 'u').exec(text.slice(list.index + list[0].length))
  const monthDate = suffix ? parseDate(days.at(-1) + suffix[0], base)?.date : selectedDate
  const dates = monthDate ? days.map(day => exactDate(monthDate.getFullYear(),monthDate.getMonth() + 1,day)) : [null]
  return {dates, index:list.index, length:list[0].length + (suffix?.[0].length || 0)}
}

export function interpret(text, events, base = today(), feed = {months:[]}, selectedDate = base) {
  const phrase = text.toLowerCase().replaceAll('ё','е')
  const query = /^(?:а\s+)?(?:когда|что|какие|какой|есть ли|сколько|найди|покажи|будет ли|свобод[а-я]* ли|могу ли)(?![а-я])/u.test(phrase) || /\?$/.test(phrase)
  const range = query ? null : parseTimeRange(phrase)
  if (range && new RegExp('^\\s+(?:' + monthWord + ')(?![а-я])', 'u').test(phrase.slice(range.index + range[0].length))) {
    return {reply:'Укажи одну дату и время начала и окончания. Например, «Репетиция 18 ноября с 10 до 18».'}
  }
  const withoutRange = range ? text.slice(0, range.index) + ' '.repeat(range[0].length) + text.slice(range.index + range[0].length) : text
  const normalized = withoutRange.toLowerCase().replaceAll('ё','е')
  const batch = query ? null : parseDayList(normalized,base,selectedDate)
  if (batch?.dates.some(date => !date)) return {reply:'Проверь числа. Все даты в списке должны существовать в выбранном месяце.'}
  const parsed = batch ? null : parseDate(normalized, base)
  if (parsed && !parsed.date) return {reply:'Проверь дату. Например, можно написать «Съёмка 10 ноября» или «Репетиция 10.11.2026».'}
  const type = categoryOf(phrase)

  if (query) {
    const [from, to] = questionRange(phrase, parsed?.date, base)
    const matches = sortEvents(events.filter(event => event.date >= from && (!to || event.date <= to)))
    if (/выходн|свободн|без планов/u.test(phrase) && !/что .*на выходн/u.test(phrase)) {
      const used = new Set(matches.map(event => event.date))
      let day = dateOf(from)
      const limit = to || stamp(addDays(day, 365))
      while (stamp(day) <= limit && used.has(stamp(day))) day = addDays(day, 1)
      if (stamp(day) > limit) return {reply:'В этом периоде у тебя есть планы на каждый день.'}
      const known = feed.months.includes(stamp(day).slice(0, 7))
      const caveat = !known ? '\nНа этот месяц афиша пока не загружена.' : feed.stale ? '\nПо последней доступной версии афиши.' : ''
      return {reply:'В календаре свободно ' + dateLabel(day) + '.' + caveat, date:stamp(day)}
    }
    if (type === 'personal' && !/план|событи|расписани|дел|что у меня|что (?:сегодня|завтра|послезавтра|на выходных)|есть ли.*(?:сегодня|завтра)/u.test(phrase)) {
      return {reply:'Я могу подсказать даты съёмок, репетиций и спектаклей, показать планы на день или найти свободную дату.'}
    }
    const found = matches.filter(event => type === 'personal' || event.type === type)
    if (!found.length) {
      const missing = (type === 'show' || type === 'personal') && (!feed.months.includes(from.slice(0, 7)) || feed.stale)
      return {reply:'В календаре за этот период таких событий нет.' + (missing ? '\nАфиша за этот период может быть неполной.' : '')}
    }
    const items = found.slice(0, 6).map(event => '• ' + shortLabel(dateOf(event.date)) + (event.time ? ', ' + eventTime(event) : '') + ' — ' + event.title)
    if (found.length > items.length) items.push('Ещё в календаре: ' + (found.length - items.length))
    return {reply:'Вот что есть в календаре:\n' + items.join('\n'), date:found[0].date}
  }

  if (!parsed && !range && !batch) return {reply:'Укажи дату, чтобы я добавил событие. Например, «Репетиция завтра с 10 до 18».'}
  const dateIndex = batch?.index ?? parsed?.match.index
  const dateLength = batch?.length ?? parsed?.match[0].length
  const withoutDate = dateIndex !== undefined
    ? withoutRange.slice(0, dateIndex) + ' ' + withoutRange.slice(dateIndex + dateLength)
    : withoutRange
  const timeMatch = range ? null : /(?<![а-я\d])(?:в\s+)?(\d{1,2})[:.](\d{2})(?!\d)|(?:^|\s)в\s+(\d{1,2})(?:\s+час(?:а|ов)?(?![а-я]))?(?=\s|[,.!]|$)/iu.exec(withoutDate)
  let time = ''
  let endTime = ''
  if (range) {
    time = pad(range[1]) + ':' + (range[2] || '00')
    endTime = pad(range[3]) + ':' + (range[4] || '00')
    if (!clockPattern.test(time) || !clockPattern.test(endTime)) return {reply:'Проверь время. Например, «Репетиция завтра с 10:30 до 18:00».'}
    if (endTime <= time) return {reply:'Время окончания должно быть позже начала в пределах одного дня.'}
  } else if (timeMatch) {
    const hour = +(timeMatch[1] || timeMatch[3])
    const minute = +(timeMatch[2] || '0')
    if (hour > 23 || minute > 59) return {reply:'Проверь время. Например, «Съёмка завтра в 18:30».'}
    time = pad(hour) + ':' + pad(minute)
  }
  let title = withoutDate
  if (timeMatch) title = title.slice(0,timeMatch.index) + ' ' + title.slice(timeMatch.index + timeMatch[0].length)
  title = title.replace(/^\s*(?:добавь|запланируй|запиши|поставь)\s+/iu,'').replace(/[\s,.;:!?–—-]+$/u,'').replace(/(?:^|\s)(?:в|на)$/iu,'').replace(/^[\s,.;:–—-]+/u,'').replace(/\s+/gu,' ')
  if (!title) return {reply:'Как назвать событие? Напиши название вместе с датой, например «Съёмка завтра».'}
  const date = parsed?.date ?? selectedDate
  const event = {title:capitalize(title.replace(/(?<![а-я])с[ъь][её]м/giu,'съём')), date:stamp(date), time, type, ...(endTime ? {endTime} : {})}
  if (batch) {
    const dates = batch.dates.sort((a,b) => a-b)
    return {events:dates.map(day => ({...event,date:stamp(day)})), date:stamp(dates[0]), reply:'«' + event.title + '» · ' + dates.map(dateLabel).join(', ') + (time ? ' · ' + eventTime(event) : '') + '.'}
  }
  const when = dateLabel(date) + (endTime ? ', ' + eventTime(event) : time ? ' в ' + time : '')
  return {event, date:event.date, confirm:!parsed, reply:'Добавлено: «' + event.title + '» — ' + when + '.'}
}
