/**
 * The HTTP surface, exercised over a real socket, plus the contract that
 * keeps the server's idea of an operation's identity the same as the app's.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './http.ts';
import { type Op } from './protocol.ts';
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

const op = (entry: string, value: string, wall: number): Op => ({
  kind: 'field',
  entry,
  field: 'description',
  value,
  at: { wall, counter: 0, device: 'phone-a' },
});

describe('the sync endpoint', () => {
  it('reports its limits so a client need not guess them', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', limits: { opsPerPush: 1000 } });
  });

  it('accepts a push and serves it back', async () => {
    const pushed = await fetch(`${base}/trips/goa/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [op('e1', 'Dinner', 10), op('e2', 'Taxi', 20)] }),
    });
    expect(pushed.status).toBe(200);
    expect(await pushed.json()).toMatchObject({ accepted: 2, duplicates: 0 });

    const pulled = await fetch(`${base}/trips/goa/ops?since=0`);
    const body = (await pulled.json()) as { ops: Op[]; cursor: number; more: boolean };
    expect(body.ops).toHaveLength(2);
    expect(body.more).toBe(false);
    expect(body.cursor).toBeGreaterThan(0);
  });

  it('is safe to retry, which on a phone is the normal case', async () => {
    // A push that succeeded but whose response was lost gets sent again.
    const send = () =>
      fetch(`${base}/trips/retry/ops`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops: [op('e1', 'Dinner', 10)] }),
      }).then((r) => r.json());

    expect(await send()).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(await send()).toMatchObject({ accepted: 0, duplicates: 1 });

    const pulled = await fetch(`${base}/trips/retry/ops?since=0`).then((r) => r.json());
    expect((pulled as { ops: Op[] }).ops).toHaveLength(1);
  });

  it('refuses a malformed operation with a reason', async () => {
    const response = await fetch(`${base}/trips/goa/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ kind: 'field', entry: 'e1', field: 'nope', value: 1 }] }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('at must be an object'),
    });
  });

  it('refuses a body that is not JSON', async () => {
    const response = await fetch(`${base}/trips/goa/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(response.status).toBe(400);
  });

  it('refuses a trip id that does not belong in a URL', async () => {
    const response = await fetch(`${base}/trips/..%2Fetc/ops?since=0`);
    expect(response.status).toBe(400);
  });

  it('answers 404 and 405 rather than guessing', async () => {
    expect((await fetch(`${base}/nowhere`)).status).toBe(404);
    expect((await fetch(`${base}/trips/goa/ops`, { method: 'DELETE' })).status).toBe(405);
  });

  it('allows the browser build to call it', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});
