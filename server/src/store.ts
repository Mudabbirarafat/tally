/**
 * The server's copy of the log.
 *
 * SQLite through `node:sqlite`, which ships with Node - so this server has
 * no npm dependencies at all. (It is still flagged experimental upstream,
 * which is the one thing to watch on a Node upgrade; the interface used here
 * is small and the swap to another driver would touch this file only.)
 *
 * The server is deliberately dumb. It does not merge, does not resolve
 * conflicts, and does not materialise entries. It appends operations and
 * hands them back in the order it received them. All the reasoning about
 * which edit wins lives in the client, where it has to live anyway for the
 * app to work offline - duplicating it here would mean two implementations
 * that must agree forever.
 */

import { DatabaseSync } from 'node:sqlite';
import { opId, type Op } from './protocol.ts';

export type PushResult = { accepted: number; duplicates: number; cursor: number };
export type PullResult = { ops: Op[]; cursor: number; more: boolean };

export class OpStore {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    // WAL lets readers run while a write is in flight, which matters as soon
    // as two phones sync at once.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ops (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        trip        TEXT    NOT NULL,
        op_id       TEXT    NOT NULL,
        body        TEXT    NOT NULL,
        received_at INTEGER NOT NULL,
        UNIQUE (trip, op_id)
      );
    `);
    // Every pull is "this trip, after this sequence", so that is the index.
    this.db.exec('CREATE INDEX IF NOT EXISTS ops_by_trip_seq ON ops (trip, seq)');
  }

  /**
   * Append operations, ignoring ones already held.
   *
   * Idempotent by the unique constraint rather than by checking first: a
   * read-then-write would race two phones syncing the same operation at the
   * same moment, and the loser would get a constraint error instead of the
   * harmless no-op it should be.
   */
  push(trip: string, ops: readonly Op[], now = Date.now()): PushResult {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO ops (trip, op_id, body, received_at) VALUES (?, ?, ?, ?)',
    );

    let accepted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const op of ops) {
        const result = insert.run(trip, opId(op), JSON.stringify(op), now);
        if (result.changes > 0) accepted += 1;
      }
      this.db.exec('COMMIT');
    } catch (problem) {
      // All or nothing: a half-applied push would leave the client's cursor
      // pointing past operations the server never stored.
      this.db.exec('ROLLBACK');
      throw problem;
    }

    return { accepted, duplicates: ops.length - accepted, cursor: this.cursor(trip) };
  }

  /**
   * Everything after `since`, oldest first, capped.
   *
   * One extra row is read to decide `more` without a second COUNT query, so
   * a client that has been away for a month can page through rather than ask
   * for a response that will not fit in memory.
   */
  pull(trip: string, since: number, limit: number): PullResult {
    const rows = this.db
      .prepare('SELECT seq, body FROM ops WHERE trip = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(trip, since, limit + 1) as { seq: number; body: string }[];

    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;

    return {
      ops: page.map((row) => JSON.parse(row.body) as Op),
      // The cursor is where this page ended, not where the server is: a
      // client that stored the server's latest would skip the rest.
      cursor: page.at(-1)?.seq ?? since,
      more,
    };
  }

  /** The highest sequence this trip has, or 0 when it has nothing. */
  cursor(trip: string): number {
    const row = this.db.prepare('SELECT MAX(seq) AS top FROM ops WHERE trip = ?').get(trip) as
      | { top: number | null }
      | undefined;
    return row?.top ?? 0;
  }

  count(trip: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM ops WHERE trip = ?').get(trip) as {
      n: number;
    };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
