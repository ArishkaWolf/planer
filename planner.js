export const categories = {
  filming: {label: 'Съёмка', icon: 'film'},
  rehearsal: {label: 'Репетиция', icon: 'clock'},
  show: {label: 'Спектакль', icon: 'ticket'},
  personal: {label: 'Личное', icon: 'calendar'},
}

export const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const monthCases = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
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
  const monthWord = monthCases.concat(months.map(month => month.toLowerCase())).join('|')
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
  if (/съем|кинопроб|кастинг/u.test(phrase)) return 'filming'
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

export function interpret(text, events, base = today(), feed = {months:[]}) {
  const phrase = text.toLowerCase().replaceAll('ё','е')
  const query = /^(?:а\s+)?(?:когда|что|какие|какой|есть ли|сколько|найди|покажи|будет ли|свобод[а-я]* ли|могу ли)(?![а-я])/u.test(phrase) || /\?$/.test(phrase)
  const parsed = parseDate(phrase, base)
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
    const items = found.slice(0, 6).map(event => '• ' + shortLabel(dateOf(event.date)) + (event.time ? ', ' + event.time : '') + ' — ' + event.title)
    if (found.length > items.length) items.push('Ещё в календаре: ' + (found.length - items.length))
    return {reply:'Вот что есть в календаре:\n' + items.join('\n'), date:found[0].date}
  }

  if (!parsed) return {reply:'Укажи дату, чтобы я добавил событие. Например, «Репетиция завтра в 14:30».'}
  const index = parsed.match.index
  const withoutDate = text.slice(0, index) + ' ' + text.slice(index + parsed.match[0].length)
  const timeMatch = /(?<![а-я\d])(?:в\s+)?(\d{1,2})[:.](\d{2})(?!\d)|(?:^|\s)в\s+(\d{1,2})(?:\s+час(?:а|ов)?(?![а-я]))?(?=\s|[,.!]|$)/iu.exec(withoutDate)
  let time = ''
  if (timeMatch) {
    const hour = +(timeMatch[1] || timeMatch[3])
    const minute = +(timeMatch[2] || '0')
    if (hour > 23 || minute > 59) return {reply:'Проверь время. Например, «Съёмка завтра в 18:30».'}
    time = pad(hour) + ':' + pad(minute)
  }
  let title = withoutDate
  if (timeMatch) title = title.slice(0,timeMatch.index) + ' ' + title.slice(timeMatch.index + timeMatch[0].length)
  title = title.replace(/^\s*(?:добавь|запланируй|запиши|поставь)\s+/iu,'').replace(/[\s,.;:!?–—-]+$/u,'').replace(/(?:^|\s)(?:в|на)$/iu,'').replace(/^[\s,.;:–—-]+/u,'').replace(/\s+/gu,' ')
  if (!title) return {reply:'Как назвать событие? Напиши название вместе с датой, например «Съёмка завтра».'}
  const event = {title:capitalize(title), date:stamp(parsed.date), time, type}
  return {event, date:event.date, reply:'Добавлено: «' + event.title + '» — ' + dateLabel(parsed.date) + (time ? ' в ' + time : '') + '.'}
}
