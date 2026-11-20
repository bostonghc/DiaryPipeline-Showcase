import { useCallback, useEffect, useRef, useState } from 'react';
import type { Firestore } from 'firebase/firestore';
import type { FeedbackHistoryRecord } from '../types';
import { fetchRecentFeedbackForPage, fetchRecentFeedbackForStudent } from '../services/firestoreDataService';

export interface UsePastFeedbackParams {
  db: Firestore;
  uid: string | undefined;
  activePageId: string | null | undefined;
  activeClassId: string | null | undefined;
  activeStudentUpn: string;
  addLog: (m: string) => void;
}

export const pastFeedbackScopeKey = (
  uid: string | null | undefined,
  classId: string | null | undefined,
  studentUpn: string,
  pageId: string | null | undefined
): string => `${uid ?? ''}|${classId && studentUpn ? `${classId}|${studentUpn}` : `page|${pageId ?? ''}`}`;

/**
 * Recent feedback for the active student. Queries by (classId, studentUpn) once
 * the UPN is resolved so history spans all pages for the student; falls back to
 * the page-scoped query otherwise. Records are returned only when the loaded
 * scope equals the requested scope, so a stale scope never shows another
 * student's history while the next one loads.
 */
export function usePastFeedbackForStudent(p: UsePastFeedbackParams) {
  const { db, uid, activePageId, activeClassId, activeStudentUpn, addLog } = p;
  const scopeKey = pastFeedbackScopeKey(uid, activeClassId, activeStudentUpn, activePageId);
  const [loaded, setLoaded] = useState<{ scopeKey: string; records: FeedbackHistoryRecord[] }>({ scopeKey: '', records: [] });
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;

  useEffect(() => {
    if (!uid || !activePageId) {
      setLoaded({ scopeKey: '', records: [] });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const records = activeClassId && activeStudentUpn
          ? await fetchRecentFeedbackForStudent(db, uid, activeClassId, activeStudentUpn, 5)
          : await fetchRecentFeedbackForPage(db, uid, activePageId, 5);
        if (cancelled) return;
        setLoaded({ scopeKey, records });
      } catch (e: any) {
        if (cancelled) return;
        addLog(`[PastFeedback] Error: ${e?.message || String(e)}`);
        console.error('Could not load past feedback for student', e);
        setLoaded({ scopeKey, records: [] });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, activePageId, activeClassId, activeStudentUpn]);

  /**
   * Update records loaded for the scope current at call time. A caller holding a
   * stale closure (older scope) is a no-op; records are never relabelled.
   */
  const setRecords = useCallback(
    (update: (prev: FeedbackHistoryRecord[]) => FeedbackHistoryRecord[]) => {
      // `scopeKey` is the scope of the render that created this callback; a caller
      // holding an older closure is a no-op once the scope has moved on.
      const captured = scopeKey;
      if (captured !== scopeKeyRef.current) return;
      setLoaded((prev) => (prev.scopeKey === captured ? { scopeKey: captured, records: update(prev.records) } : prev));
    },
    [scopeKey]
  );

  const isLoading = !!uid && !!activePageId && loaded.scopeKey !== scopeKey;

  return {
    records: loaded.scopeKey === scopeKey ? loaded.records : [],
    isLoading,
    scopeKey,
    setRecords,
  };
}
