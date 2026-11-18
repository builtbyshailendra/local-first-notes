// The incident document: one Yjs doc per incident, shared by everyone
// working on it. Yjs types are CRDTs: every replica can change them offline,
// and merging the changes in any order gives the same result everywhere.
//
// How the data is nested decides what happens when two people change the
// same thing at the same time, so each part is chosen on purpose:
//
//   meta      Y.Map    title, severity, status. Two concurrent writes to one
//                      key: one wins, the same one on every replica.
//   notes     Y.Text   free text. Concurrent typing is interleaved, nothing lost.
//   timeline  Y.Array  append-only entries. Concurrent appends are all kept.
//   actions   Y.Map of Y.Map  one map per action item, so one person ticking
//                      "done" and another changing the owner both survive.

import * as Y from 'yjs'

export const SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const
export const STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const
export type Severity = (typeof SEVERITIES)[number]
export type Status = (typeof STATUSES)[number]

export interface TimelineEntry {
  id: string
  at: string // ISO time, from the author's clock
  author: string
  text: string
}

export interface ActionItem {
  id: string
  text: string
  owner: string
  done: boolean
}

export interface Snapshot {
  title: string
  severity: Severity | ''
  status: Status | ''
  notes: string
  timeline: TimelineEntry[]
  actions: ActionItem[]
}

const newId = (): string => globalThis.crypto.randomUUID()

export class Incident {
  readonly doc: Y.Doc

  constructor(doc?: Y.Doc) {
    this.doc = doc ?? new Y.Doc()
  }

  get meta(): Y.Map<string> {
    return this.doc.getMap<string>('meta')
  }
  get notes(): Y.Text {
    return this.doc.getText('notes')
  }
  get timeline(): Y.Array<TimelineEntry> {
    return this.doc.getArray<TimelineEntry>('timeline')
  }
  get actions(): Y.Map<Y.Map<unknown>> {
    return this.doc.getMap<Y.Map<unknown>>('actions')
  }

  setTitle(title: string): void {
    this.meta.set('title', title)
  }

  setSeverity(s: Severity): void {
    if (!SEVERITIES.includes(s)) throw new Error(`unknown severity ${s}`)
    this.meta.set('severity', s)
  }

  setStatus(s: Status): void {
    if (!STATUSES.includes(s)) throw new Error(`unknown status ${s}`)
    this.meta.set('status', s)
  }

  addTimeline(author: string, text: string, at: Date = new Date()): string {
    const id = newId()
    this.timeline.push([{ id, at: at.toISOString(), author, text }])
    return id
  }

  addAction(text: string, owner = ''): string {
    const id = newId()
    const item = new Y.Map<unknown>()
    // One transaction: other replicas never see a half-made item.
    this.doc.transact(() => {
      item.set('text', text)
      item.set('owner', owner)
      item.set('done', false)
      this.actions.set(id, item)
    })
    return id
  }

  setActionDone(id: string, done: boolean): void {
    this.actions.get(id)?.set('done', done)
  }

  setActionOwner(id: string, owner: string): void {
    this.actions.get(id)?.set('owner', owner)
  }

  removeAction(id: string): void {
    this.actions.delete(id)
  }

  // A plain-JSON view. The timeline is sorted by time, then id: replicas may
  // have appended in different orders, but every replica shows the same list.
  snapshot(): Snapshot {
    const timeline = this.timeline.toArray().slice()
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    const actions: ActionItem[] = []
    for (const [id, m] of this.actions.entries()) {
      actions.push({ id, text: String(m.get('text') ?? ''), owner: String(m.get('owner') ?? ''), done: m.get('done') === true })
    }
    actions.sort((a, b) => a.id.localeCompare(b.id))
    return {
      title: this.meta.get('title') ?? '',
      severity: (this.meta.get('severity') ?? '') as Severity | '',
      status: (this.meta.get('status') ?? '') as Status | '',
      notes: this.notes.toString(),
      timeline,
      actions,
    }
  }
}

// Exchange whatever each side is missing, using state vectors (a summary of
// what a replica has seen) so only the difference travels.
export function syncPair(a: Y.Doc, b: Y.Doc): void {
  const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))
  const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))
  Y.applyUpdate(b, toB)
  Y.applyUpdate(a, toA)
}
