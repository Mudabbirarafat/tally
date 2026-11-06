/**
 * What happens to the ledger between launches.
 *
 * Every test here is a situation a phone creates and a server never does:
 * the OS killing the app, storage coming back damaged, the same install
 * being opened again tomorrow. They run in a plain Node process against an
 * in-memory adapter, so none of it needs a device.
 */

import { describe, expect, it } from 'vitest';
import { isAfter } from '../sync/hlc';
import { LedgerStore } from './ledgerStore';
import { MemoryStorage } from './storage';

const dinner = {
  description: 'Dinner',
  amountMinor: 90000,
  payer: 'riya',
  participants: ['riya', 'sam', 'dev'],
};

describe('across restarts', () => {
  it('still has the ledger after the app is killed and reopened', async () => {
    const disk = new MemoryStorage();
    const first = await LedgerStore.open(disk, { deviceId: 'phone-a' });
    await first.addExpense(dinner);

    // The process dies here. Nothing is carried over but the disk.
    const second = await LedgerStore.open(disk, { deviceId: 'phone-a' });

    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]!.description).toBe('Dinner');
    expect(second.entries[0]!.amountMinor).toBe(90000);
    expect(second.entries[0]!.participants).toEqual(['dev', 'riya', 'sam']);
  });

  it('does not let the clock rewind, so later edits still sort later', async () => {
    // The bug this prevents: a restarted clock stamps new edits below old
    // ones, and the next sync silently discards the newer work.
    const disk = new MemoryStorage();
    const first = await LedgerStore.open(disk, { deviceId: 'phone-a', now: () => 5_000 });
    const id = await first.addExpense(dinner);
    const before = first.log.at(-1)!.at;

    // Reopened with a wall clock that has gone backwards.
    const second = await LedgerStore.open(disk, { deviceId: 'phone-a', now: () => 1_000 });
    await second.editExpense(id, { amountMinor: 95000 });

    expect(isAfter(second.log.at(-1)!.at, before)).toBe(true);
    expect(second.entries[0]!.amountMinor).toBe(95000);
  });

  it('keeps the same device id, because it is the tiebreak in the ordering', async () => {
    const disk = new MemoryStorage();
    const first = await LedgerStore.open(disk);
    const second = await LedgerStore.open(disk);
    expect(second.device).toBe(first.device);
    expect(first.device).toMatch(/^d-/);
  });

  it('keeps a deletion deleted', async () => {
    const disk = new MemoryStorage();
    const first = await LedgerStore.open(disk, { deviceId: 'phone-a' });
    const id = await first.addExpense(dinner);
    await first.removeExpense(id);

    const second = await LedgerStore.open(disk, { deviceId: 'phone-a' });
    expect(second.entries).toHaveLength(0);
    expect(second.all).toHaveLength(1); // the tombstone is still there
  });
});

describe('damaged storage', () => {
  it('opens anyway, and keeps the unreadable data instead of deleting it', async () => {
    // A write cut short by the process dying leaves truncated JSON. That
    // blob may be the only copy of edits that never synced, so tidying it
    // away would be destroying evidence.
    const disk = new MemoryStorage();
    await disk.write('tally.ops.v1', '[{"kind":"field","entry":"e1"');

    const store = await LedgerStore.open(disk, { deviceId: 'phone-a' });

    expect(store.hadCorruptStorage).toBe(true);
    expect(store.entries).toEqual([]);
    expect(await disk.read('tally.corrupt.v1')).toBe('[{"kind":"field","entry":"e1"');
    // And it is usable immediately rather than stuck.
    await store.addExpense(dinner);
    expect(store.entries).toHaveLength(1);
  });

  it('rejects stored data that parses but is the wrong shape', async () => {
    const disk = new MemoryStorage();
    await disk.write('tally.ops.v1', '{"not":"an array"}');
    const store = await LedgerStore.open(disk, { deviceId: 'phone-a' });
    expect(store.hadCorruptStorage).toBe(true);
  });

  it('recovers the clock from the operations when the saved clock is damaged', async () => {
    const disk = new MemoryStorage();
    const first = await LedgerStore.open(disk, { deviceId: 'phone-a', now: () => 9_000 });
    const id = await first.addExpense(dinner);
    const before = first.log.at(-1)!.at;

    await disk.write('tally.clock.v1', 'rubbish');
    const second = await LedgerStore.open(disk, { deviceId: 'phone-a', now: () => 1_000 });
    await second.editExpense(id, { amountMinor: 1 });

    expect(isAfter(second.log.at(-1)!.at, before)).toBe(true);
  });

  it('starts clean on a fresh install', async () => {
    const store = await LedgerStore.open(new MemoryStorage());
    expect(store.entries).toEqual([]);
    expect(store.hadCorruptStorage).toBe(false);
  });
});

describe('two installs meeting', () => {
  it('ends with the same ledger on both, whichever synced first', async () => {
    const diskA = new MemoryStorage();
    const diskB = new MemoryStorage();
    const a = await LedgerStore.open(diskA, { deviceId: 'phone-a', now: () => 1_000 });
    const b = await LedgerStore.open(diskB, { deviceId: 'phone-b', now: () => 1_000 });

    const id = await a.addExpense(dinner);
    await b.receive(a.log);

    // Both go offline and edit different fields of the same expense.
    await a.editExpense(id, { description: 'Dinner at the pier' });
    await b.editExpense(id, { amountMinor: 97500 });

    const fromA = a.log;
    const fromB = b.log;
    await a.receive(fromB);
    await b.receive(fromA);

    expect(a.entries).toEqual(b.entries);
    expect(a.entries[0]!.description).toBe('Dinner at the pier');
    expect(a.entries[0]!.amountMinor).toBe(97500);
  });

  it('survives the same sync arriving twice', async () => {
    const disk = new MemoryStorage();
    const store = await LedgerStore.open(disk, { deviceId: 'phone-a' });
    const other = await LedgerStore.open(new MemoryStorage(), { deviceId: 'phone-b' });
    await other.addExpense(dinner);

    await store.receive(other.log);
    const afterFirst = store.entries;
    await store.receive(other.log);

    expect(store.entries).toEqual(afterFirst);
    expect(store.log).toHaveLength(other.log.length);
  });
});

describe('the outbox', () => {
  it('counts what has not been accepted elsewhere yet', async () => {
    const store = await LedgerStore.open(new MemoryStorage(), { deviceId: 'phone-a' });
    expect(store.pending).toBe(0);

    await store.addExpense(dinner);
    // description, amount, payer and three participants
    expect(store.pending).toBe(6);
  });
});

describe('money', () => {
  it('refuses a fractional amount rather than rounding it away', async () => {
    const store = await LedgerStore.open(new MemoryStorage(), { deviceId: 'phone-a' });
    await expect(store.addExpense({ ...dinner, amountMinor: 900.5 })).rejects.toThrow(/integers/);
  });

  it('settles a real trip to zero', async () => {
    const store = await LedgerStore.open(new MemoryStorage(), { deviceId: 'phone-a' });
    await store.addExpense(dinner);
    await store.addExpense({
      description: 'Taxi',
      amountMinor: 40000,
      payer: 'sam',
      participants: ['riya', 'sam', 'dev'],
    });

    const net = new Map(store.balances());
    for (const transfer of store.settle()) {
      net.set(transfer.from, (net.get(transfer.from) ?? 0) + transfer.amountMinor);
      net.set(transfer.to, (net.get(transfer.to) ?? 0) - transfer.amountMinor);
    }
    for (const [, amount] of net) expect(amount).toBe(0);
  });
});
