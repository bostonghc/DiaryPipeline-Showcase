import { useEffect, useState } from 'react';
import type { Firestore } from 'firebase/firestore';
import { listPageSyncRecordsForClasses } from '../services/firestoreDataService';
import {
  deriveArchiveCaptureByClass,
  type ArchiveCaptureStatus,
} from '../services/archiveCaptureStatus';

/**
 * Archive capture status per class (Slice 5). A bounded subsystem: given the
 * classes in scope, it owns the page-sync-record read and the per-class capture
 * derivation, and hands App.tsx back a `Map<classId, ArchiveCaptureStatus>`.
 *
 * It reads page records directly (rather than reusing App's incremental
 * pageId→state cache) because those records carry `classId` and reflect every
 * synced page regardless of whether the notebook tree has lazy-loaded it — the
 * more truthful source for a completeness verdict. `refreshKey` lets the caller
 * force a re-read after a sync run completes.
 */
export const useArchiveCaptureStatus = (
  db: Firestore,
  uid: string | undefined,
  classIds: string[],
  refreshKey: number = 0
): Map<string, ArchiveCaptureStatus> => {
  const [statusByClass, setStatusByClass] = useState<Map<string, ArchiveCaptureStatus>>(new Map());

  // Stable dependency: order-independent join of class ids.
  const classKey = [...classIds].sort().join('|');

  useEffect(() => {
    if (!uid || classIds.length === 0) {
      setStatusByClass(new Map());
      return;
    }

    let cancelled = false;
    listPageSyncRecordsForClasses(db, uid, classIds)
      .then((records) => {
        if (!cancelled) setStatusByClass(deriveArchiveCaptureByClass(records));
      })
      .catch((err) => {
        console.warn('[useArchiveCaptureStatus] Failed to load page sync records:', err);
      });

    return () => {
      cancelled = true;
    };
    // classKey captures the set of class ids; refreshKey forces a post-sync re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, uid, classKey, refreshKey]);

  return statusByClass;
};
