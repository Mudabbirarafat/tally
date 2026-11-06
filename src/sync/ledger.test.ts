/**
 * Convergence is the claim this app rests on, so it is tested as a property
 * rather than demonstrated with one happy example.
 *
 * None of this needs a phone, a network or a server, which is the point: the
 * hardest part of an offline-first app is pure logic, and pure logic can be
 * proven on a laptop.
 */

import { describe, expect, it } from 'vitest';
import { Clock } from './hlc';
import {
  balances,
  materialise,
  merge,
  opId,
  settle,
  split,
  visible,
  type Entry,
  type FieldName,
  type FieldValue,
  type Op,
} from './ledger';

/** Seeded, so a failure reproduces instead of vanishing on the next run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A device that edits a shared trip while offline. */
function device(name: string, startAt = 1_000) {
  let wall = startAt;
  const clock = new Clock(name, () => wall);
  const ops: Op[] = [];

  return {
    name,
    get ops() {
      return [...ops];
    },
    tick: (by = 1) => {
      wall += by;
    },
    set(entry: string, field: FieldName, value: FieldValue) {
      ops.push({ kind: 'field', entry, field, value, at: clock.now() });
    },
    member(entry: string, person: string, present: boolean) {
      ops.push({ kind: 'member', entry, person, present, at: clock.now() });
    },
    receive(incoming: readonly Op[]) {
      for (const op of incoming) clock.observe(op.at);
      ops.push(...incoming);
    },
  };
}

const state = (ops: readonly Op[]) => JSON.stringify(materialise(ops));

describe('merge', () => {
  it('does not care which phone synced first', () => {
    const a = device('a');
    const b = device('b');
    a.set('e1', 'description', 'Taxi');
    b.set('e1', 'amountMinor', 48000);

    expect(state(merge(a.ops, b.ops))).toBe(state(merge(b.ops, a.ops)));
  });

  it('does not change when the same sync is replayed', () => {
    const a = device('a');
    a.set('e1', 'description', 'Taxi');
    a.set('e1', 'amountMinor', 48000);

    const once = merge(a.ops, []);
    expect(state(merge(once, a.ops))).toBe(state(once));
    expect(merge(once, once)).toHaveLength(once.length);
  });

  it('does not care how the syncs were grouped', () => {
    const [a, b, c] = [device('a'), device('b'), device('c')];
    a.set('e1', 'description', 'Hotel');
    b.set('e1', 'amountMinor', 1_250_00);
    c.set('e1', 'payer', 'sam');

    const left = merge(merge(a.ops, b.ops), c.ops);
    const right = merge(a.ops, merge(b.ops, c.ops));
    expect(state(left)).toBe(state(right));
  });

  it('gives every operation one identity, however it arrived', () => {
    const a = device('a');
    a.set('e1', 'description', 'Taxi');
    const [op] = a.ops;
    expect(opId(op!)).toBe(opId({ ...op! }));
  });
});

describe('concurrent edits', () => {
  it('keeps both when two people change different fields', () => {
    // The whole reason for per-field timestamps. Whole-record
    // last-write-wins would discard one of these and tell nobody.
    const a = device('a');
    const b = device('b');
    a.set('e1', 'description', 'Dinner');
    b.tick(50); // b's clock is ahead, as phones' clocks are
    b.set('e1', 'amountMinor', 90000);

    const [entry] = materialise(merge(a.ops, b.ops));
    expect(entry!.description).toBe('Dinner');
    expect(entry!.amountMinor).toBe(90000);
  });

  it('takes the later edit when two people change the same field', () => {
    const a = device('a');
    const b = device('b');
    a.set('e1', 'amountMinor', 100);
    b.tick(10);
    b.set('e1', 'amountMinor', 200);

    expect(materialise(merge(a.ops, b.ops))[0]!.amountMinor).toBe(200);
  });

  it('keeps both when two people add different participants', () => {
    // Membership is per person, so neither addition is lost - which an
    // array-valued field would not manage.
    const a = device('a');
    const b = device('b');
    a.member('e1', 'riya', true);
    b.member('e1', 'sam', true);

    expect(materialise(merge(a.ops, b.ops))[0]!.participants).toEqual(['riya', 'sam']);
  });

  it('lets a later removal win over an earlier addition', () => {
    const a = device('a');
    a.member('e1', 'sam', true);
    a.tick(5);
    a.member('e1', 'sam', false);

    expect(materialise(a.ops)[0]!.participants).toEqual([]);
  });

  it('keeps a deletion rather than resurrecting the entry on the next sync', () => {
    // Without a tombstone the other device would re-add it on every sync,
    // which is the classic "deleted item keeps coming back" bug.
    const a = device('a');
    const b = device('b');
    a.set('e1', 'description', 'Taxi');
    b.receive(a.ops);
    b.tick(10);
    b.set('e1', 'deleted', true);

    const merged = materialise(merge(a.ops, b.ops));
    expect(merged[0]!.deleted).toBe(true);
    expect(visible(merged)).toEqual([]);
  });
});

describe('convergence under random interleavings', () => {
  it('reaches identical state however the syncs are shuffled', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = random(seed);
      const devices = [device('a'), device('b'), device('c')];
      const fields: FieldName[] = ['description', 'amountMinor', 'payer'];

      for (let step = 0; step < 60; step += 1) {
        const who = devices[Math.floor(next() * devices.length)]!;
        const entry = `e${Math.floor(next() * 4)}`;
        who.tick(Math.floor(next() * 3));

        if (next() < 0.25) {
          who.member(entry, `p${Math.floor(next() * 3)}`, next() < 0.7);
        } else {
          const field = fields[Math.floor(next() * fields.length)]!;
          const value = field === 'amountMinor' ? Math.floor(next() * 100000) : `v${step}`;
          who.set(entry, field, value);
        }

        // Occasionally two devices meet and exchange what they have.
        if (next() < 0.3) {
          const other = devices[Math.floor(next() * devices.length)]!;
          if (other !== who) other.receive(who.ops);
        }
      }

      const everything = devices.reduce<Op[]>((all, d) => merge(all, d.ops), []);
      const shuffled = [...everything].sort(() => next() - 0.5);
      const grouped = merge(merge(devices[2]!.ops, devices[0]!.ops), devices[1]!.ops);

      expect(state(shuffled)).toBe(state(everything));
      expect(state(grouped)).toBe(state(everything));
    }
  });
});

describe('split', () => {
  it('never loses a unit to rounding', () => {
    const shares = split(100, ['a', 'b', 'c']);
    expect([...shares.values()].reduce((x, y) => x + y, 0)).toBe(100);
    expect([...shares.values()].sort()).toEqual([33, 33, 34]);
  });

  it('splits the same way on every device', () => {
    // Deterministic order, so two phones computing the same split agree on
    // who takes the extra paisa.
    expect([...split(100, ['c', 'a', 'b'])]).toEqual([...split(100, ['a', 'b', 'c'])]);
  });

  it('handles negatives without losing a unit either', () => {
    const shares = split(-100, ['a', 'b', 'c']);
    expect([...shares.values()].reduce((x, y) => x + y, 0)).toBe(-100);
  });

  it('refuses a fractional amount rather than rounding it silently', () => {
    expect(() => split(10.5, ['a'])).toThrow(/integers/);
  });

  it('is empty for nobody, rather than dividing by zero', () => {
    expect(split(100, []).size).toBe(0);
  });
});

const entry = (over: Partial<Entry>): Entry => ({
  id: 'e',
  description: '',
  amountMinor: 0,
  payer: '',
  participants: [],
  deleted: false,
  ...over,
});

describe('balances and settling', () => {
  it('always sums to zero', () => {
    const rows = [
      entry({ id: 'e1', amountMinor: 90000, payer: 'riya', participants: ['riya', 'sam', 'dev'] }),
      entry({ id: 'e2', amountMinor: 45000, payer: 'sam', participants: ['riya', 'sam'] }),
    ];
    const total = [...balances(rows).values()].reduce((x, y) => x + y, 0);
    expect(total).toBe(0);
  });

  it('ignores deleted entries', () => {
    const rows = [
      entry({ id: 'e1', amountMinor: 100, payer: 'a', participants: ['a', 'b'], deleted: true }),
    ];
    expect(balances(rows).size).toBe(0);
  });

  it('settles everyone to zero', () => {
    const rows = [
      entry({ id: 'e1', amountMinor: 90000, payer: 'riya', participants: ['riya', 'sam', 'dev'] }),
      entry({ id: 'e2', amountMinor: 30000, payer: 'dev', participants: ['riya', 'sam', 'dev'] }),
    ];

    const after = new Map(balances(rows));
    for (const transfer of settle(rows)) {
      after.set(transfer.from, (after.get(transfer.from) ?? 0) + transfer.amountMinor);
      after.set(transfer.to, (after.get(transfer.to) ?? 0) - transfer.amountMinor);
    }
    for (const [, amount] of after) expect(amount).toBe(0);
  });

  it('asks nobody to pay themselves', () => {
    const rows = [
      entry({ id: 'e1', amountMinor: 50000, payer: 'riya', participants: ['riya', 'sam'] }),
    ];
    for (const transfer of settle(rows)) expect(transfer.from).not.toBe(transfer.to);
  });
});
