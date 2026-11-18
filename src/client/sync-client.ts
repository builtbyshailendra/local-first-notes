// A client-side connection to the sync server, for browsers and for Node
// (which has a built-in WebSocket client since Node 22).
//
// It never blocks editing. The doc is always editable; while the connection
// is down, changes simply stay in the doc. On reconnect both sides swap state
// vectors and send each other only what the other is missing, so offline
// edits merge in without any special "offline queue".

import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { MSG_AWARENESS, MSG_SYNC } from '../shared/protocol.ts'

export type Status = 'connecting' | 'connected' | 'offline'

export class SyncClient {
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  readonly url: string
  status: Status = 'offline'
  synced = false
  private ws: WebSocket | null = null
  private wanted = false
  private backoffMs = 250
  private retry: ReturnType<typeof setTimeout> | null = null
  private statusListeners = new Set<(s: Status) => void>()
  private syncWaiters: (() => void)[] = []
  private ownsAwareness: boolean

  constructor(doc: Y.Doc, url: string, awareness?: awarenessProtocol.Awareness) {
    this.doc = doc
    this.url = url
    this.ownsAwareness = awareness === undefined
    this.awareness = awareness ?? new awarenessProtocol.Awareness(doc)
    doc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
  }

  connect(): void {
    this.wanted = true
    if (!this.ws) this.open()
  }

  // Go offline on purpose (the UI's "work offline" switch, and the tests).
  disconnect(): void {
    this.wanted = false
    if (this.retry) clearTimeout(this.retry)
    this.ws?.close()
    this.ws = null
    this.goneOffline()
  }

  destroy(): void {
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'local')
    this.disconnect()
    this.doc.off('update', this.onDocUpdate)
    this.awareness.off('update', this.onAwarenessUpdate)
    // Awareness runs a repeating timer to expire stale presence. Left
    // running, it keeps a Node process alive forever (the tests hung on it).
    if (this.ownsAwareness) this.awareness.destroy()
  }

  onStatus(fn: (s: Status) => void): () => void {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  whenSynced(): Promise<void> {
    return this.synced ? Promise.resolve() : new Promise((resolve) => this.syncWaiters.push(resolve))
  }

  private setStatus(s: Status): void {
    this.status = s
    for (const fn of this.statusListeners) fn(s)
  }

  private open(): void {
    this.setStatus('connecting')
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.backoffMs = 250
      this.setStatus('connected')
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.writeSyncStep1(enc, this.doc)
      ws.send(encoding.toUint8Array(enc))
      if (this.awareness.getLocalState() !== null) this.sendAwareness([this.doc.clientID])
    }
    ws.onmessage = (ev: MessageEvent) => this.onMessage(new Uint8Array(ev.data as ArrayBuffer))
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.goneOffline()
      if (this.wanted) {
        // Back off, with jitter, so a restarted server isn't hit by everyone at once.
        const wait = this.backoffMs * (0.5 + Math.random())
        this.backoffMs = Math.min(this.backoffMs * 2, 5000)
        this.retry = setTimeout(() => { if (this.wanted && !this.ws) this.open() }, wait)
      }
    }
  }

  private goneOffline(): void {
    this.synced = false
    // Other people's presence is stale once we can't hear from them.
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID)
    awarenessProtocol.removeAwarenessStates(this.awareness, others, this)
    this.setStatus('offline')
  }

  private onMessage(buf: Uint8Array): void {
    const dec = decoding.createDecoder(buf)
    const type = decoding.readVarUint(dec)
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      const step = syncProtocol.readSyncMessage(dec, enc, this.doc, this)
      if (encoding.length(enc) > 1) this.ws?.send(encoding.toUint8Array(enc))
      if (step === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true
        for (const resolve of this.syncWaiters.splice(0)) resolve()
      }
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this)
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this || this.ws?.readyState !== WebSocket.OPEN) return // offline: the next handshake carries it
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeUpdate(enc, update)
    this.ws.send(encoding.toUint8Array(enc))
  }

  private onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown): void => {
    if (origin !== 'local') return
    this.sendAwareness([...added, ...updated, ...removed])
  }

  private sendAwareness(clients: number[]): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_AWARENESS)
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients))
    this.ws.send(encoding.toUint8Array(enc))
  }
}
