# Learning notes: local-first-notes

## 1. Local-first, in one paragraph

In a normal web app the server holds the data and the browser borrows it; no network, no app. **Local-first** flips that: each device holds a full copy, you edit it instantly, and syncing happens in the background whenever devices can reach each other. That needs a way to merge edits made at the same time on different copies, without asking anyone to resolve conflicts. That's what CRDTs are for.

## 2. CRDTs without the maths

A CRDT is a data type designed so that merging is:
- **commutative**: A then B gives the same as B then A,
- **associative**: how you group merges doesn't matter,
- **idempotent**: applying the same change twice changes nothing.

With those three, any replicas that have seen the same set of changes are identical, whatever order the changes arrived in. That's **strong eventual consistency**, and it's exactly what `test/incident.test.ts`'s property test checks.

How Yjs does it, roughly: every character or item gets a unique ID (client ID + counter) and remembers its neighbours at the time it was inserted. Merging places items by those references, breaking ties by client ID, so every replica computes the same order. Deletes leave a small "tombstone" so a late-arriving edit next to deleted text still knows where it goes.

**What a CRDT doesn't give you:** the *right* answer. Two people setting severity at once: one wins, the same one everywhere, but it might be the lower one. If "highest severity wins" matters, that's application logic on top (see exercise 1). Merging is automatic; meaning isn't.

## 3. Pieces used here

| Piece | Where | One-line idea |
|---|---|---|
| `Y.Map`, `Y.Text`, `Y.Array` | `incident.ts` | last-writer-wins registers, collaborative text, a list |
| nested `Y.Map` | action items | per-field registers, so concurrent edits to different fields both survive |
| `doc.transact` | `addAction` | others never see half an item |
| state vectors | `syncPair`, the protocol | "what I've seen" in a few bytes; the other side sends only the difference |
| `y-protocols/sync` | server and client | step 1 (my state vector) → step 2 (what you're missing) → updates |
| `y-protocols/awareness` | presence | who's here; live-only, never stored |
| `y-indexeddb` | browser | the browser's own durable copy |
| `node:sqlite` | `store.ts` | SQLite built into Node 26; an append-only update log |
| compaction | `store.compact` | replace N updates with one merged update |
| fast-check | property test | random histories, shrunk to a minimal failing case if one fails |
| Node type stripping | everything | `node file.ts` runs TypeScript directly; `erasableSyntaxOnly` keeps it legal |
| TypeScript 7 | `npm run typecheck` | the compiler rewritten in Go; found two errors Vite built past |

## 4. Explain it without notes

1. What does "strong eventual consistency" promise, and what doesn't it promise?
2. Why are action items a map of maps rather than a map of plain objects? What would go wrong with plain objects?
3. Two people type at the same position. What decides the order, and why is it the same everywhere?
4. Walk through the sync handshake when a client reconnects after an hour offline. What's sent each way?
5. Why does the server store updates rather than the document, and why does compaction not lose anything?
6. What crashed the server in Step 2, and why does one unhandled event in Node take down the process?
7. Why did the test process never exit, and why would nobody have noticed in a browser?
8. How does the textarea binding keep your caret in place when someone else types before it?
9. The app survived a server outage but can't be *reloaded* during one. Why, and what would fix it?
10. When is a CRDT the wrong tool? (Think: bank balances, unique usernames, stock levels.)

## 5. Your turn

1. **Highest severity wins:** make concurrent severity changes resolve to the highest. (Hint: store each person's choice in a map keyed by client ID and compute the max when reading.)
2. **Service worker:** cache the app shell so a reload works with the server down. Test it by stopping the server and reloading.
3. **Auth:** give each incident a token and check it during the WebSocket upgrade. What stops someone reusing a token after an incident closes?
4. **History:** use `Y.snapshot` to show the notes as they were at any point in the incident, for the postmortem.
