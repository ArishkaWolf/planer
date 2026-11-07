import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {PGlite} from '@electric-sql/pglite'
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto'

test('PostgreSQL account access, concurrent sessions, validation and attempt limits',async()=>{
  const db = new PGlite({extensions:{pgcrypto}})
  try {
    await db.exec('create role anon; create role authenticated;')
    const schema = await readFile(new URL('../supabase-account.sql',import.meta.url),'utf8')
    await db.exec(schema)
    const call = (name,args)=>db.transaction(async tx=>{
      await tx.exec('set local role anon')
      const slots = args.map((_,i)=>'$'+(i+1)).join(',')
      const result = await tx.query(`select public.${name}(${slots}) as result`,args)
      return result.rows[0].result
    })
    const sign = (name,pin,create=false)=>call('antrakt_account_sign_in',[name,pin,create])
    const read = token=>call('antrakt_account_read',[token])
    const write = (token,revision,data)=>call('antrakt_account_write',[token,revision,data])
    const sample = {id:'test-event',title:'Съёмка',date:'2026-11-21',time:'10:00',endTime:'18:00',type:'filming',important:true}
    const data = {events:[sample],hiddenShows:[],importantShows:[]}
    const first = await sign('Тестовый актёр','2468',true)
    assert.equal(first.username,'Тестовый актёр')
    assert.match(first.token,/^[a-f0-9]{64}$/)
    assert.equal(first.revision,0)
    const second = await sign('тестовый актёр','2468')
    assert.equal(second.username,first.username)
    assert.notEqual(second.token,first.token)
    assert.deepEqual(await write(first.token,0,data),{revision:1})
    assert.deepEqual((await read(second.token)).data,data)
    assert.deepEqual(await write(second.token,0,data),{conflict:true})
    assert.deepEqual(await read('f'.repeat(64)),{error:'session'})
    assert.deepEqual(await write('f'.repeat(64),0,data),{error:'session'})
    assert.deepEqual(await write('',0,data),{error:'session'})
    assert.deepEqual(await write(null,0,data),{error:'session'})
    const other = await sign('Другой актёр','1357',true)
    assert.equal((await read(other.token)).data.events.length,0)
    for (const invalid of [
      {...data,events:[{...sample,date:'2026-02-31'}]},
      {...data,events:[{...sample,endTime:'09:00'}]},
      {...data,hiddenShows:['untrusted-id']},
    ]) assert.deepEqual(await write(first.token,1,invalid),{error:'input'})
    assert.equal((await read(first.token)).revision,1)
    await call('antrakt_account_sign_out',[first.token])
    assert.deepEqual(await read(first.token),{error:'session'})
    assert.deepEqual(await write(first.token,1,data),{error:'session'})
    assert.equal((await read(second.token)).revision,1)
    for (let index=0;index<5;index++) assert.deepEqual(await sign('Тестовый актёр','0000'),{error:'credentials'})
    assert.deepEqual(await sign('Тестовый актёр','2468'),{error:'limited'})
    assert.equal((await read(second.token)).revision,1)
    const stored = await db.query('select pin_hash from antrakt_private.accounts')
    assert.ok(stored.rows.every(row=>row.pin_hash.startsWith('$2') && row.pin_hash!=='2468'))
    for (const table of ['accounts','account_sessions']) {
      await assert.rejects(db.transaction(async tx=>{
        await tx.exec('set local role anon')
        await tx.query(`select * from antrakt_private.${table}`)
      }))
    }
    await db.exec(schema)
    assert.deepEqual((await read(second.token)).data,data)
    await db.exec("update antrakt_private.account_attempts set started_at = now() - interval '16 minutes'")
    const again = await sign('Тестовый актёр','2468')
    assert.match(again.token,/^[a-f0-9]{64}$/)
    await db.query("update antrakt_private.account_sessions set expires_at = now() - interval '1 second' where token_hash = sha256(convert_to($1,'UTF8'))",[again.token])
    assert.deepEqual(await read(again.token),{error:'session'})
  } finally { await db.close() }
})
