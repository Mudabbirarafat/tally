/**
 * What the server accepts, and why it does not simply trust the client.
 *
 * Everything here is pure, so the protocol can be tested without a socket
 * or a database.
 *
 * **Two orderings, doing two different jobs.** This is the part that is easy
 * to get wrong and expensive to discover later.
 *
 *   - The hybrid logical clock orders operations for *merging*: given two
 *     edits to the same field, which one wins.
 *   - The server sequence orders them for *delivery*: what a client has not
 *     seen yet.
 *
 * They cannot be the same number. A phone that was offline for a week pushes
 * operations whose timestamps are a week old. If clients pulled "everything
 * after my last timestamp", those operations would sort *behind* the cursor
 * and never be delivered to anyone - a silent, permanent data loss that only
 * shows up as "my friend's expenses never appeared". Assigning a fresh
 * sequence number on receipt means late arrivals are still new to everybody.
 *
 * **Identity is recomputed, not accepted.** The client sends operations; the
 * server derives each id from the operation's own fields. Taking the id on
 * trust would let one buggy client collide with another's operations, or
 * overwrite them. `protocol.contract.test.ts` pins this implementation
 * against the app's so the two cannot drift apart.
 */

export type Hlc = { wall: number; counter: number; device: string };

export type Op =
  | { kind: 'field'; entry: string; field: string; value: string | number | boolean; at: Hlc }
  | { kind: 'member'; entry: string; person: string; present: boolean; at: Hlc };

/**
 * Written as a plain field assignment rather than a constructor parameter
 * property. Node runs TypeScript by *stripping* types, not compiling them,
 * so any syntax that emits runtime code - parameter properties, enums,
 * namespaces, decorators - fails to load. Keeping to strippable TypeScript
 * is what lets this server run with no build step and no dependencies.
 */
export class ProtocolError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const FIELDS = new Set(['description', 'amountMinor', 'payer', 'deleted']);

/** Caps: a sync request is a batch, not an upload of unbounded size. */
export const LIMITS = {
  opsPerPush: 1000,
  opsPerPull: 500,
  idLength: 128,
  textLength: 2000,
} as const;

function text(value: unknown, what: string, max: number = LIMITS.idLength): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProtocolError(`${what} must be a non-empty string`);
  }
  if (value.length > max) throw new ProtocolError(`${what} is longer than ${max} characters`);
  return value;
}

function stamp(value: unknown): Hlc {
  if (typeof value !== 'object' || value === null) throw new ProtocolError('at must be an object');
  const { wall, counter, device } = value as Record<string, unknown>;
  if (!Number.isInteger(wall) || (wall as number) < 0) {
    throw new ProtocolError('at.wall must be a non-negative integer');
  }
  if (!Number.isInteger(counter) || (counter as number) < 0) {
    throw new ProtocolError('at.counter must be a non-negative integer');
  }
  return { wall: wall as number, counter: counter as number, device: text(device, 'at.device') };
}

/**
 * Validate one operation from the wire.
 *
 * Strict on purpose. A sync server that stores whatever arrives becomes the
 * thing that corrupts every client at once, because the bad record is then
 * handed to all of them.
 */
export function validateOp(value: unknown): Op {
  if (typeof value !== 'object' || value === null) {
    throw new ProtocolError('each operation must be an object');
  }
  const raw = value as Record<string, unknown>;
  const at = stamp(raw.at);
  const entry = text(raw.entry, 'entry');

  if (raw.kind === 'field') {
    const field = text(raw.field, 'field');
    if (!FIELDS.has(field)) throw new ProtocolError(`unknown field "${field}"`);

    const kind = typeof raw.value;
    if (field === 'amountMinor') {
      if (!Number.isInteger(raw.value)) {
        throw new ProtocolError('amountMinor must be an integer number of minor units');
      }
    } else if (field === 'deleted') {
      if (kind !== 'boolean') throw new ProtocolError('deleted must be a boolean');
    } else if (kind !== 'string') {
      throw new ProtocolError(`${field} must be a string`);
    } else if ((raw.value as string).length > LIMITS.textLength) {
      throw new ProtocolError(`${field} is longer than ${LIMITS.textLength} characters`);
    }
    return { kind: 'field', entry, field, value: raw.value as string | number | boolean, at };
  }

  if (raw.kind === 'member') {
    if (typeof raw.present !== 'boolean') throw new ProtocolError('present must be a boolean');
    return { kind: 'member', entry, person: text(raw.person, 'person'), present: raw.present, at };
  }

  throw new ProtocolError(`unknown operation kind "${String(raw.kind)}"`);
}

/** Must match the app's `opId`; the contract test is what keeps it true. */
export function opId(op: Op): string {
  const target = op.kind === 'field' ? op.field : `member:${op.person}`;
  const at = `${String(op.at.wall).padStart(15, '0')}:${String(op.at.counter).padStart(5, '0')}:${op.at.device}`;
  return `${op.kind}|${op.entry}|${target}|${at}`;
}

export function validateBatch(value: unknown): Op[] {
  if (!Array.isArray(value)) throw new ProtocolError('ops must be an array');
  if (value.length > LIMITS.opsPerPush) {
    throw new ProtocolError(
      `too many operations in one push: ${value.length} > ${LIMITS.opsPerPush}`,
      413,
    );
  }
  return value.map(validateOp);
}

/**
 * Parse a pull cursor.
 *
 * Absent means "from the beginning", which is what a fresh install needs.
 * Anything that is not a non-negative integer is a bug on the client worth
 * reporting rather than silently treating as zero - resyncing the whole
 * history because a cursor was malformed is expensive and looks like a leak.
 */
export function parseCursor(value: string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ProtocolError(`cursor must be a non-negative integer, got "${value}"`);
  }
  return parsed;
}

export function parseLimit(value: string | null | undefined): number {
  if (!value) return LIMITS.opsPerPull;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ProtocolError(`limit must be a positive integer, got "${value}"`);
  }
  return Math.min(parsed, LIMITS.opsPerPull);
}

/** Trip ids come from clients, and end up in a URL and a database key. */
export function validateTripId(value: string | undefined): string {
  const trip = text(value, 'trip id', 64);
  if (!/^[A-Za-z0-9_-]+$/.test(trip)) {
    throw new ProtocolError('trip id may contain only letters, digits, dashes and underscores');
  }
  return trip;
}
