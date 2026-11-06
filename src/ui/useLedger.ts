/**
 * The ledger, wired to React.
 *
 * The store is the source of truth and it is mutable, so this keeps a
 * version counter rather than mirroring entries into state. Copying the
 * ledger into React state would give two copies that can disagree, and the
 * one on screen would be the one that is wrong.
 *
 * Opening is asynchronous because reading from disk is, and the UI has to
 * cope with the gap: on a cold start the app is briefly a ledger that does
 * not exist yet. That is a real state, not an edge case, so it is modelled.
 *
 * Syncing never blocks an edit. Adding an expense writes to disk and returns;
 * the sync is a separate thing that may fail, and the app stays fully usable
 * when it does. That is the whole point of offline-first - the network is a
 * convenience, not a dependency.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LedgerStore, type NewExpense } from '../store/ledgerStore';
import { deviceStorage, type Storage } from '../store/storage';
import { SyncClient, type SyncOutcome } from '../sync/client';
import type { Entry, Transfer } from '../sync/ledger';

/**
 * Overridden at build time. Empty is a real configuration, not a mistake:
 * the app is useful with no server at all, and a build that has not been
 * given one should say "local only" rather than spend its life reporting a
 * connection failure it was never meant to make.
 */
const SYNC_URL = process.env.EXPO_PUBLIC_SYNC_URL ?? '';
const TRIP = process.env.EXPO_PUBLIC_TRIP ?? 'demo';

export type LedgerState =
  | { status: 'opening' }
  | { status: 'failed'; error: string }
  | {
      status: 'ready';
      entries: Entry[];
      balances: [string, number][];
      transfers: Transfer[];
      people: string[];
      pending: number;
      device: string;
      trip: string;
      recovered: boolean;
      syncing: boolean;
      lastSync: SyncOutcome | null;
      /** False when this build has no sync server configured at all. */
      syncEnabled: boolean;
      addExpense: (expense: NewExpense) => Promise<void>;
      removeExpense: (id: string) => Promise<void>;
      sync: () => Promise<void>;
    };

export function useLedger(storage?: Storage): LedgerState {
  const store = useRef<LedgerStore | null>(null);
  const client = useRef<SyncClient | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncOutcome | null>(null);

  useEffect(() => {
    let live = true;
    LedgerStore.open(storage ?? deviceStorage())
      .then((opened) => {
        if (!live) return;
        store.current = opened;
        client.current = SYNC_URL
          ? new SyncClient(opened, { baseUrl: SYNC_URL, trip: TRIP })
          : null;
        setOpen(true);
      })
      .catch((problem: unknown) => {
        if (live) setError(problem instanceof Error ? problem.message : String(problem));
      });
    return () => {
      live = false;
    };
  }, [storage]);

  const bump = useCallback(() => setVersion((n) => n + 1), []);

  const sync = useCallback(async () => {
    if (!client.current) return;
    setSyncing(true);
    try {
      // A failed sync is an outcome, not an exception: the app carries on
      // working offline and the banner says what happened.
      setLastSync(await client.current.sync());
    } finally {
      setSyncing(false);
      bump();
    }
  }, [bump]);

  // One sync on open, so a phone that was offline yesterday catches up
  // without the person having to ask.
  useEffect(() => {
    if (open) void sync();
  }, [open, sync]);

  const addExpense = useCallback(
    async (expense: NewExpense) => {
      await store.current?.addExpense(expense);
      bump();
      void sync();
    },
    [bump, sync],
  );

  const removeExpense = useCallback(
    async (id: string) => {
      await store.current?.removeExpense(id);
      bump();
      void sync();
    },
    [bump, sync],
  );

  return useMemo<LedgerState>(() => {
    if (error) return { status: 'failed', error };
    const current = store.current;
    if (!open || !current) return { status: 'opening' };

    const entries = current.entries;
    const people = [...new Set(entries.flatMap((entry) => [entry.payer, ...entry.participants]))]
      .filter(Boolean)
      .sort();

    return {
      status: 'ready',
      entries: [...entries].reverse(), // newest first, as a list of spending should be
      balances: [...current.balances().entries()].sort((a, b) => b[1] - a[1]),
      transfers: current.settle(),
      people,
      pending: current.pending,
      device: current.device,
      trip: TRIP,
      recovered: current.hadCorruptStorage,
      syncing,
      lastSync,
      syncEnabled: SYNC_URL !== '',
      addExpense,
      removeExpense,
      sync,
    };
    // `version` is the dependency that matters: it changes when the store does.
  }, [open, error, version, syncing, lastSync, addExpense, removeExpense, sync]);
}
