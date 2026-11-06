/**
 * The whole thing, end to end: two app installs, the real server, a real
 * socket, and no mocks anywhere.
 *
 * This is the test that would have caught every integration bug the unit
 * tests cannot see - a client that pushes what the server rejects, a cursor
 * the two disagree about, an operation id that differs by a character. It is
 * excluded from the server's typecheck for the same reason as the contract
 * test: it reaches across the app/server boundary, where the two halves use
 * different module resolution deliberately.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerStore } from '../../src/store/ledgerStore';
import { MemoryStorage } from '../../src/store/storage';
import { SyncClient } from '../../src/sync/client';
import { createApp } from './http.ts';
import { OpStore } from './store.ts';

let server: Server;
let base: string;
let store: OpStore;

beforeAll(async () => {
  store = new OpStore();
  const app = createApp(store);
  server = createServer((request, response) => void app(request, response));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

async function install(device: string, trip: string) {
  const disk = new MemoryStorage();
  const ledger = await LedgerStore.open(disk, { deviceId: device });
  return {
    ledger,
    disk,
    client: new SyncClient(ledger, { baseUrl: base, trip }),
  };
}

describe('two phones on one trip', () => {
  it('converges after both have been offline and edited the same expense', async () => {
    const a = await install('phone-a', 'goa');
    const b = await install('phone-b', 'goa');

    // A adds the expense while online, and B picks it up.
    const id = await a.ledger.addExpense({
      description: 'Dinner',
      amountMinor: 90000,
      payer: 'riya',
      participants: ['riya', 'sam', 'dev'],
    });
    await a.client.sync();
    await b.client.sync();
    expect(b.ledger.entries).toHaveLength(1);

    // Both go offline. Each fixes a different thing about the same entry.
    await a.ledger.editExpense(id, { description: 'Dinner at the pier' });
    await b.ledger.editExpense(id, { amountMinor: 97500 });

    // They come back in sequence, as phones do.
    await a.client.sync();
    await b.client.sync();
    await a.client.sync();

    // Identical on both, and neither edit was discarded.
    expect(a.ledger.entries).toEqual(b.ledger.entries);
    expect(a.ledger.entries[0]!.description).toBe('Dinner at the pier');
    expect(a.ledger.entries[0]!.amountMinor).toBe(97500);
    expect(a.ledger.pending).toBe(0);
    expect(b.ledger.pending).toBe(0);
  });

  it('agrees on who owes whom, to the paisa', async () => {
    const a = await install('phone-c', 'manali');
    const b = await install('phone-d', 'manali');

    await a.ledger.addExpense({
      description: 'Cabin',
      amountMinor: 1_200_50,
      payer: 'riya',
      participants: ['riya', 'sam', 'dev'],
    });
    await b.ledger.addExpense({
      description: 'Fuel',
      amountMinor: 40_000,
      payer: 'dev',
      participants: ['riya', 'sam', 'dev'],
    });

    await a.client.sync();
    await b.client.sync();
    await a.client.sync();

    expect([...a.ledger.balances()]).toEqual([...b.ledger.balances()]);
    expect(a.ledger.settle()).toEqual(b.ledger.settle());
    // The invariant that makes it a ledger.
    const total = [...a.ledger.balances().values()].reduce((x, y) => x + y, 0);
    expect(total).toBe(0);
  });

  it('delivers an edit made a week ago to a phone that was already caught up', async () => {
    // The reason delivery order is a server sequence rather than a
    // timestamp, proven through the real client and the real server.
    const a = await install('phone-e', 'ladakh');
    const slow = await install('phone-f', 'ladakh');

    await a.ledger.addExpense({
      description: 'Permit',
      amountMinor: 5000,
      payer: 'riya',
      participants: ['riya'],
    });
    await a.client.sync();
    await slow.client.sync();

    // `slow` has an old clock: its edits carry week-old timestamps.
    const stale = await LedgerStore.open(slow.disk, {
      deviceId: 'phone-f',
      now: () => 1_000,
    });
    await stale.addExpense({
      description: 'Fuel, paid last week',
      amountMinor: 30000,
      payer: 'sam',
      participants: ['sam'],
    });
    await new SyncClient(stale, { baseUrl: base, trip: 'ladakh' }).sync();

    // A is caught up, so it pulls from a cursor past everything it has seen.
    await a.client.sync();

    expect(a.ledger.entries.some((e) => e.description === 'Fuel, paid last week')).toBe(true);
  });

  it('is unchanged by syncing again when there is nothing to do', async () => {
    const a = await install('phone-g', 'coorg');
    await a.ledger.addExpense({
      description: 'Coffee',
      amountMinor: 25000,
      payer: 'riya',
      participants: ['riya', 'sam'],
    });
    await a.client.sync();

    const settled = a.ledger.entries;
    const cursor = a.ledger.cursor;
    const outcome = await a.client.sync();

    expect(outcome).toMatchObject({ pushed: 0, pulled: 0, cursor });
    expect(a.ledger.entries).toEqual(settled);
  });
});
