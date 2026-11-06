/**
 * The ledger as the app holds it: operations on disk, state in memory.
 *
 * Three things here exist because this is a phone and not a server.
 *
 * **The clock is restored before anything is stamped.** The OS kills
 * backgrounded apps routinely. A logical clock that restarts at zero would
 * let edits made after the restart sort before edits made before it, which
 * is a silent data-loss bug that only shows up after a sync.
 *
 * **The device id is generated once and kept.** It is the final tiebreak in
 * the ordering, so a device that forgets it becomes, in effect, a different
 * device - and two replicas could then disagree about the merged result.
 *
 * **Corrupt storage is quarantined, not discarded.** A write cut short by
 * the process dying can leave truncated JSON. Deleting it would be the tidy
 * thing and the wrong one: that blob is the only copy of edits that have not
 * synced. It is moved aside so the app can start, and so the data still
 * exists to be recovered.
 */

import { Clock, parse as parseStamp, type Hlc } from '../sync/hlc';
import {
  balances,
  materialise,
  merge,
  opId,
  settle,
  visible,
  type Entry,
  type FieldName,
  type FieldValue,
  type Op,
  type Transfer,
} from '../sync/ledger';
import type { Storage } from './storage';

const KEYS = {
  ops: 'tally.ops.v1',
  clock: 'tally.clock.v1',
  device: 'tally.device.v1',
  quarantine: 'tally.corrupt.v1',
  /** Operation ids the server has confirmed it holds. */
  acked: 'tally.acked.v1',
  /** How far through the server's sequence this device has read. */
  cursor: 'tally.cursor.v1',
} as const;

export type NewExpense = {
  description: string;
  amountMinor: number;
  payer: string;
  participants: string[];
};

export type OpenOptions = {
  /** Injected in tests; a real install generates one and keeps it. */
  deviceId?: string;
  now?: () => number;
};

export class LedgerStore {
  private ops: Op[] = [];
  private clock!: Clock;
  /**
   * Operation ids the server has confirmed. Anything not in here is the
   * outbox, which means the outbox survives a restart without being stored
   * twice - it is derived from the log rather than kept beside it, so the
   * two can never disagree about what is still owed.
   */
  private acked = new Set<string>();
  private serverCursor = 0;
  private corrupted = false;

  private constructor(private readonly storage: Storage) {}

  static async open(storage: Storage, options: OpenOptions = {}): Promise<LedgerStore> {
    const store = new LedgerStore(storage);
    await store.load(options);
    return store;
  }

  private async load(options: OpenOptions): Promise<void> {
    const device = options.deviceId ?? (await this.deviceId());
    this.clock = new Clock(device, options.now);

    const raw = await this.storage.read(KEYS.ops);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Op[];
        if (!Array.isArray(parsed)) throw new Error('not an array of operations');
        this.ops = merge(parsed, []);
      } catch {
        // Keep it. It is the only copy of anything that never synced.
        await this.storage.write(KEYS.quarantine, raw);
        await this.storage.remove(KEYS.ops);
        this.ops = [];
        this.corrupted = true;
      }
    }

    const savedClock = await this.storage.read(KEYS.clock);
    if (savedClock) {
      try {
        this.clock.restore(parseStamp(savedClock));
      } catch {
        // A damaged clock is recoverable: the operations themselves carry
        // timestamps, so the highest one seen is a safe lower bound.
        for (const op of this.ops) this.clock.observe(op.at);
      }
    }
    // Whatever the stored clock said, never stamp below what is already on
    // disk - restoring from a stale snapshot would otherwise rewind us.
    for (const op of this.ops) this.clock.observe(op.at);

    const acked = await this.storage.read(KEYS.acked);
    if (acked) {
      try {
        const parsed = JSON.parse(acked) as string[];
        if (Array.isArray(parsed)) this.acked = new Set(parsed);
      } catch {
        // Losing this is safe: everything simply looks unsent, and pushing
        // an operation the server already has is a no-op by design.
      }
    }

    const cursor = await this.storage.read(KEYS.cursor);
    const parsedCursor = Number(cursor);
    this.serverCursor = Number.isInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
  }

  private async deviceId(): Promise<string> {
    const existing = await this.storage.read(KEYS.device);
    if (existing) return existing;
    const fresh = `d-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    await this.storage.write(KEYS.device, fresh);
    return fresh;
  }

  /** True when a previous run left unreadable data, which the UI should say. */
  get hadCorruptStorage(): boolean {
    return this.corrupted;
  }

  get device(): string {
    return this.clock.device;
  }

  get entries(): Entry[] {
    return visible(materialise(this.ops));
  }

  get all(): Entry[] {
    return materialise(this.ops);
  }

  /** Operations the server has not confirmed: the outbox. */
  get outbox(): Op[] {
    return this.ops.filter((op) => !this.acked.has(opId(op)));
  }

  get pending(): number {
    return this.outbox.length;
  }

  get cursor(): number {
    return this.serverCursor;
  }

  get log(): Op[] {
    return [...this.ops];
  }

  balances(): Map<string, number> {
    return balances(this.entries);
  }

  settle(): Transfer[] {
    return settle(this.entries);
  }

  async addExpense(expense: NewExpense): Promise<string> {
    if (!Number.isInteger(expense.amountMinor)) {
      throw new Error('amounts are minor units and must be integers');
    }
    const id = `e-${this.clock.device}-${Date.now().toString(36)}-${this.ops.length}`;
    const ops: Op[] = [
      this.field(id, 'description', expense.description),
      this.field(id, 'amountMinor', expense.amountMinor),
      this.field(id, 'payer', expense.payer),
      ...expense.participants.map((person) => this.member(id, person, true)),
    ];
    await this.append(ops);
    return id;
  }

  async editExpense(
    id: string,
    changes: Partial<Pick<NewExpense, 'description' | 'amountMinor' | 'payer'>>,
  ): Promise<void> {
    const ops: Op[] = [];
    if (changes.description !== undefined) {
      ops.push(this.field(id, 'description', changes.description));
    }
    if (changes.amountMinor !== undefined) {
      if (!Number.isInteger(changes.amountMinor)) {
        throw new Error('amounts are minor units and must be integers');
      }
      ops.push(this.field(id, 'amountMinor', changes.amountMinor));
    }
    if (changes.payer !== undefined) ops.push(this.field(id, 'payer', changes.payer));
    if (ops.length > 0) await this.append(ops);
  }

  /** A tombstone, not a removal: the entry has to stay to stay deleted. */
  async removeExpense(id: string): Promise<void> {
    await this.append([this.field(id, 'deleted', true)]);
  }

  async setMember(id: string, person: string, present: boolean): Promise<void> {
    await this.append([this.member(id, person, present)]);
  }

  /**
   * Fold in operations that arrived from the server.
   *
   * They are acknowledged on arrival, because the server is where they came
   * from - it demonstrably has them. Without this they would sit in the
   * outbox and be pushed straight back: harmless, since the server ignores
   * duplicates, but the count on screen would say "10 to sync" when the
   * person had made five edits, which is worse than useless.
   */
  async receive(incoming: readonly Op[]): Promise<void> {
    for (const op of incoming) {
      this.clock.observe(op.at);
      this.acked.add(opId(op));
    }
    this.ops = merge(this.ops, incoming);
    await this.persist();
    await this.storage.write(KEYS.acked, JSON.stringify([...this.acked]));
  }

  /**
   * Record that the server holds these operations.
   *
   * Called only after a push the server acknowledged. If the app dies before
   * this is persisted, the operations are pushed again next time - which is
   * harmless, because the server ignores ones it already has. The opposite
   * order would be the dangerous one: marking first and crashing before the
   * push would lose them silently.
   */
  async markSynced(ops: readonly Op[]): Promise<void> {
    for (const op of ops) this.acked.add(opId(op));
    await this.storage.write(KEYS.acked, JSON.stringify([...this.acked]));
  }

  /** Advance the read position, only after the page has been applied. */
  async advanceCursor(cursor: number): Promise<void> {
    if (cursor <= this.serverCursor) return;
    this.serverCursor = cursor;
    await this.storage.write(KEYS.cursor, String(cursor));
  }

  private field(entry: string, field: FieldName, value: FieldValue): Op {
    return { kind: 'field', entry, field, value, at: this.clock.now() };
  }

  private member(entry: string, person: string, present: boolean): Op {
    return { kind: 'member', entry, person, present, at: this.clock.now() };
  }

  private async append(ops: readonly Op[]): Promise<void> {
    this.ops = merge(this.ops, ops);
    await this.persist();
  }

  /**
   * Write the log and the clock.
   *
   * The log goes out as one value because a key-value write is atomic per
   * key: a process killed mid-write leaves either the old log or the new
   * one, never half of each. It also means the cost grows with the log, so
   * this is the first thing to replace with an append-only table when the
   * log stops being small.
   */
  private async persist(): Promise<void> {
    await this.storage.write(KEYS.ops, JSON.stringify(this.ops));
    const stamp: Hlc = this.clock.snapshot();
    await this.storage.write(KEYS.clock, `${stamp.wall}:${stamp.counter}:${stamp.device}`);
  }
}
