import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const adminRepo = resolve(process.env.GESTOK_ADMIN_REPO || '../gestokwebcontrolpaneladmin')
const pgliteModule = process.env.GESTOK_PGLITE_MODULE
const migration = readFileSync(new URL('../supabase/migrations/20261125000100_traslados_v41.sql', import.meta.url), 'utf8')
const code = () => randomBytes(32).toString('hex')

test('V41: solicitud pública, comprobantes, RLS, Realtime y ciclo del viaje', { skip: !pgliteModule }, async t => {
  const { PGlite } = await import(pathToFileURL(resolve(pgliteModule)).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(readFileSync(resolve(adminRepo, 'tests/traslados-schema.sql'), 'utf8'))
  await db.exec(readFileSync(resolve(adminRepo, 'supabase/migrations/20261124000100_traslados_admin_v40.sql'), 'utf8'))
  await db.exec('create publication supabase_realtime')
  const sectors = ['commerce', 'barbershop', 'parking', 'restaurant', 'transport', 'transport']
  const accounts = []
  for (const [i, type] of sectors.entries()) {
    const org = randomUUID()
    const user = randomUUID()
    await db.query('insert into auth.users values ($1)', [user])
    await db.query("select gestok_admin_create_organization_v40($1,$2,$3,$4,$5,null,100,current_date,current_date+30,'Activo')",
      [org, user, 'Ficticio ' + i, 'fixture-' + i, type])
    accounts.push({ org, user, type })
  }
  const [a, b] = accounts.slice(-2)
  for (const account of [a, b]) {
    account.code = (await db.query('select public_code from transport_settings where organization_id=$1', [account.org])).rows[0].public_code
  }

  const before = (await db.query('select id,type,login_slug from organizations order by id')).rows
  await db.exec(migration)

  async function scalar(sql, params = []) {
    const { rows } = await db.query(sql, params)
    return rows.length ? Object.values(rows[0])[0] : null
  }

  async function as(role, user, run) {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user || ''])
    await db.exec('set role ' + role)
    try { return await run() } finally { await db.exec('reset role') }
  }

  const submit = (orgCode, receipt, kind = 'now', at = null, lat = null, lng = null) =>
    scalar("select gestok_transport_submit($1,$2,'Recogida ficticia','Destino ficticio',$3,$4,$5,$6)",
      [orgCode, receipt, lat, lng, kind, at])
  const status = (orgCode, receipt) => db.query('select * from gestok_transport_request_status($1,$2)', [orgCode, receipt])
  const action = (who, org, request, version, verb, delay = null, amount = null) => as('authenticated', who,
    () => db.query('select gestok_transport_driver_action($1,$2,$3,$4,$5,$6)', [org, request, version, verb, delay, amount]))
  const version = id => scalar('select updated_at::text from transport_requests where id=$1', [id])

  await t.test('V40 conserva ambos UUID y mantiene la recepción desactivada', async () => {
    assert.deepEqual((await db.query('select id,type,login_slug from organizations order by id')).rows, before)
    assert.equal(await scalar('select public_code from transport_settings where organization_id=$1', [a.org]), a.code)
    assert.equal(await scalar('select public_code from transport_settings where organization_id=$1', [b.org]), b.code)
    await assert.rejects(db.query('update transport_settings set requests_enabled=true'), /requests_disabled_v40/)
    await assert.rejects(db.query('update transport_settings set public_code=gen_random_uuid()'), /permanente/)
    assert.equal(await as('anon', null, () => scalar('select gestok_transport_public_available($1)', [a.code])), false)
    await assert.rejects(as('anon', null, () => submit(a.code, code())), /desactivadas/)
    assert.equal(await scalar("select count(*)::int from pg_publication_tables where pubname='supabase_realtime' and tablename='transport_requests'"), 1)
  })

  // Exclusivamente en esta base desechable de pruebas.
  await db.exec('alter table transport_settings drop constraint transport_settings_requests_disabled_v40')
  await db.query('update transport_settings set requests_enabled=true where organization_id in ($1,$2)', [a.org, b.org])

  const receipt = code()
  let request
  await t.test('horarios, validación e idempotencia de la solicitud', async () => {
    const delayed = []
    const at = new Date(Date.now() + 86_400_000)
    let scheduled
    await as('anon', null, async () => {
      assert.equal(await scalar('select gestok_transport_public_available($1)', [a.code]), true)
      request = await submit(a.code, receipt, 'now', null, -27.35, -55.89)
      assert.equal(await submit(a.code, receipt), request)
      for (const kind of ['10', '20', '30', '60']) {
        delayed.push([await submit(a.code, code(), kind), Number(kind)])
      }
      scheduled = await submit(a.code, code(), 'scheduled', at.toISOString())
      await assert.rejects(submit(a.code, code(), 'scheduled', '2000-01-01T00:00:00Z'), /fecha y hora/)
      await assert.rejects(submit(a.code, code(), 'now', null, 999, -5), /check constraint/)
      await assert.rejects(submit(a.code, code(), 'now', null, -27, null), /check constraint/)
    })
    for (const [id, expected] of delayed) {
      const minutes = await scalar('select round(extract(epoch from (pickup_at - created_at))/60)::int from transport_requests where id=$1', [id])
      assert.equal(minutes, expected)
    }
    assert.equal(new Date(await scalar('select pickup_at from transport_requests where id=$1', [scheduled])).toISOString(), at.toISOString())
    assert.equal(await scalar('select count(*)::int from transport_requests where organization_id=$1', [a.org]), 6)
  })

  await t.test('aislamiento por organización y comprobante', async () => {
    await as('anon', null, async () => {
      const { rows: [row] } = await status(a.code, receipt)
      assert.deepEqual(Object.keys(row).sort(), ['amount','delay_minutes','id','pickup_at','status','updated_at'].sort())
      assert.equal(row.id, request)
      assert.deepEqual((await status(b.code, receipt)).rows, [])
      assert.deepEqual((await status(a.code, code())).rows, [])
      await assert.rejects(db.query('select * from transport_requests'), /permission denied/)
      await assert.rejects(db.query('select gestok_transport_driver_settings($1)', [a.org]), /permission denied/)
    })
    for (const account of accounts.filter(account => account !== a)) {
      await as('authenticated', account.user, async () => {
        assert.equal(await scalar('select count(*)::int from transport_requests'), 0)
        assert.equal(await scalar('select count(*)::int from gestok_transport_driver_settings($1)', [a.org]), 0)
        assert.equal(await scalar('select count(*)::int from gestok_transport_driver_stats($1)', [a.org]), 0)
      })
    }
    await as('authenticated', a.user, async () => {
      assert.equal(await scalar('select count(*)::int from transport_requests'), 6)
      await assert.rejects(db.query('select * from transport_receipts'), /permission denied/)
      await assert.rejects(db.query("update transport_requests set status='completed'"), /permission denied/)
    })
    await assert.rejects(action(b.user, a.org, request, await version(request), 'confirm'), /no autorizada/)
  })

  await t.test('demoras, confirmación, importe, finalización y estadísticas', async () => {
    const old = await version(request)
    for (const delay of [10, 20, 30, 45, 60]) {
      await action(a.user, a.org, request, await version(request), 'delay', delay)
      const { rows: [row] } = await as('anon', null, () => status(a.code, receipt))
      assert.equal(row.status, 'delayed')
      assert.equal(row.delay_minutes, delay)
    }
    await assert.rejects(action(a.user, a.org, request, old, 'confirm'), /ya cambió/)
    await action(a.user, a.org, request, await version(request), 'confirm', null, 1200.50)
    assert.equal(await scalar('select count(*)::int from transport_trips'), 1)
    await action(a.user, a.org, request, await version(request), 'delay', 10)
    assert.equal((await as('anon', null, () => status(a.code, receipt))).rows[0].status, 'confirmed')
    await action(a.user, a.org, request, await version(request), 'complete', null, 1500)
    const { rows: [row] } = await as('anon', null, () => status(a.code, receipt))
    assert.equal(row.status, 'completed')
    assert.equal(Number(row.amount), 1500)
    const second = await as('anon', null, () => submit(b.code, code()))
    await action(b.user, b.org, second, await version(second), 'reject')
    const { rows: [stats] } = await as('authenticated', a.user,
      () => db.query('select * from gestok_transport_driver_stats($1)', [a.org]))
    assert.equal(Number(stats.completed), 1)
    assert.equal(Number(stats.rejected), 0)
    assert.equal(Number(stats.total_amount), 1500)
    await as('authenticated', b.user, async () => {
      assert.equal(await scalar('select count(*)::int from transport_trips'), 0)
    })
  })

  await t.test('la suscripción vencida impide nuevas solicitudes y acceso del conductor', async () => {
    await db.query("update subscriptions set status='Vencido' where organization_id=$1", [a.org])
    assert.equal(await as('anon', null, () => scalar('select gestok_transport_public_available($1)', [a.code])), false)
    await assert.rejects(as('anon', null, () => submit(a.code, code())), /desactivadas/)
    assert.equal(await as('authenticated', a.user, () => scalar('select count(*)::int from transport_requests')), 0)
  })
})
