/**
 * A hybrid logical clock, because two phones do not agree on the time.
 *
 * The obvious way to order edits made offline is `Date.now()`. It is also
 * wrong, and wrong in a way that only shows up in the field: phone clocks
 * drift, users change timezones, and a device whose clock is five minutes
 * fast silently wins every conflict for five minutes. Worse, a device whose
 * clock is *behind* can make a newer edit look older and lose it entirely.
 *
 * A hybrid logical clock keeps the wall clock for human legibility, but adds
 * a counter that advances on every event and on every message received. That
 * gives two properties this app needs:
 *
 *   1. Causality. If this device saw an edit before making its own, the new
 *      edit sorts after it - whatever the wall clocks say.
 *   2. A total order. Ties break on the device id, so two replicas sorting
 *      the same operations always produce the same sequence. Without that,
 *      "converged" would depend on which phone you asked.
 *
 * The device id is the tiebreaker of last resort, so it must be stable for
 * the life of an install and unique across devices.
 */

export type Hlc = {
  /** Milliseconds since the epoch, as this device understood them. */
  wall: number;
  /** Advances on ties, so events within the same millisecond stay ordered. */
  counter: number;
  /** Stable per install; the final tiebreak that makes the order total. */
  device: string;
};

/**
 * Order two timestamps. Negative when `a` happened first.
 *
 * Total and deterministic: every replica sorts the same operations into the
 * same sequence, which is what makes the merged state identical everywhere.
 */
export function compare(a: Hlc, b: Hlc): number {
  if (a.wall !== b.wall) return a.wall - b.wall;
  if (a.counter !== b.counter) return a.counter - b.counter;
  // Not meaningful on its own - it exists only so the order never ties.
  return a.device < b.device ? -1 : a.device > b.device ? 1 : 0;
}

export const isAfter = (a: Hlc, b: Hlc): boolean => compare(a, b) > 0;

/** A compact form for storage and the wire; sorts correctly as a string. */
export function format(stamp: Hlc): string {
  return `${stamp.wall.toString().padStart(15, '0')}:${stamp.counter
    .toString()
    .padStart(5, '0')}:${stamp.device}`;
}

export function parse(text: string): Hlc {
  const [wall, counter, ...device] = text.split(':');
  if (wall === undefined || counter === undefined || device.length === 0) {
    throw new Error(`not a timestamp: ${text}`);
  }
  // The device id may itself contain colons, so it is rejoined rather than
  // assumed to be a single segment.
  return { wall: Number(wall), counter: Number(counter), device: device.join(':') };
}

/**
 * The clock for one device.
 *
 * `now()` stamps a local edit. `observe()` folds in a timestamp that arrived
 * from somewhere else, which is what keeps causality: anything this device
 * does after seeing a remote edit sorts after that edit.
 */
export class Clock {
  private wall = 0;
  private counter = 0;

  constructor(
    readonly device: string,
    private readonly wallClock: () => number = Date.now,
  ) {
    if (!device) throw new Error('a clock needs a stable device id');
  }

  /** Stamp a local event. */
  now(): Hlc {
    const physical = this.wallClock();
    if (physical > this.wall) {
      // The wall clock moved on, so the counter can start over.
      this.wall = physical;
      this.counter = 0;
    } else {
      // Same millisecond, or the device clock went backwards (NTP correction,
      // a manual change, a timezone edit). Either way the logical clock must
      // not go backwards, so it advances the counter instead.
      this.counter += 1;
    }
    return { wall: this.wall, counter: this.counter, device: this.device };
  }

  /**
   * Fold in a remote timestamp.
   *
   * After this, every local event sorts after `incoming`, which is the whole
   * reason the clock is "hybrid" rather than just a wall clock.
   */
  observe(incoming: Hlc): void {
    const physical = this.wallClock();
    const highest = Math.max(this.wall, incoming.wall, physical);

    if (highest === this.wall && highest === incoming.wall) {
      this.counter = Math.max(this.counter, incoming.counter) + 1;
    } else if (highest === this.wall) {
      this.counter += 1;
    } else if (highest === incoming.wall) {
      this.counter = incoming.counter + 1;
    } else {
      // The physical clock is ahead of both; a fresh millisecond, fresh count.
      this.counter = 0;
    }
    this.wall = highest;
  }

  /** Current state, for persisting across an app restart. */
  snapshot(): Hlc {
    return { wall: this.wall, counter: this.counter, device: this.device };
  }

  /**
   * Restore a persisted clock.
   *
   * Without this, an app restart resets the logical clock and edits made
   * after the restart can sort before edits made before it - the process
   * death problem, which on mobile is routine rather than exceptional.
   */
  restore(stamp: Hlc): void {
    this.wall = Math.max(this.wall, stamp.wall);
    this.counter = stamp.wall === this.wall ? Math.max(this.counter, stamp.counter) : this.counter;
  }
}
