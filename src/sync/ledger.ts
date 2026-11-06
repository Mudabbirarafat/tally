/**
 * The ledger: an operation log that converges without a server to referee.
 *
 * Two phones are offline for a day. Both edit the same trip. Neither can ask
 * the other what happened. When they finally meet, the merged result has to
 * be identical on both - not "close enough", and not dependent on which
 * phone synced first.
 *
 * The approach is an operation log with field-level last-write-wins, ordered
 * by hybrid logical clock. Three properties make it safe, and all three are
 * tested rather than asserted:
 *
 *   merge(a, b) == merge(b, a)            order of sync does not matter
 *   merge(a, a) == a                      replaying a sync changes nothing
 *   merge(merge(a,b),c) == merge(a,merge(b,c))   grouping does not matter
 *
 * Together those mean any two replicas holding the same operations compute
 * the same state, which is what "converged" has to mean to be worth saying.
 *
 * **Why field-level rather than whole-record.** If one person fixes the
 * amount while the other fixes the description, whole-record last-write-wins
 * throws one of those edits away and nobody is told. Keeping a timestamp per
 * field means both survive. That is the single most visible difference
 * between this and the naive version, and `concurrent edits to different
 * fields both survive` is the test that pins it.
 *
 * **Money is integer minor units.** Paise, not rupees; never a float. A
 * ledger that loses a paisa to binary rounding is not a ledger.
 */

import { compare, format, type Hlc } from './hlc';

export type FieldName = 'description' | 'amountMinor' | 'payer' | 'deleted';

export type FieldValue = string | number | boolean;

/** A change to one scalar field of one entry. */
export type FieldOp = {
  kind: 'field';
  entry: string;
  field: FieldName;
  value: FieldValue;
  at: Hlc;
};

/**
 * A change to who shares an entry.
 *
 * Membership is modelled per person rather than as one array-valued field.
 * With an array, two people adding two different participants offline would
 * see one addition silently vanish; per-person registers keep both.
 */
export type MemberOp = {
  kind: 'member';
  entry: string;
  person: string;
  present: boolean;
  at: Hlc;
};

export type Op = FieldOp | MemberOp;

export type Entry = {
  id: string;
  description: string;
  amountMinor: number;
  payer: string;
  participants: string[];
  deleted: boolean;
};

/**
 * A stable identity for an operation, so merging is idempotent.
 *
 * Two copies of the same operation arriving by different routes - a direct
 * sync and a relayed one - must collapse to one. The timestamp is part of
 * the identity because it is already unique per device per event.
 */
export function opId(op: Op): string {
  const target = op.kind === 'field' ? op.field : `member:${op.person}`;
  return `${op.kind}|${op.entry}|${target}|${format(op.at)}`;
}

/**
 * Union two operation logs.
 *
 * Commutative, idempotent and associative, because a set union is, and
 * because the result is sorted into the one total order every replica agrees
 * on. The sort is not an optimisation - it is what makes two replicas with
 * the same operations produce the same array.
 */
export function merge(left: readonly Op[], right: readonly Op[]): Op[] {
  const byId = new Map<string, Op>();
  for (const op of left) byId.set(opId(op), op);
  for (const op of right) byId.set(opId(op), op);

  return [...byId.values()].sort((a, b) => {
    const byTime = compare(a.at, b.at);
    if (byTime !== 0) return byTime;
    // Same instant on the same device: order by what is being changed, so
    // the sequence is fully determined rather than left to sort stability.
    return opId(a) < opId(b) ? -1 : 1;
  });
}

const EMPTY: Omit<Entry, 'id'> = {
  description: '',
  amountMinor: 0,
  payer: '',
  participants: [],
  deleted: false,
};

/**
 * Fold an operation log into the current state.
 *
 * Deterministic: the same operations always produce the same entries, in the
 * same order. Later operations win per field, which is exactly the
 * last-write-wins rule, applied at the granularity that preserves both
 * people's work.
 */
export function materialise(ops: readonly Op[]): Entry[] {
  const fields = new Map<string, Map<string, { value: FieldValue; at: Hlc }>>();
  const members = new Map<string, Map<string, { present: boolean; at: Hlc }>>();

  for (const op of merge(ops, [])) {
    if (op.kind === 'field') {
      const entry = fields.get(op.entry) ?? new Map();
      const held = entry.get(op.field);
      if (!held || compare(op.at, held.at) > 0) entry.set(op.field, { value: op.value, at: op.at });
      fields.set(op.entry, entry);
    } else {
      const entry = members.get(op.entry) ?? new Map();
      const held = entry.get(op.person);
      if (!held || compare(op.at, held.at) > 0) {
        entry.set(op.person, { present: op.present, at: op.at });
      }
      members.set(op.entry, entry);
    }
  }

  const ids = new Set([...fields.keys(), ...members.keys()]);
  return [...ids]
    .sort()
    .map((id) => {
      const held = fields.get(id);
      const people = members.get(id) ?? new Map();
      return {
        id,
        ...EMPTY,
        description: (held?.get('description')?.value as string) ?? EMPTY.description,
        amountMinor: (held?.get('amountMinor')?.value as number) ?? EMPTY.amountMinor,
        payer: (held?.get('payer')?.value as string) ?? EMPTY.payer,
        deleted: (held?.get('deleted')?.value as boolean) ?? EMPTY.deleted,
        participants: [...people.entries()]
          .filter(([, state]) => state.present)
          .map(([person]) => person)
          .sort(),
      };
    });
}

/** The entries a person actually sees: deleted ones are kept but not shown. */
export const visible = (entries: readonly Entry[]): Entry[] =>
  entries.filter((entry) => !entry.deleted);

/**
 * Split an amount between people without losing a unit.
 *
 * 100 paise three ways is 33, 33, 34 - not 33.33 each, and not 33 each with
 * a paisa quietly evaporating. The remainder is handed out one unit at a
 * time in a fixed order, so every replica computes the same split and the
 * shares always sum to exactly the total.
 */
export function split(amountMinor: number, people: readonly string[]): Map<string, number> {
  if (!Number.isInteger(amountMinor)) {
    throw new Error(`amounts are minor units and must be integers, got ${amountMinor}`);
  }
  const shares = new Map<string, number>();
  if (people.length === 0) return shares;

  const ordered = [...people].sort();
  const base = Math.trunc(amountMinor / ordered.length);
  let remainder = amountMinor - base * ordered.length;
  const step = remainder >= 0 ? 1 : -1;

  for (const person of ordered) {
    let share = base;
    if (remainder !== 0) {
      share += step;
      remainder -= step;
    }
    shares.set(person, share);
  }
  return shares;
}

/**
 * Net position per person: positive means they are owed, negative means they
 * owe. Always sums to zero, which is the invariant worth testing.
 */
export function balances(entries: readonly Entry[]): Map<string, number> {
  const net = new Map<string, number>();
  const bump = (person: string, amount: number) =>
    net.set(person, (net.get(person) ?? 0) + amount);

  for (const entry of visible(entries)) {
    if (entry.participants.length === 0 || !entry.payer) continue;
    bump(entry.payer, entry.amountMinor);
    for (const [person, share] of split(entry.amountMinor, entry.participants)) {
      bump(person, -share);
    }
  }

  for (const [person, amount] of [...net.entries()]) {
    if (amount === 0) net.delete(person);
  }
  return net;
}

export type Transfer = { from: string; to: string; amountMinor: number };

/**
 * Who should pay whom, in as few transfers as the greedy pass can manage.
 *
 * Not provably minimal - that is NP-hard - but deterministic and always
 * settling to zero, which matters more than optimality for a group of five
 * splitting dinner.
 */
export function settle(entries: readonly Entry[]): Transfer[] {
  const owed = [...balances(entries).entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  );
  const creditors = owed.filter(([, amount]) => amount > 0);
  const debtors = owed.filter(([, amount]) => amount < 0).reverse();

  const transfers: Transfer[] = [];
  let c = 0;
  let d = 0;
  while (c < creditors.length && d < debtors.length) {
    const credit = creditors[c]!;
    const debt = debtors[d]!;
    const amount = Math.min(credit[1], -debt[1]);
    if (amount > 0) transfers.push({ from: debt[0], to: credit[0], amountMinor: amount });
    credit[1] -= amount;
    debt[1] += amount;
    if (credit[1] === 0) c += 1;
    if (debt[1] === 0) d += 1;
  }
  return transfers;
}
