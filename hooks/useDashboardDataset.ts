import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Firestore } from 'firebase/firestore';
import {
  listEntriesForClasses,
  listFeedbackHistoryForClasses,
  listPageSyncRecordsForClasses,
} from '../services/firestoreDataService';
import type { ClassLoadMode } from '../services/incrementalClassQuery';
import type { FeedbackHistoryRecord, PageSyncRecord, StoredDiaryEntry } from '../types';

/**
 * The Class Dashboard's dataset: every entry, page record and feedback record
 * of the selected classes.
 *
 * Loading (ARCHITECTURE §49):
 * - Opening the dashboard loads incrementally: only documents changed since the
 *   last load come from the server; the rest from Firestore's browser cache,
 *   checked against a server count so a stale cache falls back to a full load.
 * - `dataVersion` changes (App bumps it when a sync finishes) trigger another
 *   incremental load, so the dashboard picks up synced work by itself.
 * - `reload()` ("Reload saved data") always does a full load.
 * - A module-level copy, kept two minutes, serves instant reopens with no reads.
 */

const MEMORY_TTL_MS = 120_000;

interface DashboardDataset {
  entries: StoredDiaryEntry[];
  pageRecords: PageSyncRecord[];
  feedbackRecords: FeedbackHistoryRecord[];
  loadedAt: number;
  /** The App data version this copy reflects; a newer version means a sync finished since. */
  dataVersion: number;
}

const memory = new Map<string, DashboardDataset>();

/** Drop the in-memory copy, e.g. before an action that will change the data. */
export const invalidateDashboardDataset = (): void => memory.clear();

export const useDashboardDataset = (db: Firestore, uid: string, classIds: string[], dataVersion = 0) => {
  const [dataset, setDataset] = useState<DashboardDataset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fullReloadToken, setFullReloadToken] = useState(0);
  const handledReloadToken = useRef(0);

  // Stable key: callers often pass a fresh array on every render.
  const classIdsKey = useMemo(() => JSON.stringify([...classIds].sort()), [classIds]);

  useEffect(() => {
    const ids = JSON.parse(classIdsKey) as string[];
    const memoryKey = `${uid}|${classIdsKey}`;
    const remembered = memory.get(memoryKey);
    // Marked handled only on success: React StrictMode runs effects twice in
    // development, and the first (cancelled) run must not consume the reload.
    const forceFull = fullReloadToken !== handledReloadToken.current;
    let cancelled = false;

    if (
      !forceFull &&
      remembered &&
      remembered.loadedAt > Date.now() - MEMORY_TTL_MS &&
      remembered.dataVersion === dataVersion
    ) {
      setDataset(remembered);
      setError(null);
      setLoading(false);
      return;
    }

    const mode: ClassLoadMode = forceFull ? 'full' : 'incremental';
    setLoading(true);
    setError(null);
    Promise.all([
      listEntriesForClasses(db, uid, ids, mode),
      listPageSyncRecordsForClasses(db, uid, ids, mode),
      listFeedbackHistoryForClasses(db, uid, ids),
    ])
      .then(([entries, pageRecords, feedbackRecords]) => {
        const next = { entries, pageRecords, feedbackRecords, loadedAt: Date.now(), dataVersion };
        memory.set(memoryKey, next);
        if (!cancelled) {
          handledReloadToken.current = fullReloadToken;
          setDataset(next);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [db, uid, classIdsKey, dataVersion, fullReloadToken]);

  const reload = useCallback(() => {
    invalidateDashboardDataset();
    setFullReloadToken((token) => token + 1);
  }, []);

  return {
    entries: dataset?.entries ?? [],
    pageRecords: dataset?.pageRecords ?? [],
    feedbackRecords: dataset?.feedbackRecords ?? [],
    loadedAt: dataset?.loadedAt ?? null,
    loading,
    error,
    reload,
  };
};
