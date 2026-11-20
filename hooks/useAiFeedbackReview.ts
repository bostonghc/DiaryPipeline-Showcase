import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { applyCommentAt, shiftComments } from '../services/aiFeedbackReview';
import type { AiReviewClientRequest, AiReviewComment } from '../services/aiFeedbackReview';
import type { AiFeedbackReviewRecord } from '../services/aiReviewServer';
import { postAiReviewOutcome, requestAiReview } from '../services/aiReviewClient';

export interface AiReviewEntryState {
  review: AiFeedbackReviewRecord;
  /** Text the comment offsets refer to. Starts as the snapshot; changes only when Apply succeeds. */
  expectedText: string;
  comments: AiReviewComment[];
}

export interface AiReviewError { message: string; code?: string }

export const OUTCOME_ERROR_TEXT = "Couldn't save that — retry";
const EMPTY = Object.freeze({}) as Record<string, never>;
type OutcomeStatus = 'applied' | 'dismissed';
interface Deps { firebaseUser: User | null; microsoftUpn?: string | null; addLog: (m: string) => void }

/**
 * Client state machine for AI feedback review. State is keyed by caller key
 * (entryId-fieldKey) within one uid; a response is applied only if it is the
 * latest generation for its key and the uid has not changed since the request.
 * Never logs tokens or feedback text.
 */
export function useAiFeedbackReview({ firebaseUser, microsoftUpn, addLog }: Deps) {
  const uid = firebaseUser?.uid ?? null;
  const scope = `${uid ?? ''}|${(microsoftUpn ?? '').trim().toLowerCase()}`;
  const userRef = useRef(firebaseUser);
  userRef.current = firebaseUser;

  const [byKey, setByKeyState] = useState<Record<string, AiReviewEntryState>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, AiReviewError>>({});
  const [outcomeErrors, setOutcomeErrors] = useState<Record<string, string>>({});

  // Synchronous mirror so apply() can read and write without waiting for a render.
  const byKeyRef = useRef(byKey);
  const setByKey = useCallback((next: Record<string, AiReviewEntryState>) => {
    byKeyRef.current = next;
    setByKeyState(next);
  }, []);
  const generations = useRef(new Map<string, number>());
  // Review ids per entry in arrival order (oldest first), and ids with an applied outcome.
  const entryReviewIds = useRef(new Map<string, Set<string>>());
  const appliedReviewIds = useRef(new Set<string>());
  // Outcomes not yet saved, per key, indexed by reviewId|commentId. Survives re-review.
  const unconfirmed = useRef(new Map<string, Map<string, { reviewId: string; commentId: string; status: OutcomeStatus }>>());

  // The scope is the Firebase uid plus the live Microsoft account. On any change
  // everything resets synchronously during render, so no callback can see the old
  // scope's data. The epoch only ever increases: generations restart from 1 after a
  // reset, so a response from an earlier visit to the same scope (A -> B -> A) must
  // be told apart by epoch, not generation.
  const [stateScope, setStateScope] = useState(scope);
  const discardedOutcomes = useRef(0);
  // Outcome POSTs are serialised per reviewId|commentId so an older request can never settle after a newer one.
  const outcomeChains = useRef(new Map<string, Promise<void>>());
  const scopeRef = useRef(scope);
  const epochRef = useRef(0);
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    epochRef.current += 1;
    generations.current = new Map();
    entryReviewIds.current = new Map();
    appliedReviewIds.current = new Set();
    let dropped = 0;
    unconfirmed.current.forEach((m) => { dropped += m.size; });
    discardedOutcomes.current += dropped;
    unconfirmed.current = new Map();
    outcomeChains.current = new Map();
    byKeyRef.current = {};
  }

  // Clear rendered state when the scope changes.
  useEffect(() => {
    if (discardedOutcomes.current > 0) {
      addLog(`[AiReview] discarded ${discardedOutcomes.current} unsaved outcome(s) on sign-in change`);
      discardedOutcomes.current = 0;
    }
    setStateScope(scope);
    setByKey({});
    setPending({});
    setErrors({});
    setOutcomeErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, setByKey]);

  const setOutcomeError = (key: string, message: string | null) =>
    setOutcomeErrors((prev) => {
      if (message === null) {
        if (!(key in prev)) return prev;
        const { [key]: _drop, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: message };
    });

  /** Remove only the error fixed by a completed recovery action. */
  const clearError = useCallback((key: string, code: string, expectedEpoch?: number) => {
    if (expectedEpoch !== undefined && epochRef.current !== expectedEpoch) return;
    setErrors((prev) => {
      if (expectedEpoch !== undefined && epochRef.current !== expectedEpoch) return prev;
      if (prev[key]?.code !== code) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  }, []);

  const review = useCallback(
    async (key: string, request: Omit<AiReviewClientRequest, 'idToken'>): Promise<void> => {
      const user = userRef.current;
      if (!user) return;
      const epoch = epochRef.current;
      const gen = (generations.current.get(key) ?? 0) + 1;
      generations.current.set(key, gen);
      const current = () => generations.current.get(key) === gen && epochRef.current === epoch;

      setPending((p) => ({ ...p, [key]: true }));
      setErrors((e) => {
        if (!(key in e)) return e;
        const { [key]: _drop, ...rest } = e;
        return rest;
      });
      try {
        const idToken = await user.getIdToken();
        if (epochRef.current !== epoch) return;
        const supersedesReviewId = byKeyRef.current[key]?.review.reviewId;
        const body: AiReviewClientRequest = { ...request, idToken, ...(supersedesReviewId ? { supersedesReviewId } : {}) };
        const { review: record } = await requestAiReview(body);
        // The server saved this review even if the UI no longer wants it.
        if (epochRef.current === epoch) {
          const ids = entryReviewIds.current.get(request.entryId) ?? new Set<string>();
          ids.add(record.reviewId);
          entryReviewIds.current.set(request.entryId, ids);
        }
        if (!current()) return;
        const next = { ...byKeyRef.current };
        next[key] = { review: record, expectedText: request.feedbackText, comments: record.comments };
        setByKey(next);
      } catch (e: any) {
        if (!current()) return;
        setErrors((prev) => ({ ...prev, [key]: { message: e?.message || 'AI review failed. Try again.', code: typeof e?.code === 'string' ? e.code : undefined } }));
        addLog(`[AiReview] request failed (${e?.code ?? 'error'})`);
      } finally {
        if (current()) {
          setPending((p) => {
            const { [key]: _drop, ...rest } = p;
            return rest;
          });
        }
      }
    },
    [addLog, setByKey]
  );

  const sendOutcome = useCallback(
    (key: string, reviewId: string, commentId: string, status: OutcomeStatus): Promise<void> => {
      const user = userRef.current;
      if (!user) return Promise.resolve();
      const epoch = epochRef.current;
      const id = `${reviewId}|${commentId}`;
      const stored = () => unconfirmed.current.get(key)?.get(id)?.status;
      const run = async () => {
        if (epochRef.current !== epoch) return;
        // Superseded while queued (for example dismissed, then applied): the newer request carries it.
        if (stored() !== undefined && stored() !== status) return;
        try {
          const idToken = await user.getIdToken();
          if (epochRef.current !== epoch) return;
          const res = await postAiReviewOutcome({ idToken, reviewId, commentId, status });
          if (epochRef.current !== epoch) return;
          if (stored() === status) unconfirmed.current.get(key)?.delete(id);
          const entry = byKeyRef.current[key];
          if (entry && entry.review.reviewId === reviewId) {
            // A server dismissed never overwrites a local applied (applied is final).
            const merged = { ...entry.review.outcomes, ...res.outcomes };
            for (const [cid, o] of Object.entries(entry.review.outcomes)) {
              if (o.status === 'applied') merged[cid] = o;
            }
            setByKey({ ...byKeyRef.current, [key]: { ...entry, review: { ...entry.review, outcomes: merged } } });
          }
          if ((unconfirmed.current.get(key)?.size ?? 0) === 0) setOutcomeError(key, null);
        } catch (e: any) {
          if (epochRef.current !== epoch) return;
          if (stored() !== status) return;
          setOutcomeError(key, OUTCOME_ERROR_TEXT);
          addLog(`[AiReview] outcome save failed (${e?.code ?? 'error'}): ${e?.message ?? ''}`);
        }
      };
      const chained = (outcomeChains.current.get(id) ?? Promise.resolve()).then(run);
      outcomeChains.current.set(id, chained.catch(() => {}));
      return chained;
    },
    [addLog, setByKey]
  );

  const markLocal = (key: string, commentId: string, status: OutcomeStatus, comments?: AiReviewComment[], expectedText?: string) => {
    const entry = byKeyRef.current[key];
    const outcomes = { ...entry.review.outcomes, [commentId]: { status, at: new Date().toISOString(), byUpn: '' } };
    setByKey({
      ...byKeyRef.current,
      [key]: {
        review: { ...entry.review, outcomes },
        expectedText: expectedText ?? entry.expectedText,
        comments: comments ?? entry.comments,
      },
    });
    if (status === 'applied') appliedReviewIds.current.add(entry.review.reviewId);
    const map = unconfirmed.current.get(key) ?? new Map();
    map.set(`${entry.review.reviewId}|${commentId}`, { reviewId: entry.review.reviewId, commentId, status });
    unconfirmed.current.set(key, map);
  };

  const apply = useCallback(
    (key: string, reviewId: string, commentId: string, currentText: string): string | null => {
      const entry = byKeyRef.current[key];
      if (!entry || entry.review.reviewId !== reviewId) return null;
      if (currentText !== entry.expectedText) return null;
      // Dismissed may still become applied; applied is final.
      if (entry.review.outcomes[commentId]?.status === 'applied') return null;
      const comment = entry.comments.find((c) => c.id === commentId);
      if (!comment) return null;
      const result = applyCommentAt(entry.expectedText, comment);
      if (!result) return null;
      const shifted = shiftComments(entry.comments, { id: comment.id, start: comment.start, end: comment.end }, result.delta);
      markLocal(key, commentId, 'applied', shifted, result.text);
      void sendOutcome(key, reviewId, commentId, 'applied');
      return result.text;
    },
    [sendOutcome]
  );

  const dismiss = useCallback(
    async (key: string, reviewId: string, commentId: string): Promise<void> => {
      const entry = byKeyRef.current[key];
      if (!entry || entry.review.reviewId !== reviewId) return;
      if (entry.review.outcomes[commentId]?.status === 'applied') return;
      if (!entry.comments.some((c) => c.id === commentId)) return;
      markLocal(key, commentId, 'dismissed');
      await sendOutcome(key, reviewId, commentId, 'dismissed');
    },
    [sendOutcome]
  );

  const retryOutcome = useCallback(
    async (key: string): Promise<void> => {
      const todo = Array.from(unconfirmed.current.get(key) ?? []);
      for (const [, { reviewId, commentId, status }] of todo) {
        await sendOutcome(key, reviewId, commentId, status);
      }
    },
    [sendOutcome]
  );

  /**
   * Review ids to record on a sent entry, at most 20, in priority order: the
   * current review of each field, then reviews with an applied outcome, then the
   * rest newest first. `omitted` counts the ids that did not fit.
   */
  const sentReviewRefsForEntry = useCallback((entryId: string): { ids: string[]; omitted: number } => {
    const all = Array.from(entryReviewIds.current.get(entryId) ?? []);
    const ordered: string[] = [];
    const seen = new Set<string>();
    const add = (id: string) => { if (all.includes(id) && !seen.has(id)) { seen.add(id); ordered.push(id); } };
    Object.values(byKeyRef.current).forEach((e) => { if (e.review.entryId === entryId) add(e.review.reviewId); });
    all.forEach((id) => { if (appliedReviewIds.current.has(id)) add(id); });
    [...all].reverse().forEach(add);
    return { ids: ordered.slice(0, 20), omitted: Math.max(0, ordered.length - 20) };
  }, []);

  const reviewIdsForEntry = useCallback((entryId: string): string[] => sentReviewRefsForEntry(entryId).ids, [sentReviewRefsForEntry]);

  const live = stateScope === scope;
  const NONE = EMPTY;
  return {
    scopeEpoch: epochRef.current,
    byKey: live ? byKey : (NONE as Record<string, AiReviewEntryState>),
    pending: live ? pending : (NONE as Record<string, boolean>),
    errors: live ? errors : (NONE as Record<string, AiReviewError>),
    outcomeErrors: live ? outcomeErrors : (NONE as Record<string, string>),     reviewIdsForEntry, sentReviewRefsForEntry, review, apply, dismiss, retryOutcome, clearError,
  };
}
