/**
 * The server derives an operation's identity itself rather than trusting the
 * client, so the two implementations must agree exactly. If they drift,
 * pushes stop being idempotent and the log quietly fills with duplicates.
 *
 * This file is excluded from the server's typecheck: it reaches across the
 * app/server boundary, where the two halves use different module resolution
 * on purpose. Vitest resolves it fine, and what is being checked is runtime
 * string equality, which types would not have caught anyway.
 */

import { describe, expect, it } from 'vitest';
import { opId as clientOpId, type Op as ClientOp } from '../../src/sync/ledger';
import { opId as serverOpId, type Op } from './protocol.ts';

describe('the identity contract', () => {
  it('computes the same operation id as the app does', () => {
    // The server derives ids itself rather than trusting the client, so the
    // two implementations have to agree exactly - if they drift, pushes stop
    // being idempotent and the log fills with duplicates.
    const cases: ClientOp[] = [
      { kind: 'field', entry: 'e1', field: 'description', value: 'Dinner', at: { wall: 1, counter: 0, device: 'a' } },
      { kind: 'field', entry: 'e1', field: 'amountMinor', value: 120050, at: { wall: 999999999999, counter: 7, device: 'phone-b' } },
      { kind: 'field', entry: 'e-2', field: 'deleted', value: true, at: { wall: 42, counter: 99999, device: 'd:with:colons' } },
      { kind: 'member', entry: 'e1', person: 'riya', present: true, at: { wall: 5, counter: 1, device: 'a' } },
      { kind: 'member', entry: 'e1', person: 'sam', present: false, at: { wall: 5, counter: 1, device: 'b' } },
    ];

    for (const value of cases) {
      expect(serverOpId(value as unknown as Op)).toBe(clientOpId(value));
    }
  });
});
