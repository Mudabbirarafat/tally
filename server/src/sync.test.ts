import { describe, expect, it } from 'vitest';
import { ProtocolError, parseCursor, parseLimit, validateBatch, validateOp, validateTripId } from './protocol.ts';
import { OpStore } from './store.ts';
import type { Op } from './protocol.ts';

const at = (wall: number, device = 'phone-a', counter = 0) => ({ wall, counter, device });

const field = (entry: string, value: string, wall: number, device = 'phone-a'): Op => ({
  kind: 'field',
  entry,
  field: 'description',
  value,
  at: at(wall, device),
});

describe('validation', () => {
  it('accepts the operations the app produces', () => {
    expect(validateOp(field('e1', 'Dinner', 10))).toMatchObject({ kind: 'field', entry: 'e1' });
    expect(
      validateOp({ kind: 'member', entry: 'e1', person: 'riya', present: true, at: at(10) }),
    ).toMatchObject({ kind: 'member', person: 'riya' });
  });

  it('refuses anything it does not recognise', () => {
    const bad: unknown[] = [
      null,
      'a string',
      { kind: 'wat', entry: 'e1', at: at(1) },
      { kind: 'field', entry: 'e1', field: 'secret', value: 'x', at: at(1) },
      { kind: 'field', entry: '', field: 'description', value: 'x', at: at(1) },
      { kind: 'field', entry: 'e1', field: 'description', value: 'x' },
      { kind: 'field', entry: 'e1', field: 'description', value: 'x', at: { wall: -1, counter: 0, device: 'd' } },
      { kind: 'member', entry: 'e1', person: 'riya', present: 'yes', at: at(1) },
    ];
    for (const value of bad) expect(() => validateOp(value)).toThrow(ProtocolError);
  });

  it('insists money is an integer number of minor units', () => {
    const op = { kind: 'field', entry: 'e1', field: 'amountMinor', at: at(1) };
    expect(() => validateOp({ ...op, value: 12.5 })).toThrow(/integer/);
    expect(() => validateOp({ ...op, value: '1200' })).toThrow(/integer/);
    expect(validateOp({ ...op, value: 1200 })).toMatchObject({ value: 1200 });
  });

  it('caps a push so one client cannot hand the server unbounded work', () => {
    const many = Array.from({ length: 1001 }, (_, i) => field(`e${i}`, 'x', i));
    expect(() => validateBatch(many)).toThrow(/too many operations/);
  });

  it('refuses a trip id that is not safe in a URL or a key', () => {
    expect(validateTripId('goa-2026')).toBe('goa-2026');
    for (const bad of ['', '../etc', 'a/b', 'a b', 'x'.repeat(65)]) {
      expect(() => validateTripId(bad)).toThrow(ProtocolError);
    }
  });

  it('treats a missing cursor as the beginning, and a broken one as a bug', () => {
    expect(parseCursor(null)).toBe(0);
    expect(parseCursor('42')).toBe(42);
    // Not silently zero: resyncing all history because a cursor was mangled
    // is expensive and looks like a leak rather than an error.
    for (const bad of ['-1', 'abc', '1.5']) expect(() => parseCursor(bad)).toThrow(ProtocolError);
  });

  it('clamps the page size rather than trusting it', () => {
    expect(parseLimit('10')).toBe(10);
    expect(parseLimit('100000')).toBe(500);
    expect(() => parseLimit('0')).toThrow(ProtocolError);
  });
});

describe('the log', () => {
  it('hands back what it was given, oldest first', () => {
    const store = new OpStore();
    store.push('goa', [field('e1', 'Dinner', 10), field('e2', 'Taxi', 20)]);

    const { ops, more } = store.pull('goa', 0, 50);
    expect(ops.map((op) => (op as { value: string }).value)).toEqual(['Dinner', 'Taxi']);
    expect(more).toBe(false);
    store.close();
  });

  it('ignores an operation it already has', () => {
    const store = new OpStore();
    const op = field('e1', 'Dinner', 10);

    expect(store.push('goa', [op])).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(store.push('goa', [op])).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(store.count('goa')).toBe(1);
    store.close();
  });

  it('keeps trips apart', () => {
    const store = new OpStore();
    store.push('goa', [field('e1', 'Dinner', 10)]);
    store.push('manali', [field('e1', 'Cabin', 10)]);

    expect(store.pull('goa', 0, 50).ops).toHaveLength(1);
    expect((store.pull('manali', 0, 50).ops[0] as { value: string }).value).toBe('Cabin');
    store.close();
  });

  it('delivers an operation that arrives late with an old timestamp', () => {
    // The reason delivery order is a server sequence and not the hybrid
    // logical clock. A phone offline for a week pushes week-old timestamps;
    // if the cursor were a timestamp, these would sort behind it and never
    // reach anyone.
    const store = new OpStore();
    store.push('goa', [field('e1', 'Recent', 9_000, 'phone-a')]);
    const caughtUp = store.cursor('goa');

    store.push('goa', [field('e2', 'Week old', 1_000, 'phone-b')]);

    const { ops } = store.pull('goa', caughtUp, 50);
    expect(ops).toHaveLength(1);
    expect((ops[0] as { value: string }).value).toBe('Week old');
    store.close();
  });

  it('pages, and reports the cursor of the page rather than the server', () => {
    const store = new OpStore();
    store.push(
      'goa',
      Array.from({ length: 7 }, (_, i) => field(`e${i}`, `v${i}`, 100 + i)),
    );

    const first = store.pull('goa', 0, 3);
    expect(first.ops).toHaveLength(3);
    expect(first.more).toBe(true);

    const second = store.pull('goa', first.cursor, 3);
    expect((second.ops[0] as { value: string }).value).toBe('v3');

    const third = store.pull('goa', second.cursor, 3);
    expect(third.more).toBe(false);
    expect(third.ops).toHaveLength(1);
    store.close();
  });

  it('says 0 for a trip nobody has used', () => {
    const store = new OpStore();
    expect(store.cursor('nothing-here')).toBe(0);
    expect(store.pull('nothing-here', 0, 10)).toEqual({ ops: [], cursor: 0, more: false });
    store.close();
  });

  it('leaves the cursor alone when a pull finds nothing new', () => {
    // Otherwise a client at the head would rewind on every empty poll.
    const store = new OpStore();
    store.push('goa', [field('e1', 'Dinner', 10)]);
    const head = store.cursor('goa');
    expect(store.pull('goa', head, 50)).toEqual({ ops: [], cursor: head, more: false });
    store.close();
  });
});
