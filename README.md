# local-first-notes

Incident notes that keep working offline and merge everyone's edits without conflicts. Each incident is a [Yjs](https://yjs.dev) document: a set of CRDTs (conflict-free replicated data types) that every responder's browser holds a full copy of.

Status: built step by step, locally. Not published.

## Build log

### Step 1: the incident document and why it always converges

`src/shared/incident.ts` models one incident as a Yjs doc. How the data is nested decides what happens when two people change the same thing at once:

| Part | Yjs type | When two people edit it at the same time |
|---|---|---|
| title, severity, status | `Y.Map` | one value wins, the **same one** on every replica |
| notes | `Y.Text` | both edits kept, interleaved the same way everywhere |
| timeline | `Y.Array` | every entry kept; shown sorted by time, then id |
| action items | `Y.Map` of `Y.Map` | one person ticking "done" and another reassigning: **both** survive, because each field is its own register |

Tests (Node's built-in test runner, running the TypeScript directly; Node 26 strips the types itself, no build step):
- typing in different places and at the same spot; two severities set at once; tick vs reassign; delete vs a concurrent edit (delete wins); three people adding timeline entries offline; the same updates applied twice and in reverse order (no change: merging is idempotent and commutative).
- **A property test** ([fast-check](https://fast-check.dev)): 500 random histories of edits on three replicas, synced in random partial orders, must end with all three identical. It ran in about 0.3 s.

Checking the property test can fail: with the sync made one-way on purpose, it failed at once.

Type-checked with TypeScript 7.0 (the compiler rewritten in Go): `npx tsc --noEmit`.

What broke: nothing on the first run.
