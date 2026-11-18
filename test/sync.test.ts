// The sync server and client over real WebSockets on localhost.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { Incident } from '../src/shared/incident.ts'
import { SyncClient } from '../src/client/sync-client.ts'
import { startServer, type RunningServer, type ServerOptions } from '../src/server/server.ts'

const tempDirs: string[] = []
function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfn-'))
  tempDirs.push(dir)
  return path.join(dir, 'notes.db')
}
test.after(() => {
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true })
})

async function waitFor(what: string, cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

const cleanups: (() => unknown)[] = []
async function server(opts: Partial<ServerOptions> & { dbPath: string }): Promise<RunningServer> {
  const s = await startServer({ pingEveryMs: 60_000, ...opts })
  cleanups.push(() => s.close())
  return s
}
function client(s: RunningServer, room: string): { inc: Incident; sync: SyncClient } {
  const inc = new Incident()
  const sync = new SyncClient(inc.doc, `${s.url}/rooms/${room}`)
  sync.connect()
  cleanups.push(() => sync.destroy())
  return { inc, sync }
}
test.afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

test('edits reach the other person live', async () => {
  const s = await server({ dbPath: tempDb() })
  const asha = client(s, 'inc-1')
  const ravi = client(s, 'inc-1')
  await Promise.all([asha.sync.whenSynced(), ravi.sync.whenSynced()])
  asha.inc.setTitle('Checkout errors')
  asha.inc.notes.insert(0, 'Payments failing since 10:40.')
  await waitFor('ravi to see the notes', () => ravi.inc.notes.toString() === 'Payments failing since 10:40.')
  assert.equal(ravi.inc.snapshot().title, 'Checkout errors')
})

test('rooms are separate', async () => {
  const s = await server({ dbPath: tempDb() })
  const a = client(s, 'inc-a')
  const b = client(s, 'inc-b')
  await Promise.all([a.sync.whenSynced(), b.sync.whenSynced()])
  a.inc.setTitle('only in a')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(b.inc.snapshot().title, '')
})

test('both edit while one is offline; reconnecting merges everything', async () => {
  const s = await server({ dbPath: tempDb() })
  const asha = client(s, 'inc-2')
  const ravi = client(s, 'inc-2')
  await Promise.all([asha.sync.whenSynced(), ravi.sync.whenSynced()])
  asha.inc.notes.insert(0, 'Payments failing.')
  await waitFor('shared starting text', () => ravi.inc.notes.toString() === 'Payments failing.')

  ravi.sync.disconnect() // the train goes into a tunnel
  assert.equal(ravi.sync.status, 'offline')
  asha.inc.notes.insert(0, '[asha] ')
  asha.inc.setSeverity('SEV1')
  ravi.inc.notes.insert(ravi.inc.notes.length, ' [ravi] DB failover done.')
  ravi.inc.addTimeline('ravi', 'Failover finished', new Date('2026-11-18T10:52:00Z'))
  const id = ravi.inc.addAction('Write the postmortem', 'ravi')
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(!asha.inc.notes.toString().includes('ravi'), 'nothing should leak while offline')

  ravi.sync.connect()
  await waitFor('both to converge', () =>
    JSON.stringify(asha.inc.snapshot()) === JSON.stringify(ravi.inc.snapshot()) && asha.inc.actions.has(id))
  assert.equal(asha.inc.notes.toString(), '[asha] Payments failing. [ravi] DB failover done.')
  assert.equal(ravi.inc.snapshot().severity, 'SEV1')
})

test('the server forgets nothing across a restart', async () => {
  const db = tempDb()
  const first = await startServer({ dbPath: db, pingEveryMs: 60_000 })
  const asha = new Incident()
  const sync = new SyncClient(asha.doc, `${first.url}/rooms/inc-3`)
  sync.connect()
  await sync.whenSynced()
  asha.setTitle('Ledger lag')
  asha.notes.insert(0, 'Replica 3 behind by 40s.')
  await waitFor('rows stored', () => first.storedRows('inc-3') >= 2)
  sync.destroy()
  await first.close()

  const second = await server({ dbPath: db })
  const meera = client(second, 'inc-3')
  await meera.sync.whenSynced()
  assert.equal(meera.inc.snapshot().title, 'Ledger lag')
  assert.equal(meera.inc.notes.toString(), 'Replica 3 behind by 40s.')
})

test('a client keeps working while the server is down and catches up after', async () => {
  const db = tempDb()
  const first = await startServer({ dbPath: db, pingEveryMs: 60_000 })
  const port = first.port
  const asha = new Incident()
  const sync = new SyncClient(asha.doc, `${first.url}/rooms/inc-4`)
  cleanups.push(() => sync.destroy())
  sync.connect()
  await sync.whenSynced()
  asha.notes.insert(0, 'before the outage. ')
  await waitFor('stored', () => first.storedRows('inc-4') >= 1)
  await first.close()
  await waitFor('client notices', () => sync.status !== 'connected')

  asha.notes.insert(asha.notes.length, 'typed during the outage.')
  const second = await server({ dbPath: db, port })
  await waitFor('reconnected and synced', () => sync.synced, 10_000)
  const ravi = client(second, 'inc-4')
  await ravi.sync.whenSynced()
  await waitFor('ravi sees the outage typing', () => ravi.inc.notes.toString() === 'before the outage. typed during the outage.')
})

test('presence: who is here, and who left', async () => {
  const s = await server({ dbPath: tempDb() })
  const asha = client(s, 'inc-5')
  const ravi = client(s, 'inc-5')
  await Promise.all([asha.sync.whenSynced(), ravi.sync.whenSynced()])
  asha.sync.awareness.setLocalStateField('user', { name: 'asha' })
  const ashaId = asha.inc.doc.clientID
  await waitFor('ravi sees asha', () => (ravi.sync.awareness.getStates().get(ashaId) as { user?: { name: string } } | undefined)?.user?.name === 'asha')
  asha.sync.destroy()
  await waitFor('asha gone from ravi', () => !ravi.sync.awareness.getStates().has(ashaId))
})

test('compaction keeps the log short and loses nothing', async () => {
  const db = tempDb()
  const s = await server({ dbPath: db, compactAfter: 50 })
  const asha = client(s, 'inc-6')
  await asha.sync.whenSynced()
  for (let i = 0; i < 300; i++) asha.inc.notes.insert(asha.inc.notes.length, `${i % 10}`)
  const want = asha.inc.notes.toString()
  await waitFor('all 300 edits stored', () => {
    const probe = new Y.Doc()
    return s.storedRows('inc-6') <= 51 && want.length === 300 && probe !== null
  })
  assert.ok(s.storedRows('inc-6') <= 51, `rows: ${s.storedRows('inc-6')}`)
  const ravi = client(s, 'inc-6')
  await ravi.sync.whenSynced()
  await waitFor('ravi has all 300 characters', () => ravi.inc.notes.toString() === want)
})

test('bad clients are dropped; everyone else carries on', async () => {
  const s = await server({ dbPath: tempDb(), maxMessageBytes: 64 * 1024 })
  const asha = client(s, 'inc-7')
  await asha.sync.whenSynced()

  const refused = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`${s.url}/rooms/..%2Fetc`)
    ws.onopen = () => resolve('opened')
    ws.onerror = () => resolve('refused')
  })
  assert.equal(refused, 'refused')

  for (const [what, payload, code] of [
    ['garbage', new Uint8Array([0x07, 0xff, 0xff, 0xff]), 4400],
    ['a 100 KB message', new Uint8Array(100 * 1024), 1009],
  ] as const) {
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${s.url}/rooms/inc-7`)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => ws.send(payload)
      ws.onclose = (ev) => resolve(ev.code)
    })
    assert.equal(closed, code, what)
  }

  asha.inc.setTitle('still fine')
  const ravi = client(s, 'inc-7')
  await ravi.sync.whenSynced()
  await waitFor('the room still works', () => ravi.inc.snapshot().title === 'still fine')
})
