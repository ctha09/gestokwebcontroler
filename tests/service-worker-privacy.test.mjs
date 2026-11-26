import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8')

test('Las consultas privadas y Supabase quedan fuera de la caché del PWA', async () => {
  const handlers = {}
  const calls = []
  runInNewContext(source, {
    URL, Response, self: { addEventListener: (name, listener) => { handlers[name] = listener } },
    fetch: async (_request, options) => { calls.push(options?.cache); return new Response('fixture') },
    caches: { match: async () => { throw new Error('No se debe leer CacheStorage') },
      open: async () => { throw new Error('No se debe escribir en CacheStorage') } },
  })
  const requests = [
    new Request('https://fixture.supabase.co/rest/v1/transport_requests'),
    new Request('http://127.0.0.1:54321/rest/v1/transport_expenses'),
    new Request('https://gestok.invalid/custom', { headers: { Authorization: 'Bearer fixture' } }),
    new Request('https://gestok.invalid/custom', { headers: { apikey: 'fixture' } }),
  ]
  for (const request of requests) {
    let response
    handlers.fetch({ request, respondWith: result => { response = result } })
    assert.equal(await (await response).text(), 'fixture')
  }
  assert.deepEqual(calls, Array(requests.length).fill('no-store'))
})

test('Los recursos estáticos del sitio conservan su caché', async () => {
  const handlers = {}
  const paths = []
  runInNewContext(source, {
    URL, Response, self: { addEventListener: (name, listener) => { handlers[name] = listener } },
    fetch: async () => { throw new Error('offline') },
    caches: { match: async request => { paths.push(request.url); return new Response('estático') } },
  })
  let response
  const request = new Request('https://gestok.invalid/assets/traslados/transport-v53.js')
  handlers.fetch({ request, respondWith: result => { response = result } })
  assert.equal(await (await response).text(), 'estático')
  assert.deepEqual(paths, [request.url])
})
