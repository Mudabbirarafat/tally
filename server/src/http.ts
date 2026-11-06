/**
 * The sync endpoint.
 *
 * `node:http` directly, no framework, because the whole surface is three
 * routes and a framework would be the only dependency in the project.
 *
 *   GET  /health
 *   POST /trips/:trip/ops        push operations      -> { accepted, duplicates, cursor }
 *   GET  /trips/:trip/ops?since= pull operations      -> { ops, cursor, more }
 *
 * The client is expected to push, then pull from its stored cursor, then
 * store the new cursor. Both halves are idempotent, so a request that times
 * out after the server committed is safe to retry - which on a phone is the
 * normal case rather than the exception.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  LIMITS,
  ProtocolError,
  parseCursor,
  parseLimit,
  validateBatch,
  validateTripId,
} from './protocol.ts';
import { OpStore } from './store.ts';

const MAX_BODY_BYTES = 1_000_000;

/** Read a JSON body, refusing one too large to be a legitimate push. */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // Checked while streaming, not after: buffering it all first is the
    // denial-of-service this guard exists to prevent.
    if (size > MAX_BODY_BYTES) throw new ProtocolError('request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ProtocolError('body is not valid JSON');
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // The app is served from a different origin in development and on the
    // web build, and every route here is public and read/write by design.
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  response.end(text);
}

export function createApp(store: OpStore) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.method === 'OPTIONS') return send(response, 204, {});

      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/health') {
        return send(response, 200, { status: 'ok', limits: LIMITS });
      }

      const match = /^\/trips\/([^/]+)\/ops$/.exec(url.pathname);
      if (!match) return send(response, 404, { error: `no route for ${url.pathname}` });
      const trip = validateTripId(decodeURIComponent(match[1]!));

      if (request.method === 'POST') {
        const body = (await readJson(request)) as { ops?: unknown } | undefined;
        const ops = validateBatch(body?.ops ?? []);
        return send(response, 200, store.push(trip, ops));
      }

      if (request.method === 'GET') {
        const since = parseCursor(url.searchParams.get('since'));
        const limit = parseLimit(url.searchParams.get('limit'));
        return send(response, 200, store.pull(trip, since, limit));
      }

      return send(response, 405, { error: `${request.method} not allowed here` });
    } catch (problem) {
      if (problem instanceof ProtocolError) {
        return send(response, problem.status, { error: problem.message });
      }
      // Unexpected: log it for the operator, but do not hand the internals
      // to the caller.
      console.error('unhandled', problem);
      return send(response, 500, { error: 'internal error' });
    }
  };
}

export function startServer(port: number, databasePath: string) {
  const store = new OpStore(databasePath);
  const server = createServer((request, response) => {
    void createApp(store)(request, response);
  });
  server.listen(port, () => {
    console.log(`tally sync listening on http://localhost:${port} (db: ${databasePath})`);
  });
  return { server, store };
}

// Starting the process lives in `main.ts`, so importing this module - which
// every test does - never opens a socket as a side effect.
