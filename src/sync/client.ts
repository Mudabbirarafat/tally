/**
 * Talking to the server, on a connection that is usually bad and sometimes
 * absent.
 *
 * The order of operations here is the whole correctness argument, so it is
 * worth stating plainly:
 *
 *   1. **Push first, pull second.** Local work is the only copy of itself.
 *      Sending it before asking for anything means a sync interrupted
 *      halfway has already saved the part that could not be recovered.
 *   2. **Acknowledge only what the server confirmed.** The outbox shrinks on
 *      a response, never on a request. Crashing between the two means
 *      pushing again, which the server ignores.
 *   3. **Advance the cursor only after the page is stored.** Writing the
 *      cursor first and dying before the operations are persisted would skip
 *      them permanently - the server would never offer them again, because
 *      as far as it knows this device has read them.
 *
 * Every step is idempotent, because on a phone "did that request arrive?" is
 * frequently unanswerable. The only safe design is one where doing it twice
 * costs nothing.
 *
 * `fetch` is injected so the whole thing is testable against a fake network
 * that can be made to fail in the specific way being tested.
 */

import type { LedgerStore } from '../store/ledgerStore';
import type { Op } from './ledger';

export type SyncOutcome = {
  pushed: number;
  pulled: number;
  cursor: number;
  /** Set when the sync could not finish; the app stays usable regardless. */
  problem?: string;
  offline?: boolean;
};

export type SyncOptions = {
  baseUrl: string;
  trip: string;
  fetchImpl?: typeof fetch;
  /** Matches the server's cap; the server rejects more in one request. */
  batchSize?: number;
  /** Bounded so a sync cannot loop for ever against a broken server. */
  maxPages?: number;
};

type PushResponse = { accepted: number; duplicates: number; cursor: number };
type PullResponse = { ops: Op[]; cursor: number; more: boolean };

export class SyncClient {
  private readonly fetchImpl: typeof fetch;
  private readonly batchSize: number;
  private readonly maxPages: number;
  private inFlight: Promise<SyncOutcome> | null = null;

  constructor(
    private readonly store: LedgerStore,
    private readonly options: SyncOptions,
  ) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.batchSize = options.batchSize ?? 500;
    this.maxPages = options.maxPages ?? 100;
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, '')}/trips/${encodeURIComponent(
      this.options.trip,
    )}/ops${path}`;
  }

  /**
   * Run a sync, or join the one already running.
   *
   * Two syncs at once would push the same operations twice and race on the
   * cursor. Returning the in-flight promise means a user mashing the button
   * and a background timer firing both get the same single run.
   */
  sync(): Promise<SyncOutcome> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<SyncOutcome> {
    let pushed = 0;
    let pulled = 0;

    try {
      pushed = await this.push();
    } catch (problem) {
      // Pulling after a failed push is still useful: the device gets other
      // people's work even when it cannot send its own.
      const failure = describe(problem);
      try {
        pulled = await this.pull();
      } catch {
        return { pushed, pulled, cursor: this.store.cursor, ...failure };
      }
      return { pushed, pulled, cursor: this.store.cursor, ...failure };
    }

    try {
      pulled = await this.pull();
    } catch (problem) {
      return { pushed, pulled, cursor: this.store.cursor, ...describe(problem) };
    }

    return { pushed, pulled, cursor: this.store.cursor };
  }

  /** Send the outbox, in batches the server will accept. */
  private async push(): Promise<number> {
    const outbox = this.store.outbox;
    let sent = 0;

    for (let start = 0; start < outbox.length; start += this.batchSize) {
      const batch = outbox.slice(start, start + this.batchSize);
      const response = await this.fetchImpl(this.url(''), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops: batch }),
      });
      if (!response.ok) throw await asError(response);

      (await response.json()) as PushResponse;
      // Only now, with the server's answer in hand.
      await this.store.markSynced(batch);
      sent += batch.length;
    }
    return sent;
  }

  /** Read everything after the stored cursor, a page at a time. */
  private async pull(): Promise<number> {
    let received = 0;

    for (let page = 0; page < this.maxPages; page += 1) {
      const response = await this.fetchImpl(
        this.url(`?since=${this.store.cursor}&limit=${this.batchSize}`),
      );
      if (!response.ok) throw await asError(response);

      const body = (await response.json()) as PullResponse;
      if (body.ops.length > 0) {
        // Stored before the cursor moves, so an interruption here means the
        // page is simply fetched again rather than skipped.
        await this.store.receive(body.ops);
        received += body.ops.length;
      }
      await this.store.advanceCursor(body.cursor);

      if (!body.more) return received;
    }

    throw new Error(`stopped after ${this.maxPages} pages; the server kept saying there was more`);
  }
}

async function asError(response: Response): Promise<Error> {
  let detail = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: string };
    if (body?.error) detail = body.error;
  } catch {
    /* a non-JSON error body is still an error */
  }
  return new Error(detail);
}

/**
 * Tell "no network" apart from "the server said no".
 *
 * They need different words on screen: one is normal and resolves itself,
 * the other is a bug someone has to fix.
 */
function describe(problem: unknown): { problem: string; offline?: boolean } {
  const message = problem instanceof Error ? problem.message : String(problem);
  const offline =
    problem instanceof TypeError ||
    /network|fetch failed|load failed|ECONNREFUSED|ENOTFOUND/i.test(message);
  return offline ? { problem: message, offline: true } : { problem: message };
}
