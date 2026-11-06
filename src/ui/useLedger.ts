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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Entry, Transfer } from '../sync/ledger';
import { LedgerStore, type NewExpense } from '../store/ledgerStore';
import { deviceStorage, type Storage } from '../store/storage';

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
      recovered: boolean;
      addExpense: (expense: NewExpense) => Promise<void>;
      removeExpense: (id: string) => Promise<void>;
    };

export function useLedger(storage?: Storage): LedgerState {
  const store = useRef<LedgerStore | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    LedgerStore.open(storage ?? deviceStorage())
      .then((opened) => {
        if (!live) return;
        store.current = opened;
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

  const addExpense = useCallback(
    async (expense: NewExpense) => {
      await store.current?.addExpense(expense);
      bump();
    },
    [bump],
  );

  const removeExpense = useCallback(
    async (id: string) => {
      await store.current?.removeExpense(id);
      bump();
    },
    [bump],
  );

  return useMemo<LedgerState>(() => {
    if (error) return { status: 'failed', error };
    const current = store.current;
    if (!open || !current) return { status: 'opening' };

    const entries = current.entries;
    const people = [
      ...new Set(entries.flatMap((entry) => [entry.payer, ...entry.participants])),
    ]
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
      recovered: current.hadCorruptStorage,
      addExpense,
      removeExpense,
    };
    // `version` is the dependency that matters: it changes when the store does.
  }, [open, error, version, addExpense, removeExpense]);
}
