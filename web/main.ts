// The browser app. Everything reads from and writes to the Yjs doc; the
// network and IndexedDB just keep copies of that doc in step. The page never
// waits for the server: with no connection you can still do everything.

import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { Incident, SEVERITIES, STATUSES, type Severity, type Status } from '../src/shared/incident.ts'
import { SyncClient } from '../src/client/sync-client.ts'
import { ROOM_PATTERN } from '../src/shared/protocol.ts'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K]
  node.append(...kids) // text goes in as text nodes: nothing anyone types becomes HTML
  return node
}

// --- who am I -----------------------------------------------------------------
const nameInput = $<HTMLInputElement>('name')
const storedName = (() => { try { return localStorage.getItem('lfn-name') } catch { return null } })()
let myName = storedName || `responder-${Math.floor(Math.random() * 9000 + 1000)}`
// Keep a generated name too, or every reload makes you a new person.
try { if (!storedName) localStorage.setItem('lfn-name', myName) } catch { /* private mode: fine */ }
nameInput.value = myName
const myColor = `hsl(${Math.floor(Math.random() * 360)} 55% 42%)`

// --- which incident -----------------------------------------------------------
const room = /^\/incident\/([^/]+)/.exec(location.pathname)?.[1] ?? ''
if (!ROOM_PATTERN.test(room)) {
  $('home').hidden = false
  $('status').hidden = true
  $<HTMLFormElement>('open').addEventListener('submit', (e) => {
    e.preventDefault()
    location.href = `/incident/${$<HTMLInputElement>('open-id').value}`
  })
} else {
  start(room)
}

function start(room: string): void {
  $('app').hidden = false
  $('room').textContent = room
  document.title = `${room} · incident notes`

  const inc = new Incident(new Y.Doc())
  const local = new IndexeddbPersistence(`lfn-${room}`, inc.doc)
  local.on('synced', () => { $('saved').textContent = 'saved in this browser' })

  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const sync = new SyncClient(inc.doc, `${scheme}://${location.host}/rooms/${room}`)
  sync.awareness.setLocalStateField('user', { name: myName, color: myColor })
  sync.onStatus((s) => {
    const badge = $('status')
    badge.dataset.status = s
    badge.textContent = s
  })
  sync.connect()

  nameInput.addEventListener('change', () => {
    myName = nameInput.value.trim() || myName
    try { localStorage.setItem('lfn-name', myName) } catch { /* private mode: fine */ }
    sync.awareness.setLocalStateField('user', { name: myName, color: myColor })
  })

  $<HTMLInputElement>('offline').addEventListener('change', (e) => {
    if ((e.target as HTMLInputElement).checked) sync.disconnect()
    else sync.connect()
  })

  // --- presence -----------------------------------------------------------------
  const renderPeople = (): void => {
    const people = [...sync.awareness.getStates().entries()]
      .map(([id, s]) => ({ id, user: (s as { user?: { name: string; color: string } }).user }))
      .filter((p) => p.user)
    $('people').replaceChildren(...people.map((p) => {
      const chip = el('li', {}, p.user!.name + (p.id === inc.doc.clientID ? ' (you)' : ''))
      chip.style.background = p.user!.color
      return chip
    }))
  }
  sync.awareness.on('change', renderPeople)
  renderPeople()

  // --- meta -----------------------------------------------------------------------
  const title = $<HTMLInputElement>('title')
  const severity = $<HTMLSelectElement>('severity')
  const status = $<HTMLSelectElement>('status-select')
  severity.replaceChildren(el('option', { value: '' }, '–'), ...SEVERITIES.map((s) => el('option', { value: s }, s)))
  status.replaceChildren(el('option', { value: '' }, '–'), ...STATUSES.map((s) => el('option', { value: s }, s)))
  title.addEventListener('input', () => inc.setTitle(title.value))
  severity.addEventListener('change', () => severity.value && inc.setSeverity(severity.value as Severity))
  status.addEventListener('change', () => status.value && inc.setStatus(status.value as Status))
  const renderMeta = (): void => {
    const snap = inc.snapshot()
    if (document.activeElement !== title) title.value = snap.title
    severity.value = snap.severity
    status.value = snap.status
  }
  inc.meta.observe(renderMeta)

  // --- notes: a plain textarea kept in step with a Y.Text ----------------------
  bindTextarea($<HTMLTextAreaElement>('notes'), inc.notes)

  // --- timeline ---------------------------------------------------------------------
  const renderTimeline = (): void => {
    $('timeline').replaceChildren(...inc.snapshot().timeline.map((e) =>
      el('li', {}, el('time', { dateTime: e.at }, new Date(e.at).toLocaleTimeString()), el('span', { className: 'who' }, e.author), e.text)))
  }
  inc.timeline.observe(renderTimeline)
  $<HTMLFormElement>('add-entry').addEventListener('submit', (e) => {
    e.preventDefault()
    const input = $<HTMLInputElement>('entry-text')
    inc.addTimeline(myName, input.value.trim())
    input.value = ''
  })

  // --- action items -----------------------------------------------------------------
  const actionsList = $('actions')
  let actionsDirty = false
  const renderActions = (): void => {
    // Don't rebuild the list under someone's cursor; catch up when they leave it.
    if (actionsList.contains(document.activeElement)) { actionsDirty = true; return }
    actionsDirty = false
    actionsList.replaceChildren(...inc.snapshot().actions.map((a) => {
      const done = el('input', { type: 'checkbox', checked: a.done, title: 'done' })
      done.addEventListener('change', () => inc.setActionDone(a.id, done.checked))
      const owner = el('input', { value: a.owner, placeholder: 'owner', size: 10, maxLength: 24 })
      owner.addEventListener('change', () => inc.setActionOwner(a.id, owner.value.trim()))
      const del = el('button', { className: 'del', type: 'button', title: 'remove' }, '×')
      del.addEventListener('click', () => inc.removeAction(a.id))
      return el('li', { className: a.done ? 'done' : '' }, done, el('span', { className: 'text' }, a.text), owner, del)
    }))
  }
  actionsList.addEventListener('focusout', () => setTimeout(() => { if (actionsDirty) renderActions() }))
  inc.actions.observeDeep(renderActions)
  $<HTMLFormElement>('add-action').addEventListener('submit', (e) => {
    e.preventDefault()
    const text = $<HTMLInputElement>('action-text')
    const owner = $<HTMLInputElement>('action-owner')
    inc.addAction(text.value.trim(), owner.value.trim())
    text.value = ''
    owner.value = ''
  })

  renderMeta()
  renderTimeline()
  renderActions()
  ;(window as unknown as { incident: Incident; sync: SyncClient }).incident = inc // for poking at in devtools
  ;(window as unknown as { incident: Incident; sync: SyncClient }).sync = sync
}

// Keeps a textarea and a Y.Text equal. Local typing becomes the smallest
// delete+insert that turns the old text into the new; remote changes are
// applied while moving the caret by however much text arrived before it.
function bindTextarea(area: HTMLTextAreaElement, text: Y.Text): void {
  const LOCAL = Symbol('textarea')
  area.value = text.toString()
  area.addEventListener('input', () => {
    const before = text.toString()
    const after = area.value
    let start = 0
    while (start < before.length && start < after.length && before[start] === after[start]) start++
    let endBefore = before.length
    let endAfter = after.length
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter-- }
    text.doc!.transact(() => {
      if (endBefore > start) text.delete(start, endBefore - start)
      if (endAfter > start) text.insert(start, after.slice(start, endAfter))
    }, LOCAL)
  })
  text.observe((event, tr) => {
    if (tr.origin === LOCAL) return
    let { selectionStart: s, selectionEnd: e } = area
    let pos = 0
    for (const d of event.delta) {
      if (d.retain) pos += d.retain
      else if (typeof d.insert === 'string') {
        if (pos < s) s += d.insert.length
        if (pos < e) e += d.insert.length
        pos += d.insert.length
      } else if (d.delete) {
        if (pos < s) s -= Math.min(d.delete, s - pos)
        if (pos < e) e -= Math.min(d.delete, e - pos)
      }
    }
    area.value = text.toString()
    if (document.activeElement === area) area.setSelectionRange(s, e)
  })
}
