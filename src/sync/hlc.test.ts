/**
 * The clock is where offline sync quietly goes wrong, so it gets its own
 * tests. Every one of these describes a situation that actually happens to
 * phones: clocks that disagree, clocks that jump backwards when NTP
 * corrects them, and apps the OS kills and restarts.
 */

import { describe, expect, it } from 'vitest';
import { Clock, compare, format, isAfter, parse, type Hlc } from './hlc';

/** A clock whose wall time this test controls. */
function fixed(device: string, start = 1_000) {
  let wall = start;
  return {
    clock: new Clock(device, () => wall),
    set: (value: number) => {
      wall = value;
    },
    advance: (by: number) => {
      wall += by;
    },
  };
}

describe('ordering', () => {
  it('orders by wall time, then counter, then device', () => {
    const base: Hlc = { wall: 10, counter: 0, device: 'a' };
    expect(compare(base, { ...base, wall: 11 })).toBeLessThan(0);
    expect(compare(base, { ...base, counter: 1 })).toBeLessThan(0);
    expect(compare(base, { ...base, device: 'b' })).toBeLessThan(0);
  });

  it('never ties, so every replica sorts the same way', () => {
    // Two devices stamping in the same millisecond with the same counter
    // still have to produce a definite order, or "converged" would depend
    // on which phone you asked.
    const a: Hlc = { wall: 10, counter: 3, device: 'phone-a' };
    const b: Hlc = { wall: 10, counter: 3, device: 'phone-b' };
    expect(compare(a, b)).not.toBe(0);
    expect(compare(a, b)).toBe(-compare(b, a));
  });

  it('survives the round trip through storage', () => {
    const stamp: Hlc = { wall: 1_736_000_000_000, counter: 7, device: 'a:b:c' };
    // The device id contains colons, which a naive split would mangle.
    expect(parse(format(stamp))).toEqual(stamp);
  });

  it('sorts correctly as plain text, so a database can order by it', () => {
    const early = format({ wall: 9, counter: 0, device: 'a' });
    const late = format({ wall: 10, counter: 0, device: 'a' });
    expect(early < late).toBe(true);
  });

  it('rejects text that is not a timestamp', () => {
    expect(() => parse('nonsense')).toThrow(/not a timestamp/);
  });
});

describe('a single device', () => {
  it('advances the counter within one millisecond', () => {
    const { clock } = fixed('a');
    const first = clock.now();
    const second = clock.now();
    expect(second.wall).toBe(first.wall);
    expect(second.counter).toBe(first.counter + 1);
    expect(isAfter(second, first)).toBe(true);
  });

  it('never goes backwards when the system clock does', () => {
    // NTP corrections and manual time changes both do this, and a plain
    // Date.now() ordering would mis-sort every edit made in the window.
    const { clock, set } = fixed('a', 5_000);
    const before = clock.now();
    set(1_000); // the phone's clock jumps four seconds into the past
    const after = clock.now();

    expect(isAfter(after, before)).toBe(true);
    expect(after.wall).toBe(before.wall);
  });

  it('resets the counter once real time moves on', () => {
    const { clock, advance } = fixed('a');
    clock.now();
    clock.now();
    advance(10);
    expect(clock.now().counter).toBe(0);
  });

  it('refuses to exist without a device id', () => {
    expect(() => new Clock('')).toThrow(/device id/);
  });
});

describe('two devices', () => {
  it('puts a local edit after a remote one it has seen', () => {
    // Causality: b replies to something a said, so b's edit must sort
    // after it even though b's wall clock is behind.
    const a = fixed('a', 9_000);
    const b = fixed('b', 1_000);

    const fromA = a.clock.now();
    b.clock.observe(fromA);
    const fromB = b.clock.now();

    expect(isAfter(fromB, fromA)).toBe(true);
  });

  it('does not let a slow clock rewrite history after syncing', () => {
    const a = fixed('a', 9_000);
    const b = fixed('b', 1_000);

    const fromA = a.clock.now();
    b.clock.observe(fromA);
    for (let i = 0; i < 5; i += 1) {
      expect(isAfter(b.clock.now(), fromA)).toBe(true);
    }
  });

  it('keeps ordering stable when both have the same wall time', () => {
    const a = fixed('a', 1_000);
    const b = fixed('b', 1_000);
    const fromA = a.clock.now();
    b.clock.observe(fromA);
    expect(isAfter(b.clock.now(), fromA)).toBe(true);
  });
});

describe('surviving a restart', () => {
  it('does not rewind when the OS kills the app and it starts again', () => {
    // Process death is routine on mobile, not exceptional. A clock that
    // restarts at zero lets edits made after the restart sort before edits
    // made before it.
    const first = fixed('a', 2_000);
    first.clock.now();
    const saved = first.clock.snapshot();

    const restarted = new Clock('a', () => 1_500); // clock drifted backwards too
    restarted.restore(saved);

    expect(isAfter(restarted.now(), saved)).toBe(true);
  });
});
