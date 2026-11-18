// The sync server. It isn't the source of truth in the usual sense: every
// client holds the full document and can work without it. The server is a
// peer that is always online: it relays updates between clients, remembers
// them in SQLite so a client that was away can catch up, and passes presence
// (who's here) around.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { Store } from './store.ts'
import { MSG_AWARENESS, MSG_SYNC, ROOM_PATTERN } from '../shared/protocol.ts'

export interface ServerOptions {
  port?: number // 0 picks a free port
  host?: string
  dbPath: string
  staticDir?: string // serve the built web app from here
  compactAfter?: number // rows per room before compacting (default 500)
  maxMessageBytes?: number // larger WebSocket messages close the connection (default 1 MiB)
  pingEveryMs?: number // drop connections that stop answering pings (default 30 s)
}

interface Room {
  name: string
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  conns: Map<WebSocket, Set<number>> // each connection -> the awareness client IDs it speaks for
}

export interface RunningServer {
  url: string
  port: number
  rooms(): string[]
  storedRows(room: string): number
  close(): Promise<void>
}

const STORE = Symbol('store') // origin for updates replayed from SQLite

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const store = new Store(opts.dbPath)
  const compactAfter = opts.compactAfter ?? 500
  const rooms = new Map<string, Room>()

  const send = (ws: WebSocket, msg: Uint8Array): void => {
    if (ws.readyState === ws.OPEN) ws.send(msg)
  }

  function openRoom(name: string): Room {
    const existing = rooms.get(name)
    if (existing) return existing
    const doc = new Y.Doc({ gc: true })
    for (const u of store.load(name)) Y.applyUpdate(doc, u, STORE)
    const awareness = new awarenessProtocol.Awareness(doc)
    awareness.setLocalState(null) // the server isn't a person in the room
    const room: Room = { name, doc, awareness, conns: new Map() }

    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === STORE) return
      store.append(name, update)
      if (store.count(name) > compactAfter) store.compact(name, Y.encodeStateAsUpdate(doc))
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.writeUpdate(enc, update)
      const msg = encoding.toUint8Array(enc)
      for (const ws of room.conns.keys()) if (ws !== origin) send(ws, msg)
    })

    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const owned = room.conns.get(origin as WebSocket)
      if (owned) {
        for (const id of added) owned.add(id)
        for (const id of removed) owned.delete(id)
      }
      const changed = [...added, ...updated, ...removed]
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_AWARENESS)
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed))
      const msg = encoding.toUint8Array(enc)
      for (const ws of room.conns.keys()) send(ws, msg)
    })

    rooms.set(name, room)
    return room
  }

  function closeRoomIfEmpty(room: Room): void {
    if (room.conns.size > 0) return
    room.awareness.destroy()
    room.doc.destroy() // its state is in SQLite; load again on the next connection
    rooms.delete(room.name)
  }

  function join(ws: WebSocket, room: Room): void {
    room.conns.set(ws, new Set())
    // Without this, a client sending an oversized frame crashes the whole
    // server: ws emits 'error', and an unhandled 'error' event throws. The
    // first test run found exactly that. ws has already started closing the
    // socket with the right code (1009 for too big), so there's nothing more
    // to do; terminating here (the second attempt) cut that close frame off.
    ws.on('error', () => {})
    ;(ws as WebSocket & { alive?: boolean }).alive = true
    ws.on('pong', () => { (ws as WebSocket & { alive?: boolean }).alive = true })

    ws.on('message', (data: RawData) => {
      try {
        const buf = data instanceof ArrayBuffer ? new Uint8Array(data)
          : Array.isArray(data) ? new Uint8Array(Buffer.concat(data)) : new Uint8Array(data)
        const dec = decoding.createDecoder(buf)
        const type = decoding.readVarUint(dec)
        if (type === MSG_SYNC) {
          const enc = encoding.createEncoder()
          encoding.writeVarUint(enc, MSG_SYNC)
          syncProtocol.readSyncMessage(dec, enc, room.doc, ws)
          if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc))
        } else if (type === MSG_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(dec), ws)
        } else {
          throw new Error(`unknown message type ${type}`)
        }
      } catch {
        // A message we can't read: drop this client, keep everyone else.
        ws.close(4400, 'malformed message')
      }
    })

    ws.on('close', () => {
      const owned = room.conns.get(ws)
      room.conns.delete(ws)
      if (owned && owned.size > 0) awarenessProtocol.removeAwarenessStates(room.awareness, [...owned], null)
      closeRoomIfEmpty(room)
    })

    // Start the handshake: our state vector, then everyone's presence.
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeSyncStep1(enc, room.doc)
    send(ws, encoding.toUint8Array(enc))
    const others = [...room.awareness.getStates().keys()]
    if (others.length > 0) {
      const a = encoding.createEncoder()
      encoding.writeVarUint(a, MSG_AWARENESS)
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(room.awareness, others))
      send(ws, encoding.toUint8Array(a))
    }
  }

  const httpServer = http.createServer((req, res) => serveStatic(opts.staticDir, req, res))
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxMessageBytes ?? 1 << 20 })

  httpServer.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const name = /^\/rooms\/([^/?]+)/.exec(req.url ?? '')?.[1]
    if (!name || !ROOM_PATTERN.test(name)) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => join(ws, openRoom(name)))
  })

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      const w = ws as WebSocket & { alive?: boolean }
      if (w.alive === false) { w.terminate(); continue }
      w.alive = false
      w.ping()
    }
  }, opts.pingEveryMs ?? 30_000)

  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve))
  const port = (httpServer.address() as { port: number }).port

  return {
    url: `ws://${opts.host ?? '127.0.0.1'}:${port}`,
    port,
    rooms: () => [...rooms.keys()],
    storedRows: (room) => store.count(room),
    close: async () => {
      clearInterval(pinger)
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      for (const room of [...rooms.values()]) { room.conns.clear(); closeRoomIfEmpty(room) }
      store.close()
    },
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon',
}

function serveStatic(dir: string | undefined, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/healthz') { res.end('ok\n'); return }
  if (!dir || req.method !== 'GET') { res.writeHead(404).end(); return }
  const root = path.resolve(dir)
  const rel = url.pathname === '/' || url.pathname.startsWith('/incident/') ? 'index.html' : decodeURIComponent(url.pathname)
  const file = path.resolve(root, '.' + path.posix.normalize('/' + rel))
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return } // no ../ escapes
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body)
  })
}
