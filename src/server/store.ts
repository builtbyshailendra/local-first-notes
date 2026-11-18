// Durable storage for incident docs, in Node's built-in SQLite (node:sqlite).
//
// Every Yjs update is appended as one row. Loading a room replays its rows.
// Rows pile up (one per keystroke batch), so after `compactAfter` rows the
// room is compacted: all its rows are replaced by a single update holding
// the whole current state. Yjs updates merge in any order, which is what
// makes this safe.

import { DatabaseSync } from 'node:sqlite'

export class Store {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS updates (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL,
        data BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS updates_room ON updates (room, id);
    `)
  }

  load(room: string): Uint8Array[] {
    const rows = this.db.prepare('SELECT data FROM updates WHERE room = ? ORDER BY id').all(room) as { data: Uint8Array }[]
    return rows.map((r) => r.data)
  }

  append(room: string, update: Uint8Array): void {
    this.db.prepare('INSERT INTO updates (room, data) VALUES (?, ?)').run(room, update)
  }

  count(room: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM updates WHERE room = ?').get(room) as { n: number }
    return Number(row.n)
  }

  // Replace a room's rows with one merged update, atomically.
  compact(room: string, merged: Uint8Array): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM updates WHERE room = ?').run(room)
      this.append(room, merged)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  close(): void {
    this.db.close()
  }
}
