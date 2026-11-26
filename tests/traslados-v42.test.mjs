import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const admin = resolve(process.env.GESTOK_ADMIN_REPO || '../gestokwebcontrolpaneladmin')
const pg = process.env.GESTOK_PGLITE_MODULE

test('V42: finanzas y operación de Traslados', { skip: !pg }, async t => {
  const { PGlite } = await import(pathToFileURL(resolve(pg)).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(readFileSync(resolve(admin, 'tests/traslados-schema.sql'), 'utf8'))
  await db.exec(readFileSync(resolve(admin, 'supabase/migrations/20261124000100_traslados_admin_v40.sql'), 'utf8'))
  await db.exec('create publication supabase_realtime')
  await db.exec(readFileSync(new URL('../supabase/migrations/20261125000100_traslados_v41.sql', import.meta.url), 'utf8'))

  const scalar = async (sql, params = []) => {
    const { rows } = await db.query(sql, params)
    return rows.length ? Object.values(rows[0])[0] : undefined
  }

  const as = async (role, user, run) => {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user || ''])
    await db.exec('set role ' + role)
    try { return await run() } finally { await db.exec('reset role') }
  }

  const accounts = []
  for (const [idx, type] of ['transport','transport','commerce','parking','restaurant','barbershop'].entries()) {
    const org = randomUUID()
    const user = randomUUID()
    await db.query('insert into auth.users values($1)', [user])
    await db.query("select gestok_admin_create_organization_v40($1,$2,$3,$3,$4,null,1,current_date,current_date+30,'Activo')",
      [org,user,'fixture-v42-' + idx,type])
    accounts.push({org,user})
  }
  const [a,b,...legacySectors] = accounts
  const permanent = await scalar('select public_code from transport_settings where organization_id=$1', [a.org])
  const monday = '2020-06-08T13:05:00Z'
  const tuesday = '2020-06-09T13:05:00Z'
  const previousSunday = '2020-06-08T02:55:00Z'
  const pickup = 'Recogida ficticia'
  const destination = 'Destino ficticio'

  async function seedRequest(account, status = 'pending', at = monday) {
    return await scalar("insert into transport_requests(organization_id,pickup,destination,schedule_kind,pickup_at,status,pickup_lat,pickup_lng,updated_at) values($1,$2,$3,'scheduled',$4,$5,-27.3,-55.8,$4) returning id", [account.org,pickup,destination,at,status])
  }

  const version = id => scalar('select updated_at::text from transport_requests where id=$1', [id])
  const identity = (account, run) => as('authenticated',account.user,run)
  const finance = (account, period, anchor) => identity(account,
    () => scalar('select gestok_transport_finance_v42($1,$2,$3)', [account.org,period,anchor]))
  const history = (account, from = null, to = null, status = null, payment = null, offset = 0) => identity(account,
    () => db.query('select * from gestok_transport_history_v42($1,$2,$3,$4,$5,$6)', [account.org,from,to,status,payment,offset]))
  const trip = (account,id,at,status,amount,payment) => identity(account,
    () => scalar('select gestok_transport_manual_trip_v42($1,$2,$3,$4,$5,$6,$7,$8)',
      [account.org,id,pickup,destination,at,status,amount,payment]))
  const expense = (account,id,category,description,amount,at) => identity(account,
    () => scalar('select gestok_transport_add_expense_v42($1,$2,$3,$4,$5,$6)',
      [account.org,id,category,description,amount,at]))
  const close = (account, id, old, status, amount = null, payment = null) => identity(account,
    () => db.query('select gestok_transport_close_v42($1,$2,$3,$4,$5,$6)', [account.org,id,old,status,amount,payment]))
  const confirm = async (account,id) => {
    const old = await version(id)
    await identity(account, () => db.query("select gestok_transport_driver_action($1,$2,$3,'confirm',null,1)", [account.org,id,old]))
  }

  for (const amount of [40,null]) {
    const id = await seedRequest(a,'completed',monday)
    await db.query('insert into transport_trips values($1,$2,$3,$3,$4)', [id,a.org,monday,amount])
  }
  const cancelled = randomUUID()
  const organizationsBefore = (await db.query('select id,type,login_slug from organizations order by id')).rows
  await db.exec(readFileSync(new URL('../supabase/migrations/20261125000200_traslados_v42.sql', import.meta.url), 'utf8'))

  await t.test('V40 y V41 conservan UUID, bloqueo público y registros históricos', async () => {
    assert.deepEqual((await db.query('select id,type,login_slug from organizations order by id')).rows,organizationsBefore)
    assert.equal(await scalar('select public_code from transport_settings where organization_id=$1',[a.org]),permanent)
    await assert.rejects(db.query('update transport_settings set requests_enabled=true'),/requests_disabled_v40/)
    assert.equal(await as('anon', null, () => scalar('select gestok_transport_public_available($1)',[permanent])),false)
    const historical = (await history(a,'2020-06-08','2020-06-08','completed','unknown')).rows
    assert.equal(historical.length,2)
    assert.ok(historical.every(row => row.payment_method === null && !('pickup_lat' in row)))
    assert.deepEqual(historical.map(row=>row.amount == null ? null : Number(row.amount)).sort(),[40,null])
  })

  await t.test('finalización atómica, medio requerido y reintento sin doble ingreso', async () => {
    const id = await seedRequest(a)
    await confirm(a,id)
    const old = await version(id)
    await assert.rejects(close(a,id,old,'completed',100,null),/medio de pago/)
    await assert.rejects(close(a,id,old,'completed',100.123,'cash'),/importe válido/)
    await assert.rejects(identity(a, () => db.query("select gestok_transport_driver_action($1,$2,$3,'complete',null,100)", [a.org,id,old])),/requiere importe y medio/)
    assert.equal(await scalar('select status from transport_requests where id=$1',[id]),'confirmed')
    await close(a,id,old,'completed',100,'cash')
    await close(a,id,old,'completed',100,'cash')
    await assert.rejects(close(a,id,old,'completed',200,'transfer'),/ya cambió/)
    assert.equal(await scalar('select count(*)::int from transport_trips where request_id=$1 and completed_at is not null',[id]),1)
    assert.equal(await scalar('select payment_method from transport_trips where request_id=$1',[id]),'cash')
    const today = await scalar("select (now() at time zone 'America/Argentina/Buenos_Aires')::date::text")
    const balance = await finance(a,'day',today)
    assert.equal(balance.income,100)
    assert.equal(balance.trips,1)

    const other = await seedRequest(a)
    await confirm(a,other)
    const otherVersion = await version(other)
    await close(a,other,otherVersion,'cancelled')
    await close(a,other,otherVersion,'cancelled')
    assert.equal(await scalar('select status from transport_requests where id=$1',[other]),'cancelled')
    assert.equal(await scalar('select completed_at from transport_trips where request_id=$1',[other]),null)
  })

  await t.test('viajes manuales y gastos, validación y deduplicación independiente', async () => {
    const id = randomUUID()
    assert.equal(await trip(a,id,monday,'completed',120,'transfer'),id)
    assert.equal(await trip(a,id,monday,'completed',120,'transfer'),id)
    await assert.rejects(trip(a,id,monday,'completed',120,'qr'),/otra operación/)
    await assert.rejects(trip(b,id,monday,'completed',120,'transfer'),/otra operación/)
    await trip(a,randomUUID(),'2020-06-08T13:25:00Z','completed',80,'qr')
    await trip(a,randomUUID(),tuesday,'completed',60,'other')
    await trip(a,randomUUID(),previousSunday,'completed',75,'cash')
    await trip(a,cancelled,monday,'cancelled',null,null)
    await trip(b,randomUUID(),monday,'completed',999,'cash')
    await assert.rejects(trip(a,randomUUID(),'2099-01-01','completed',1,'cash'),/Fecha/)

    const e = randomUUID()
    assert.equal(await expense(a,e,'fuel','Carga',35,monday),e)
    assert.equal(await expense(a,e,'fuel','Carga',35,monday),e)
    await assert.rejects(expense(a,e,'fuel','Carga',36,monday),/otra operación/)
    await expense(a,randomUUID(),'other','Lavado ficticio',15,monday)
    await expense(a,randomUUID(),'tolls',null,9,previousSunday)
    await expense(b,randomUUID(),'maintenance',null,999,monday)
    await assert.rejects(expense(a,randomUUID(),'other','   ',1,monday),/check constraint/)
    await assert.rejects(expense(a,randomUUID(),'parking',null,0,monday),/importe/)
    assert.equal(await scalar('select count(*)::int from transport_expenses where organization_id=$1',[a.org]),3)
  })

  await t.test('balance, zonas horarias, períodos, promedios y filtros', async () => {
    await seedRequest(a,'rejected',monday)
    await seedRequest(a,'pending',monday)
    await seedRequest(a,'delayed',monday)
    const daily = await finance(a,'day','2020-06-08')
    assert.deepEqual([daily.income,daily.expenses,daily.net,daily.trips,daily.unpriced,daily.average,daily.pending],[240,50,190,4,1,80,2])
    assert.equal(daily.series.length,24)
    assert.deepEqual(daily.series.find(row=>row.label==='10:00'),{label:'10:00',income:240,expenses:50,trips:4})
    assert.equal(daily.peak_hour,10)
    assert.equal(daily.peak_weekday,1)
    const weekly = await finance(a,'week','2020-06-10')
    assert.deepEqual([weekly.from,weekly.through,weekly.income,weekly.expenses,weekly.trips,weekly.series.length],
      ['2020-06-08','2020-06-14',300,50,5,7])
    const monthly = await finance(a,'month','2020-06-15')
    assert.deepEqual([monthly.from,monthly.through,monthly.income,monthly.expenses,monthly.series.length],
      ['2020-06-01','2020-06-30',375,59,30])
    const transfer = (await history(a,'2020-06-08','2020-06-08','completed','transfer')).rows
    assert.equal(transfer.length,1)
    assert.equal(transfer[0].source,'manual')
    assert.equal(transfer[0].pickup,pickup)
    assert.equal((await history(a,'2020-06-08','2020-06-08','cancelled')).rows[0].id,cancelled)
    assert.equal((await history(a,'2020-06-08','2020-06-08','rejected')).rows.length,1)
    assert.equal((await history(a,'2020-06-08','2020-06-08','completed','transfer',1)).rows.length,0)
  })

  await t.test('RLS en gastos y separación de datos entre sectores', async () => {
    for (const account of [b,...legacySectors]) {
      await identity(account,async () => {
        assert.equal(await scalar('select count(*)::int from transport_expenses where organization_id=$1',[a.org]),0)
        assert.equal(await scalar('select count(*)::int from gestok_transport_history_v42($1,null,null,null,null,0)',[a.org]),0)
        await assert.rejects(db.query("select gestok_transport_finance_v42($1,'day',null)",[a.org]),/no autorizada/)
      })
    }
    await as('anon',null,async () => {
      await assert.rejects(db.query('select * from transport_expenses'),/permission denied/)
      await assert.rejects(db.query("select gestok_transport_finance_v42($1,'week',null)",[a.org]),/permission denied/)
    })
    await identity(a,async () => {
      await assert.rejects(db.query("update transport_expenses set description='cambio'"),/permission denied/)
    })
  })
})
