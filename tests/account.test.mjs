import test from 'node:test'
import assert from 'node:assert/strict'
import {syncConfig} from '../sync-config.js'

syncConfig.url = 'https://test.invalid'
syncConfig.publishableKey = 'test-publishable-key'
const account = await import('../account.js')
const token = 'a'.repeat(64)
const connection = {token,username:'Тестовый актёр',expiresAt:'2099-01-01T00:00:00Z'}
const empty = {events:[],hiddenShows:[],importantShows:[]}
const peer = {id:'peer',title:'Концерт',date:'2026-11-21',time:'18:00',type:'concert'}
const added = {id:'added',title:'Съёмка',date:'2026-11-22',time:'10:00',type:'filming'}
const values = new Map()
globalThis.localStorage = {getItem:key=>values.get(key) ?? null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}

function responses(steps) {
  const calls = []
  globalThis.fetch = async (url,options) => {
    const step = steps[calls.length]
    const args = JSON.parse(options.body)
    calls.push({url,args})
    assert.ok(step,'Unexpected request')
    assert.ok(url.endsWith('/rpc/' + step.name))
    assert.equal(options.method,'POST')
    assert.equal(options.headers.apikey,'test-publishable-key')
    return {ok:true,json:async()=>step.result}
  }
  return calls
}

test('account creation and login use the server with normalized name and a four-digit code',async()=>{
  for (const create of [true,false]) {
    const calls = responses([{name:'antrakt_account_sign_in',result:{...connection,revision:0,data:empty}}])
    const result = await account.signInAccount('  Тестовый   актёр  ','0123',create)
    assert.deepEqual(calls[0].args,{account_name:'Тестовый актёр',pin_code:'0123',create_account:create})
    assert.deepEqual(result.connection,connection)
    assert.equal(result.snapshot.canEdit,true)
  }
})

test('invalid names and codes never reach the server',async()=>{
  const calls = responses([])
  for (const [name,pin] of [['А','1234'],['Актёр','123'],['Актёр','12345'],['Актёр','абвг'],['<script>','1234']]) {
    await assert.rejects(account.signInAccount(name,pin),e=>e.kind==='input')
  }
  assert.equal(calls.length,0)
})

test('browser remembers a random session without retaining the code or schedule',()=>{
  account.rememberAccount({...connection,pin:'0123',data:empty})
  assert.deepEqual(account.accountSession(),connection)
  assert.doesNotMatch(values.get(account.accountKey),/0123|events/)
  account.rememberAccount({...connection,expiresAt:'2000-01-01T00:00:00Z'})
  assert.equal(account.accountSession(),null)
  values.set(account.accountKey,'broken json')
  assert.equal(account.accountSession(),null)
  account.rememberAccount(null)
  assert.equal(values.has(account.accountKey),false)
})

test('wrong credentials and attempt limits are reported without opening a session',async()=>{
  for (const error of ['credentials','limited','exists']) {
    responses([{name:'antrakt_account_sign_in',result:{error}}])
    await assert.rejects(account.signInAccount(connection.username,'0123'),e=>e.kind===error)
  }
})

test('expired sessions cannot read or save events',async()=>{
  responses([{name:'antrakt_account_read',result:{error:'session'}}])
  await assert.rejects(account.writeAccount(connection,()=>({...empty,events:[added]})),e=>e.kind==='session')
})

test('concurrent device changes are re-read and merged before retrying a save',async()=>{
  const calls = responses([
    {name:'antrakt_account_read',result:{username:connection.username,revision:0,data:empty}},
    {name:'antrakt_account_write',result:{conflict:true}},
    {name:'antrakt_account_read',result:{username:connection.username,revision:1,data:{...empty,events:[peer]}}},
    {name:'antrakt_account_write',result:{revision:2}},
  ])
  const result = await account.writeAccount(connection,data=>({...data,events:[...data.events,added]}))
  assert.equal(calls[3].args.expected_revision,1)
  assert.deepEqual(calls[3].args.next_data.events,[peer,added])
  assert.deepEqual(result.data.events,[peer,added])
  assert.equal(result.revision,2)
})

test('invalid remote records are rejected instead of replacing a calendar',async()=>{
  responses([{name:'antrakt_account_read',result:{username:connection.username,revision:0,data:{...empty,events:[{...added,date:'2026-02-31'}]}}}])
  await assert.rejects(account.readAccount(connection),/прочитать расписание/)
})

test('sign out revokes only the requested session and does not clear a newer sign-in',async()=>{
  const calls = responses([{name:'antrakt_account_sign_out',result:{ok:true}}])
  const newer = {...connection,token:'b'.repeat(64)}
  account.rememberAccount(newer)
  await account.signOutAccount(connection)
  assert.deepEqual(calls[0].args,{session_token:token})
  assert.deepEqual(account.accountSession(),newer)
})
