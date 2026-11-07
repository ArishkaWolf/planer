export const categories = {
  filming: {label: 'Съёмка', icon: 'film'},
  rehearsal: {label: 'Репетиция', icon: 'clock'},
  show: {label: 'Спектакль', icon: 'ticket'},
  teahouse: {label: 'Чайхана', icon: 'cup'},
  concert: {label: 'Концерт', icon: 'music'},
  personal: {label: 'Личное', icon: 'calendar'},
}

const eventAliases = {репа:'репетиция', реп:'репетиция', чх:'чайхана', спект:'спектакль', съем:'съёмка', съём:'съёмка', сьем:'съёмка'}
const expandEventAliases = text => text.replace(/(?<![\p{L}\p{N}])(репа|реп|чх|спект|съем|съём|сьем)\.?(?![\p{L}\p{N}])/giu, (_, alias) => eventAliases[alias.toLowerCase()])

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

const weekdayWords = ['понедельник|пн', 'вторник|вт', 'среда|среду|ср', 'четверг|чт', 'пятница|пятницу|пт', 'суббота|субботу|сб', 'воскресенье|вс']

function parseDate(text, base, selectedDate = base) {
  const relative = /(?<![а-я])(?:послезавтра|завтра|сегодня)(?![а-я])/u.exec(text)
  if (relative) return {date:addDays(base, {сегодня:0, завтра:1, послезавтра:2}[relative[0]]), match:relative}
  const after = /(?<![а-я])через\s+(?:(\d{1,3}|один|два|три|одну)\s+)?(день|дня|дней|неделю|недели|недель)(?![а-я])/u.exec(text)
  if (after) {
    const count = after[1] ? Number(after[1]) || {один:1,одну:1,два:2,три:3}[after[1]] : 1
    return {date:count <= 365 ? addDays(base,count * (after[2].startsWith('недел') ? 7 : 1)) : null,match:after}
  }

  const iso = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/u.exec(text)
  if (iso) return {date:exactDate(+iso[1], +iso[2], +iso[3]), match:iso}

  const numeric = /(?<![\d.:])(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?(?![\d:])/u.exec(text)
  const named = new RegExp('(?<![\\d:])(\\d{1,2})\\s+(' + monthWord + ')(?![а-я])(?:\\s+(\\d{4})(?![\\d:]))?', 'u').exec(text)
  const match = named || numeric
  if (!match) {
    const weekday = new RegExp('(?<![а-я])(?:(?:в|во)\\s+)?(?:(?:этот|эту|ближайший|ближайшую|следующий|следующую)\\s+)?(' + weekdayWords.join('|') + ')(?![а-я])', 'u').exec(text)
    if (weekday) {
      const index = weekdayWords.findIndex(words => new RegExp('^(?:' + words + ')$','u').test(weekday[1]))
      let offset = (index - (base.getDay() + 6) % 7 + 7) % 7
      if (/следующ/u.test(weekday[0])) offset = 7 + index - (base.getDay() + 6) % 7
      return {date:addDays(base,offset),match:weekday}
    }
    const bare = /(?<![\dа-я.:/\-])(?:(?:на|в)\s+)?(\d{1,2})(?:\s*-?(?:го|е|ого))?(?![\dа-я.:/\-])/u.exec(text)
    if (bare) return {date:exactDate(selectedDate.getFullYear(),selectedDate.getMonth() + 1,+bare[1]),match:bare,implicit:true}
    return null
  }

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
  const phrase = expandEventAliases(text).toLowerCase().replaceAll('ё','е')
  if (/с[ъь]?ем|кинопроб|кастинг/u.test(phrase)) return 'filming'
  if (/репети|прогон/u.test(phrase)) return 'rehearsal'
  if (/чайхан/u.test(phrase)) return 'teahouse'
  if (/концерт/u.test(phrase)) return 'concert'
  if (/спектакл|премьер|показ/u.test(phrase)) return 'show'
  return 'personal'
}

// Early versions defaulted every event in the form to "personal".
export function normalizeEvent(event) {
  const title = expandEventAliases(event.title).toLowerCase().replaceAll('ё','е').trim()
  const filmingTitle = /^(?:важн(?:ая|ое)\s+)?(?:с[ъь]?емк[аи]|съемочный\s+день|кастинг|кинопробы)(?![а-я])/u.test(title)
  return event.type === 'personal' && filmingTitle ? {...event,type:'filming'} : event
}

export function dayHighlights(events) {
  return {
    filming:events.some(event => normalizeEvent(event).type === 'filming'),
    important:events.some(event => event.important === true),
  }
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
  return /(?<![а-я\d])(?:с\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(?:до|по|[-–—])\s*(\d{1,2})(?:[:.](\d{2}))?(?:\s*(?:часов|часа|ч)(?![а-я]))?(?![\d:.])/iu.exec(text)
}

function parseSingleTime(text) {
  const match = /(?<![а-я\d])(?:в|с)\s*(\d{1,2})(?:[:.](\d{2}))?(?:\s*(?:час(?:а|ов)?|ч)(?![а-я]))?(?:\s*(утра|дня|вечера|ночи))?(?![а-я\d.:])|(?<![\d.:/])(\d{1,2}):(\d{2})(?:\s*(утра|дня|вечера|ночи))?(?![\d:])/iu.exec(text)
  if (!match) return null
  let hour = +(match[1] || match[4])
  const minute = +(match[2] || match[5] || 0)
  const period = (match[3] || match[6] || '').toLowerCase()
  if (hour > 23 || minute > 59 || (period && (hour < 1 || hour > 12))) return {match,error:true}
  if ((period === 'вечера' || period === 'дня') && hour < 12) hour += 12
  if (period === 'ночи' && hour === 12) hour = 0
  return {match,time:pad(hour) + ':' + pad(minute)}
}

function parseDayRange(text, base, selectedDate) {
  const match = new RegExp('(?<![а-я\\d])(?:с\\s*)?(\\d{1,2})\\s*(?:по|[-–—])\\s*(\\d{1,2})\\s+(' + monthWord + ')(?![а-я])(?:\\s+(\\d{4})(?![\\d:]))?', 'u').exec(text)
  if (!match) return null
  const month = parseDate(match[1] + ' ' + match[3] + (match[4] ? ' ' + match[4] : ''),base,selectedDate)?.date
  const from = +match[1]
  const to = +match[2]
  const dates = month && from <= to && to - from < 31
    ? Array.from({length:to-from+1},(_,offset)=>exactDate(month.getFullYear(),month.getMonth()+1,from+offset)) : [null]
  return {dates,index:match.index,length:match[0].length}
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
  text = text.trim().replaceAll('\u00a0',' ')
  const phrase = text.toLowerCase().replaceAll('ё','е')
  const query = /^(?:а\s+)?(?:когда|что|какие|какой|есть ли|сколько|найди|покажи|будет ли|свобод[а-я]* ли|могу ли)(?![а-я])/u.test(phrase) || /\?$/.test(phrase)
  if (!query && new RegExp('(?<![а-я\\d])с\\s*\\d{1,2}(?:[:.]\\d{2})?\\s*до\\s*\\d{1,2}\\s+(?:' + monthWord + ')(?![а-я])','u').test(phrase)) {
    return {reply:'Уточни дату и время отдельно. Например, «Репетиция 18 ноября с 10 до 18». Для нескольких дат напиши «Съёмка с 10 по 18 ноября».'}
  }
  const parts = query ? [] : text.split(/\s*[;\n]+\s*|\s+и\s+(?=(?:репа|репетици[яю]|с[ъь]?[её]мк[аи]|спектакль|спект|чх|чайхана|концерт)(?![а-я]))/iu).filter(Boolean)
  if (parts.length > 1) {
    if (parts.length > 20) return {reply:'Отправь до 20 событий за раз, каждое с новой строки или через точку с запятой.'}
    const added = []
    let context = selectedDate
    let confirm = false
    for (const part of parts) {
      const result = interpret(part,events,base,feed,context)
      if (!result.event && !result.events) return {reply:'Пока ничего не добавлено. Уточни «' + part + '». ' + result.reply}
      added.push(...(result.events || [result.event]))
      context = dateOf(result.date)
      confirm ||= result.confirm === true
    }
    return {events:added,date:added[0].date,confirm,reply:added.map(event=>'«' + event.title + '» · ' + dateLabel(dateOf(event.date)) + (event.time ? ' · ' + eventTime(event) : '')).join('\n')}
  }
  const dayRange = query ? null : parseDayRange(phrase,base,selectedDate)
  // Mask dates before looking for a time, including numeric dates such as 10.11.
  const earlyTime = query || dayRange ? null : parseSingleTime(text)
  const maskedTime = earlyTime ? phrase.slice(0,earlyTime.match.index) + ' '.repeat(earlyTime.match[0].length) + phrase.slice(earlyTime.match.index+earlyTime.match[0].length) : phrase
  const knownDate = dayRange ? null : parseDate(maskedTime,base,selectedDate)
  const dateMask = dayRange || (knownDate && !knownDate.implicit ? {index:knownDate.match.index,length:knownDate.match[0].length} : null)
  const timeText = dateMask ? text.slice(0,dateMask.index) + ' '.repeat(dateMask.length) + text.slice(dateMask.index+dateMask.length) : text
  const range = query ? null : parseTimeRange(timeText)
  const withoutRange = range ? text.slice(0, range.index) + ' '.repeat(range[0].length) + text.slice(range.index + range[0].length) : text
  const normalized = withoutRange.toLowerCase().replaceAll('ё','е')
  const batch = query ? null : dayRange || parseDayList(normalized,base,selectedDate)
  if (batch?.dates.some(date => !date)) return {reply:'Проверь числа. Все даты в списке должны существовать в выбранном месяце.'}
  const singleTime = range || query ? null : parseSingleTime(timeText)
  const dateText = singleTime ? normalized.slice(0,singleTime.match.index) + ' '.repeat(singleTime.match[0].length) + normalized.slice(singleTime.match.index+singleTime.match[0].length) : normalized
  const parsed = batch ? null : parseDate(dateText, base,selectedDate)
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
    const mine = type === 'show' && /мо[ийею]|нестеров/u.test(phrase)
    const found = matches.filter(event => (type === 'personal' || event.type === type) && (!mine || event.source !== 'theater' || event.myShow === true))
    if (!found.length) {
      const missing = ['show','teahouse','concert','personal'].includes(type) && (!feed.months.includes(from.slice(0, 7)) || feed.stale)
      return {reply:'В календаре за этот период таких событий нет.' + (missing ? '\nАфиша за этот период может быть неполной.' : '')}
    }
    const items = found.slice(0, 6).map(event => '• ' + shortLabel(dateOf(event.date)) + (event.time ? ', ' + eventTime(event) : '') + ' — ' + event.title)
    if (found.length > items.length) items.push('Ещё в календаре: ' + (found.length - items.length))
    return {reply:'Вот что есть в календаре:\n' + items.join('\n'), date:found[0].date}
  }

  if (!parsed && !range && !batch && !singleTime) return {reply:'Укажи дату, чтобы я добавил событие. Например, «Репетиция завтра с 10 до 18».'}
  const dateIndex = batch?.index ?? parsed?.match.index
  const dateLength = batch?.length ?? parsed?.match[0].length
  const withoutDate = dateIndex !== undefined
    ? withoutRange.slice(0, dateIndex) + ' ' + withoutRange.slice(dateIndex + dateLength)
    : withoutRange
  const timeValue = range ? null : parseSingleTime(withoutDate)
  const timeMatch = timeValue?.match
  let time = ''
  let endTime = ''
  if (range) {
    time = pad(range[1]) + ':' + (range[2] || '00')
    endTime = pad(range[3]) + ':' + (range[4] || '00')
    if (!clockPattern.test(time) || !clockPattern.test(endTime)) return {reply:'Проверь время. Например, «Репетиция завтра с 10:30 до 18:00».'}
    if (endTime <= time) return {reply:'Время окончания должно быть позже начала в пределах одного дня.'}
  } else if (timeMatch) {
    if (timeValue.error) return {reply:'Проверь время. Например, «Съёмка завтра в 18:30».'}
    time = timeValue.time
  }
  let title = withoutDate
  if (timeMatch) title = title.slice(0,timeMatch.index) + ' ' + title.slice(timeMatch.index + timeMatch[0].length)
  const important = /(?<![а-я])важн(?:о|ая|ый|ое|ую)(?![а-я])/iu.test(title)
  title = title.replace(/^\s*(?:(?:пожалуйста|добавь|добавить|запланируй|запиши|поставь|мне|событие|события)\s*[,.:]?\s+)+/iu,'').replace(/(?<![а-я])(?:это\s+)?важн(?:о|ая|ый|ое|ую)(?![а-я])/giu,' ').replace(/[\s,.;:!?–—-]+$/u,'').replace(/(?:^|\s)(?:в|на)$/iu,'').replace(/^[\s,.;:–—-]+/u,'').replace(/\s+/gu,' ').trim()
  title = title.replace(/^(?:на|в|во)\s+/iu,'')
  if (!title) return {reply:'Как назвать событие? Напиши название вместе с датой, например «Съёмка завтра».'}
  const date = parsed?.date ?? selectedDate
  const name = expandEventAliases(title).replace(/(?<![а-я])с[ъь][её]м/giu,'съём')
  if (name.length > 250) return {reply:'Сократи название события до 250 символов.'}
  const event = {title:capitalize(name), date:stamp(date), time, type, ...(endTime ? {endTime} : {}), ...(important ? {important:true} : {})}
  if (batch) {
    const dates = batch.dates.sort((a,b) => a-b)
    return {events:dates.map(day => ({...event,date:stamp(day)})), date:stamp(dates[0]), reply:'«' + event.title + '» · ' + dates.map(dateLabel).join(', ') + (time ? ' · ' + eventTime(event) : '') + '.'}
  }
  const when = dateLabel(date) + (endTime ? ', ' + eventTime(event) : time ? ' в ' + time : '')
  return {event, date:event.date, confirm:!parsed || parsed.implicit === true, reply:'Добавлено: «' + event.title + '» — ' + when + (important ? ' · Важно' : '') + '.'}
}
