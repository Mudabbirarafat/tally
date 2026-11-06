/**
 * Syncing when the network misbehaves.
 *
 * The happy path is the easy part and barely worth a test. What these cover
 * is the set of ways a phone actually fails: no signal, a server that
 * refuses the data, a connection that dies between the request and the
 * response, and the user pressing sync twice.
 */

import { describe, expect, it, vi } from 'vitest';
import { LedgerStore } from '../store/ledgerStore';
import { MemoryStorage } from '../store/storage';
import { SyncClient } from './client';
import { opId, type Op } from './ledger';

const dinner = {
  description: 'Dinner',
  amountMinor: 90000,
  payer: 'riya',
  participants: ['riya', 'sam'],
};

/** A server that behaves, with hooks for making it misbehave. */
function fakeServer() {
  const held = new Map<string, Op>();
  const order: string[] = [];
  let failPush: Error | null = null;
  let failPull: Error | null = null;
  const pushes: number[] = [];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === 'POST') {
      if (failPush) throw failPush;
      const { ops } = JSON.parse(String(init.body)) as { ops: Op[] };
      pushes.push(ops.length);
      let accepted = 0;
      for (const op of ops) {
        const id = opId(op);
        if (!held.has(id)) {
          held.set(id, op);
          order.push(id);
          accepted += 1;
        }
      }
      return json({ accepted, duplicates: ops.length - accepted, cursor: order.length });
    }

    if (failPull) throw failPull;
    const since = Number(url.searchParams.get('since') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 500);
    const slice = order.slice(since, since + limit);
    return json({
      ops: slice.map((id) => held.get(id)!),
      cursor: since + slice.length,
      more: since + slice.length < order.length,
    });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    pushes,
    get count() {
      return held.size;
    },
    seed(ops: Op[]) {
      for (const op of ops) {
        const id = opId(op);
        if (!held.has(id)) {
          held.set(id, op);
          order.push(id);
        }
      }
    },
    breakPush(error: Error | null) {
      failPush = error;
    },
    breakPull(error: Error | null) {
      failPull = error;
    },
  };
}

const openStore = (deviceId: string, storage = new MemoryStorage()) =>
  LedgerStore.open(storage, { deviceId });

describe('a good connection', () => {
  it('pushes what is owed and empties the outbox', async () => {
    const store = await openStore('phone-a');
    await store.addExpense(dinner);
    const server = fakeServer();

    const outcome = await new SyncClient(store, {
      baseUrl: 'http://x',
      trip: 'goa',
      fetchImpl: server.fetchImpl,
    }).sync();

    expect(outcome.pushed).toBe(5);
    expect(outcome.problem).toBeUndefined();
    expect(store.pending).toBe(0);
    expect(server.count).toBe(5);
  });

  it('pulls other people and shows their expenses', async () => {
    const other = await openStore('phone-b');
    await other.addExpense({ ...dinner, description: 'Taxi' });

    const server = fakeServer();
    server.seed(other.log);

    const mine = await openStore('phone-a');
    const outcome = await new SyncClient(mine, {
      baseUrl: 'http://x',
      trip: 'goa',
      fetchImpl: server.fetchImpl,
    }).sync();

    expect(outcome.pulled).toBe(other.log.length);
    expect(mine.entries[0]!.description).toBe('Taxi');
    expect(mine.cursor).toBeGreaterThan(0);
  });

  it('pages through a long backlog', async () => {
    const other = await openStore('phone-b');
    for (let i = 0; i < 6; i += 1) {
      await other.addExpense({ ...dinner, description: `Day ${i}` });
    }
    const server = fakeServer();
    server.seed(other.log);

    const mine = await openStore('phone-a');
    const outcome = await new SyncClient(mine, {
      baseUrl: 'http://x',
      trip: 'goa',
      fetchImpl: server.fetchImpl,
      batchSize: 4,
    }).sync();

    expect(outcome.pulled).toBe(other.log.length);
    expect(mine.entries).toHaveLength(6);
  });

  it('sends in batches the server will accept', async () => {
    const store = await openStore('phone-a');
    for (let i = 0; i < 4; i += 1) await store.addExpense(dinner);
    const server = fakeServer();

    await new SyncClient(store, {
      baseUrl: 'http://x',
      trip: 'goa',
      fetchImpl: server.fetchImpl,
      batchSize: 5,
    }).sync();

    expect(server.pushes.every((size) => size <= 5)).toBe(true);
    expect(store.pending).toBe(0);
  });
});

describe('no connection', () => {
  it('says it is offline and keeps the work', async () => {
    const store = await openStore('phone-a');
    await store.addExpense(dinner);
    const server = fakeServer();
    server.breakPush(new TypeError('Failed to fetch'));
    server.breakPull(new TypeError('Failed to fetch'));

    const outcome = await new SyncClient(store, {
      baseUrl: 'http://x',
      trip: 'goa',
      fetchImpl: server.fetchImpl,
    }).sync();

    expect(outcome.offline).toBe(true);
    expect(outcome.pushed).toBe(0);
    // Nothing was lost and nothing was marked sent.
    expect(store.pending).toBe(5);
    expect(store.entries).toHaveLength(1);
  });

  it('sends it once the connection comes back', async () => {
    const store = await openStore('phone-a');
    await store.addExpense(dinner);
    const server = fakeServer();
    const client = new SyncClient(store, {
      baseUrl: 'http://x',
      trip: 'goa',
      fetchImpl: server.fetchImpl,
    });

    server.breakPush(new TypeError('Failed to fetch'));
    await client.sync();
    server.breakPush(null);
    const outcome = await client.sync();

    expect(outcome.pushed).toBe(5);
    expect(store.pending).toBe(0);
  });

  it('still collects other people even when it cannot send its own', async () => {
    const other = await openStore('phone-b');
    await other.addExpense({ ...dinner, description: 'Taxi' });
    const server = fakeServer();
    server.seed(other.log);

    const mine = await openStore('phone-a');
    await mine.addExpense(dinner);
    server.breakPush(new Error('push is down'));

    const outcome = await new SyncClient(mine, {
      baseUrl: 'http://x',
      trip: 'goa',
      fetchImpl: server.fetchImpl,
    }).sync();

    expect(outcome.problem).toBe('push is down');
    expect(outcome.pulled).toBeGreaterThan(0);
    expect(mine.entries.some((entry) => entry.description === 'Taxi')).toBe(true);
    expect(mine.pending).toBe(5); // still owed
  });
});

describe('a server that says no', () => {
  it('reports the reason and does not call it offline', async () => {
    const store = await openStore('phone-a');
    await store.addExpense(dinner);

    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'amountMinor must be an integer' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const outcome = await new SyncClient(store, {
      baseUrl: 'http://x',
      trip: 'goa',
      fetchImpl,
    }).sync();

    expect(outcome.problem).toBe('amountMinor must be an integer');
    expect(outcome.offline).toBeUndefined();
    expect(store.pending).toBe(5); // not acknowledged, so still owed
  });

  it('gives up rather than looping for ever on a server that always says more', async () => {
    const store = await openStore('phone-a');
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ops: [], cursor: 0, more: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const outcome = await new SyncClient(store, {
      baseUrl: 'http://x',
      trip: 'goa',
      fetchImpl,
      maxPages: 3,
    }).sync();

    expect(outcome.problem).toMatch(/stopped after 3 pages/);
  });
});

describe('two syncs at once', () => {
  it('runs one, not two', async () => {
    // A background timer and an impatient user both pressing sync must not
    // push the same operations twice or race on the cursor.
    const store = await openStore('phone-a');
    await store.addExpense(dinner);
    const server = fakeServer();
    const spy = vi.fn(server.fetchImpl as unknown as typeof fetch);

    const client = new SyncClient(store, {
      baseUrl: 'http://x',
      trip: 'goa',
      fetchImpl: spy as unknown as typeof fetch,
    });
    const [first, second] = await Promise.all([client.sync(), client.sync()]);

    expect(first).toBe(second);
    expect(server.pushes).toHaveLength(1);
  });
});

describe('after a crash', () => {
  it('pushes again rather than losing what was never acknowledged', async () => {
    // The outbox is only cleared on a response. Dying between request and
    // response means sending again, which the server ignores.
    const disk = new MemoryStorage();
    const store = await openStore('phone-a', disk);
    await store.addExpense(dinner);

    const server = fakeServer();
    server.breakPush(new TypeError('Failed to fetch'));
    await new SyncClient(store, { baseUrl: 'http://x', trip: 'goa', fetchImpl: server.fetchImpl }).sync();

    // App restarts.
    const reopened = await openStore('phone-a', disk);
    expect(reopened.pending).toBe(5);

    server.breakPush(null);
    const outcome = await new SyncClient(reopened, {
      baseUrl: 'http://x',
      trip: 'goa',
      fetchImpl: server.fetchImpl,
    }).sync();

    expect(outcome.pushed).toBe(5);
    expect(server.count).toBe(5);
  });

  it('remembers what was already acknowledged', async () => {
    const disk = new MemoryStorage();
    const store = await openStore('phone-a', disk);
    await store.addExpense(dinner);
    const server = fakeServer();

    await new SyncClient(store, { baseUrl: 'http://x', trip: 'goa', fetchImpl: server.fetchImpl }).sync();

    const reopened = await openStore('phone-a', disk);
    expect(reopened.pending).toBe(0);
    expect(reopened.cursor).toBeGreaterThan(0);
  });
});
