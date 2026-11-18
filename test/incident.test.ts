// Two or three replicas edit while "offline" (no syncing), then merge.
// Every test ends with all replicas showing exactly the same incident.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import fc from 'fast-check'
import { Incident, SEVERITIES, STATUSES, syncPair } from '../src/shared/incident.ts'

function replicas(n: number): Incident[] {
  const base = new Incident()
  base.setTitle('Checkout errors')
  base.notes.insert(0, 'Customer reports of failed payments.')
  const update = Y.encodeStateAsUpdate(base.doc)
  return Array.from({ length: n }, () => {
    const r = new Incident()
    Y.applyUpdate(r.doc, update)
    return r
  })
}

test('concurrent typing in different places keeps both edits', () => {
  const [asha, ravi] = replicas(2)
  asha.notes.insert(0, '[asha] ')
  ravi.notes.insert(ravi.notes.length, ' [ravi] DB failover at 10:42.')
  syncPair(asha.doc, ravi.doc)
  assert.equal(asha.notes.toString(), '[asha] Customer reports of failed payments. [ravi] DB failover at 10:42.')
  assert.deepEqual(asha.snapshot(), ravi.snapshot())
})

test('concurrent typing at the same spot keeps both, in the same order everywhere', () => {
  const [asha, ravi] = replicas(2)
  asha.notes.insert(0, 'AAA ')
  ravi.notes.insert(0, 'BBB ')
  syncPair(asha.doc, ravi.doc)
  const merged = asha.notes.toString()
  assert.ok(merged.includes('AAA ') && merged.includes('BBB '))
  assert.equal(ravi.notes.toString(), merged)
})

test('two people set the severity at once: one wins, the same one everywhere', () => {
  const [asha, ravi] = replicas(2)
  asha.setSeverity('SEV1')
  ravi.setSeverity('SEV3')
  syncPair(asha.doc, ravi.doc)
  const s = asha.snapshot().severity
  assert.ok(s === 'SEV1' || s === 'SEV3')
  assert.equal(ravi.snapshot().severity, s)
  // Note what this means: a CRDT guarantees agreement, not the "right"
  // answer. For severity, "highest wins" might be the better rule; that's
  // application logic on top (see LEARN.md).
})

test('one person ticks an action done while another reassigns it: both stick', () => {
  const [asha, ravi] = replicas(2)
  const id = asha.addAction('Roll back payments-api', 'asha')
  syncPair(asha.doc, ravi.doc)
  asha.setActionDone(id, true)
  ravi.setActionOwner(id, 'ravi')
  syncPair(asha.doc, ravi.doc)
  assert.deepEqual(asha.snapshot().actions.map(({ owner, done }) => ({ owner, done })), [{ owner: 'ravi', done: true }])
  assert.deepEqual(asha.snapshot(), ravi.snapshot())
})

test('delete beats a concurrent edit of the deleted item', () => {
  const [asha, ravi] = replicas(2)
  const id = asha.addAction('Page the DBA')
  syncPair(asha.doc, ravi.doc)
  asha.removeAction(id)
  ravi.setActionOwner(id, 'ravi')
  syncPair(asha.doc, ravi.doc)
  assert.deepEqual(asha.snapshot().actions, [])
  assert.deepEqual(ravi.snapshot().actions, [])
})

test('timeline entries written offline by three people all survive, in one order', () => {
  const [a, b, c] = replicas(3)
  a.addTimeline('asha', 'Alert fired', new Date('2026-11-18T10:40:00Z'))
  b.addTimeline('ravi', 'Failover started', new Date('2026-11-18T10:42:00Z'))
  c.addTimeline('meera', 'Customers notified', new Date('2026-11-18T10:41:00Z'))
  syncPair(a.doc, b.doc)
  syncPair(b.doc, c.doc)
  syncPair(a.doc, c.doc)
  const texts = a.snapshot().timeline.map((e) => e.text)
  assert.deepEqual(texts, ['Alert fired', 'Customers notified', 'Failover started'])
  assert.deepEqual(a.snapshot(), b.snapshot())
  assert.deepEqual(b.snapshot(), c.snapshot())
})

test('applying the same update twice, or out of order, changes nothing', () => {
  const [asha, ravi] = replicas(2)
  const updates: Uint8Array[] = []
  asha.doc.on('update', (u: Uint8Array) => updates.push(u))
  asha.notes.insert(0, 'one ')
  asha.notes.insert(0, 'two ')
  asha.setStatus('identified')
  for (const u of [...updates].reverse()) Y.applyUpdate(ravi.doc, u) // newest first
  for (const u of updates) Y.applyUpdate(ravi.doc, u) // and again
  assert.deepEqual(ravi.snapshot(), asha.snapshot())
})

// The property behind all of the above, checked on random histories: any
// edits on any replicas, synced in any order, end with every replica equal.
const op = fc.oneof(
  fc.record({ kind: fc.constant('type' as const), pos: fc.nat(60), text: fc.string({ maxLength: 6 }) }),
  fc.record({ kind: fc.constant('cut' as const), pos: fc.nat(60), len: fc.integer({ min: 1, max: 5 }) }),
  fc.record({ kind: fc.constant('severity' as const), value: fc.constantFrom(...SEVERITIES) }),
  fc.record({ kind: fc.constant('status' as const), value: fc.constantFrom(...STATUSES) }),
  fc.record({ kind: fc.constant('timeline' as const), text: fc.string({ maxLength: 8 }) }),
  fc.record({ kind: fc.constant('action' as const), text: fc.string({ maxLength: 8 }) }),
  fc.record({ kind: fc.constant('tick' as const), pick: fc.nat(10) }),
  fc.record({ kind: fc.constant('drop' as const), pick: fc.nat(10) }),
)
type Op = typeof op extends fc.Arbitrary<infer T> ? T : never

function apply(r: Incident, o: Op, clock: number): void {
  const ids = [...r.actions.keys()].sort()
  switch (o.kind) {
    case 'type': r.notes.insert(Math.min(o.pos, r.notes.length), o.text); break
    case 'cut': {
      const at = Math.min(o.pos, r.notes.length)
      r.notes.delete(at, Math.min(o.len, r.notes.length - at))
      break
    }
    case 'severity': r.setSeverity(o.value); break
    case 'status': r.setStatus(o.value); break
    case 'timeline': r.addTimeline('x', o.text, new Date(Date.UTC(2026, 10, 18, 10, 0, clock))); break
    case 'action': r.addAction(o.text); break
    case 'tick': if (ids.length) r.setActionDone(ids[o.pick % ids.length], true); break
    case 'drop': if (ids.length) r.removeAction(ids[o.pick % ids.length]); break
  }
}

test('property: any edits, synced in any order, converge (strong eventual consistency)', () => {
  fc.assert(
    fc.property(
      fc.array(fc.record({ who: fc.nat(2), op, syncWith: fc.option(fc.nat(2), { nil: undefined }) }), { maxLength: 40 }),
      fc.array(fc.tuple(fc.nat(2), fc.nat(2)), { maxLength: 6 }),
      (steps, finalOrder) => {
        const rs = replicas(3)
        steps.forEach((s, i) => {
          apply(rs[s.who], s.op, i)
          if (s.syncWith !== undefined && s.syncWith !== s.who) syncPair(rs[s.who].doc, rs[s.syncWith].doc)
        })
        // Partial syncs in a random order, then enough to reach everyone.
        for (const [x, y] of finalOrder) if (x !== y) syncPair(rs[x].doc, rs[y].doc)
        syncPair(rs[0].doc, rs[1].doc)
        syncPair(rs[1].doc, rs[2].doc)
        syncPair(rs[0].doc, rs[2].doc)
        assert.deepEqual(rs[1].snapshot(), rs[0].snapshot())
        assert.deepEqual(rs[2].snapshot(), rs[0].snapshot())
      },
    ),
    { numRuns: 500 },
  )
})
