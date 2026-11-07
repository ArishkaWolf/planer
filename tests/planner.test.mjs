import test from 'node:test'
import assert from 'node:assert/strict'
import {categoryOf, dateOf, dayHighlights, interpret, isCalendarEvent, normalizeEvent, scheduleFragment, scheduleFromFragment} from '../planner.js'

const base = dateOf('2026-11-07')
const read = text => interpret(text,[],base,{months:['2026-11']},base)

const cases = [
  ['сьемка 21 ноября','filming','2026-11-21','',''],
  ['съем завтра с10до18','filming','2026-11-08','10:00','18:00'],
  ['репа завтра с 10 до 18','rehearsal','2026-11-08','10:00','18:00'],
  ['реп. 18 ноября 10-18','rehearsal','2026-11-18','10:00','18:00'],
  ['чх в пятницу в 8 вечера','teahouse','2026-11-13','20:00',''],
  ['спект в пн в 19:30','show','2026-11-09','19:30',''],
  ['концерт в следующую среду в 18','concert','2026-11-11','18:00',''],
  ['прогон в субботу 10:30–18:00','rehearsal','2026-11-07','10:30','18:00'],
  ['съемка в воскресенье в 10.30','filming','2026-11-08','10:30',''],
  ['съемка 10.11.26 в 12:30','filming','2026-11-10','12:30',''],
  ['съемка 2026-11-10 в 12','filming','2026-11-10','12:00',''],
  ['встреча послезавтра в 2 дня','personal','2026-11-09','14:00',''],
  ['съемка завтра в 12 ночи','filming','2026-11-08','00:00',''],
  ['концерт через два дня в 18 часов','concert','2026-11-09','18:00',''],
  ['репетиция через неделю в 18','rehearsal','2026-11-14','18:00',''],
  ['репетиция через одну неделю в 18','rehearsal','2026-11-14','18:00',''],
  ['съемка завтра 10.30-18.00','filming','2026-11-08','10:30','18:00'],
  ['съемка 29 февраля','filming','2028-02-29','',''],
]

for (const [text,type,date,time,endTime] of cases) test(text,()=>{
  const result = read(text)
  assert.equal(result.event?.type,type)
  assert.equal(result.event?.date,date)
  assert.equal(result.event?.time,time)
  assert.equal(result.event?.endTime || '',endTime)
  assert.ok(isCalendarEvent({...result.event,id:'test'}))
})

test('short dates and missing dates are confirmed against displayed month',()=>{
  for (const text of ['съемка 21','съемка на 21-е','репа в 10.30','репа 12:30','репа с 10 до 18']) {
    const result = interpret(text,[],base,{months:[]},dateOf('2027-01-15'))
    assert.equal(result.confirm,true,text)
    assert.ok(result.event.date.startsWith('2027-01'),text)
  }
})

test('abbreviations do not consume parts of unrelated words',()=>{
  assert.equal(categoryOf('встреча на проспекте'),'personal')
  assert.equal(categoryOf('репа'),'rehearsal')
  assert.equal(categoryOf('СПЕКТ.'),'show')
  assert.equal(categoryOf('ЧХ'),'teahouse')
})

test('legacy personal filming becomes filming without changing its identity or time',()=>{
  const old = {id:'old',title:'Сьемка',type:'personal',date:'2026-11-21',time:'10:00',endTime:'18:00',important:true}
  assert.deepEqual(normalizeEvent(old),{...old,type:'filming'})
  assert.equal(old.type,'personal')
  const personal = {...old,title:'Встреча'}
  assert.equal(normalizeEvent(personal),personal)
  const discussion = {...old,title:'Встреча по поводу съёмки'}
  assert.equal(normalizeEvent(discussion),discussion)
})

test('filming highlights survive multiple events, importance and legacy event categories',()=>{
  const filming = {type:'filming',title:'Съёмка'}
  const legacy = {type:'personal',title:'Сьемка'}
  const show = {type:'show',title:'Спектакль'}
  const important = {type:'teahouse',title:'Чайхана',important:true}
  for (const events of [[filming,show],[show,filming],[legacy,show],[show,legacy],[important,show,filming]]) {
    assert.equal(dayHighlights(events).filming,true)
  }
  assert.deepEqual(dayHighlights([important,show,filming]),{filming:true,important:true})
  assert.deepEqual(dayHighlights([show]),{filming:false,important:false})
  assert.deepEqual(dayHighlights([]),{filming:false,important:false})
})

test('date lists share the same interval',()=>{
  const result = read('сьемка 21, 23 и 25 ноября с10до18')
  assert.deepEqual(result.events.map(e=>e.date),['2026-11-21','2026-11-23','2026-11-25'])
  assert.ok(result.events.every(e=>e.title==='Съёмка' && e.time==='10:00' && e.endTime==='18:00'))
})

test('date range is not mistaken for time range even after an abbreviation',()=>{
  const result = read('репа с 21 по 25 ноября')
  assert.equal(result.events.length,5)
  assert.ok(result.events.every(e=>e.time==='' && e.title==='Репетиция'))
  const timed = read('съемка 21–23 ноября в 10')
  assert.equal(timed.events.length,3)
  assert.ok(timed.events.every(e=>e.time==='10:00'))
})

test('multiple events inherit the previous date with explicit confirmation',()=>{
  const result = read('завтра съемка с10до14; репа с16до18')
  assert.equal(result.confirm,true)
  assert.deepEqual(result.events.map(e=>[e.type,e.date,e.time,e.endTime]),[
    ['filming','2026-11-08','10:00','14:00'],['rehearsal','2026-11-08','16:00','18:00'],
  ])
})

test('multiple explicit events separated by conjunction or newline',()=>{
  for (const separator of [' и ','\n','; ']) {
    const result = read('съемка 21 ноября' + separator + 'репа 22 ноября')
    assert.equal(result.events.length,2)
    assert.equal(result.confirm,false)
    assert.deepEqual(result.events.map(e=>e.date),['2026-11-21','2026-11-22'])
  }
})

test('important marker is removed from title and preserved on event',()=>{
  const event = read('важная репа завтра с10до18').event
  assert.equal(event.title,'Репетиция')
  assert.equal(event.important,true)
  assert.equal(read('добавь пожалуйста концерт завтра в 18 это важно').event.title,'Концерт')
})

for (const text of ['съемка 31 февраля','репа 32','съемка завтра в25:60','репа завтра с18до10','репа завтра с10до25','съемка 30 и 31 февраля','съемка с25по21 ноября','съемка 21 ноября; концерт 31 февраля','репа с10до18 ноября']) {
  test('invalid input saves nothing: ' + text,()=>{
    const result = read(text)
    assert.equal(result.event,undefined)
    assert.equal(result.events,undefined)
  })
}

test('questions use full schedule and distinguish own theater shows',()=>{
  const events = [
    {id:'a',title:'Своя постановка',date:'2026-11-09',time:'18:00',type:'show',source:'theater',myShow:true},
    {id:'b',title:'Другая постановка',date:'2026-11-10',time:'18:00',type:'show',source:'theater',myShow:false},
    {id:'c',title:'Чайхана',date:'2026-11-09',time:'20:00',type:'teahouse'},
  ]
  const own = interpret('когда мои спектакли?',events,base,{months:['2026-11']})
  assert.match(own.reply,/Своя постановка/)
  assert.doesNotMatch(own.reply,/Другая постановка/)
  assert.match(interpret('когда чх?',events,base).reply,/Чайхана/)
  assert.equal(interpret('когда выходной?',events,base,{months:['2026-11']}).date,'2026-11-07')
})

test('shared links preserve added categories, important flags and intervals',async()=>{
  const events = read('важная чх завтра с10до18; концерт 21 ноября в20').events.map((e,i)=>({...e,id:String(i)}))
  const shared = await scheduleFromFragment(await scheduleFragment(events,base))
  assert.deepEqual(shared.events.map(({id,...e})=>e),events.map(({id,...e})=>({...e,endTime:e.endTime,important:e.important})))
})
