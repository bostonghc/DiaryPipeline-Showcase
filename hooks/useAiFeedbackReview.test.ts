// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAiReviewAvailability } from '../services/aiReviewClient';
import type { IdentityBindingStatus } from './useIdentityBinding';
import { useAiFeedbackReview } from './useAiFeedbackReview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ready = {
  canUseAiReview: true, configured: true, microsoftSignedIn: true, hasFirebaseUser: true,
  bindingStatus: 'bound' as IdentityBindingStatus, pilotEnabled: true, entrySaved: true, feedbackText: 'Good work.',
};

describe('resolveAiReviewAvailability', () => {
  it('is ready when everything holds', () => {
    expect(resolveAiReviewAvailability(ready)).toEqual({ state: 'ready' });
  });
  const cases: Array<[string, Partial<typeof ready>, string, string | undefined]> = [
    ['role', { canUseAiReview: false }, 'role_not_enabled', undefined],
    ['config', { configured: false }, 'not_configured', undefined],
    ['ms', { microsoftSignedIn: false }, 'microsoft_signed_out', 'sign_in_microsoft'],
    ['ms expiry (profile unknown)', { canUseAiReview: false, configured: false, microsoftSignedIn: false }, 'microsoft_signed_out', 'sign_in_microsoft'],
    ['google before role', { canUseAiReview: false, hasFirebaseUser: false }, 'google_signed_out', 'sign_in_google'],
    ['binding before role', { canUseAiReview: false, bindingStatus: 'error' }, 'binding_failed', 'retry_binding'],
    ['google', { hasFirebaseUser: false }, 'google_signed_out', 'sign_in_google'],
    ['binding', { bindingStatus: 'binding' }, 'binding_pending', undefined],
    ['binding idle', { bindingStatus: 'idle' }, 'binding_pending', undefined],
    ['binding err', { bindingStatus: 'error' }, 'binding_failed', 'retry_binding'],
    ['unsaved', { entrySaved: false }, 'entry_not_saved', 'save_draft'],
    ['empty', { feedbackText: '  ' }, 'empty_feedback', undefined],
  ];
  it.each(cases)('%s', (_n, over, reason, action) => {
    const r = resolveAiReviewAvailability({ ...ready, ...over });
    expect(r).toMatchObject({ state: 'unavailable', reason });
    expect((r as { action?: string }).action).toBe(action);
  });
  it('checks sign-in states before capability, then role, config, save, text', () => {
    const r = resolveAiReviewAvailability({ ...ready, canUseAiReview: false, entrySaved: false, feedbackText: '' });
    expect(r).toMatchObject({ reason: 'role_not_enabled' });
    expect(resolveAiReviewAvailability({ ...ready, canUseAiReview: false, configured: false })).toMatchObject({ reason: 'role_not_enabled' });
    expect(resolveAiReviewAvailability({ ...ready, configured: false, entrySaved: false })).toMatchObject({ reason: 'not_configured' });
    const expired = resolveAiReviewAvailability({ ...ready, canUseAiReview: false, microsoftSignedIn: false });
    expect((expired as { message: string }).message).not.toMatch(/course owner/i);
    expect(resolveAiReviewAvailability({ ...ready, entrySaved: false, feedbackText: '' })).toMatchObject({ reason: 'entry_not_saved' });
  });
  it('ignores binding when not in pilot mode', () => {
    expect(resolveAiReviewAvailability({ ...ready, pilotEnabled: false, bindingStatus: 'error' })).toEqual({ state: 'ready' });
  });
});

const TEXT = 'Alpha beta gamma delta.';
const mkComment = (id: string, quote: string, suggestion?: string) => {
  const start = quote ? TEXT.indexOf(quote) : -1;
  return {
    id, quote, start, end: quote ? start + quote.length : -1,
    category: 'accuracy', basis: 'general_practice', note: 'n', ...(suggestion !== undefined ? { suggestion } : {}),
  };
};
const mkReview = (reviewId: string, comments: unknown[], entryId = 'e1', fieldKey = 'overall') => ({
  review: {
    reviewId, entryId, fieldKey, comments, outcomes: {}, summary: 's',
    inputs: { feedbackTextSnapshot: TEXT },
  },
});
const reqBase = {
  classId: 'c', pageId: 'p', entryId: 'e1', fieldKey: 'overall' as const, feedbackText: TEXT,
  priorFeedbackIds: [], reviewFocus: 'f', reviewFocusSource: 'default' as const, tone: 't', itemCountSetting: '3-4' as const,
};
const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const errJson = (status: number, error: string, message: string) => ({ ok: false, status, json: async () => ({ error, message }) });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

describe('useAiFeedbackReview', () => {
  const fetchMock = vi.fn();
  let root: Root;
  let api: ReturnType<typeof useAiFeedbackReview>;
  const mkUser = (uid: string) => ({ uid, getIdToken: vi.fn().mockResolvedValue(`tok-${uid}`) }) as never;
  const renderLog: number[] = [];
  const Probe = (p: { user: unknown; upn: string | null }) => { api = useAiFeedbackReview({ firebaseUser: p.user as never, microsoftUpn: p.upn, addLog: () => {} }); renderLog.push(Object.keys(api.byKey).length); return null; };
  const render = (user: unknown, upn: string | null = 'a@x.com') => act(async () => root.render(createElement(Probe, { user, upn })));
  const u1 = mkUser('u1');

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    root = createRoot(document.createElement('div'));
  });
  afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

  it('stores a review, sends the token and supersedes the previous review id', async () => {
    await render(u1);
    fetchMock.mockResolvedValueOnce(okJson(mkReview('r1', [mkComment('c1', 'beta', 'BETA')])));
    await act(async () => api.review('e1-overall', reqBase));
    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body1.idToken).toBe('tok-u1');
    expect(body1.supersedesReviewId).toBeUndefined();
    expect(api.byKey['e1-overall'].expectedText).toBe(TEXT);
    fetchMock.mockResolvedValueOnce(okJson(mkReview('r2', [])));
    await act(async () => api.review('e1-overall', reqBase));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).supersedesReviewId).toBe('r1');
    expect(api.reviewIdsForEntry('e1').sort()).toEqual(['r1', 'r2']);
  });

  it('reports a server error message', async () => {
    await render(u1);
    fetchMock.mockResolvedValueOnce(errJson(403, 'forbidden', 'Nope.'));
    await act(async () => api.review('k', reqBase));
    expect(api.errors.k).toEqual({ message: 'Nope.', code: 'forbidden' });
    expect(api.pending.k).toBeFalsy();
  });

  it('lets the newer generation win when responses arrive in reverse order', async () => {
    await render(u1);
    const d1 = deferred<unknown>(); const d2 = deferred<unknown>();
    fetchMock.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);
    let p1!: Promise<void>; let p2!: Promise<void>;
    await act(async () => { p1 = api.review('k', reqBase); await Promise.resolve(); });
    await act(async () => { p2 = api.review('k', reqBase); await Promise.resolve(); });
    await act(async () => { d2.resolve(okJson(mkReview('new', []))); await p2; });
    await act(async () => { d1.resolve(okJson(mkReview('old', []))); await p1; });
    expect(api.byKey.k.review.reviewId).toBe('new');
    expect(api.reviewIdsForEntry('e1').sort()).toEqual(['new', 'old']);
    expect(api.pending.k).toBeFalsy();
  });

  it('discards a response after the uid changes and clears state', async () => {
    await render(u1);
    fetchMock.mockResolvedValueOnce(okJson(mkReview('r1', [])));
    await act(async () => api.review('k', reqBase));
    expect(api.byKey.k).toBeDefined();
    const d = deferred<unknown>();
    fetchMock.mockReturnValueOnce(d.promise);
    let p!: Promise<void>;
    await act(async () => { p = api.review('k2', reqBase); await Promise.resolve(); });
    await render(mkUser('u2'));
    expect(api.byKey).toEqual({});
    expect(api.pending).toEqual({});
    expect(api.reviewIdsForEntry('e1')).toEqual([]);
    await act(async () => { d.resolve(okJson(mkReview('late', []))); await p; });
    expect(api.byKey).toEqual({});
    expect(api.reviewIdsForEntry('e1')).toEqual([]);
  });

  describe('apply and dismiss', () => {
    const setup = async () => {
      await render(u1);
      fetchMock.mockResolvedValueOnce(okJson(mkReview('r1', [
        mkComment('c1', 'Alpha', 'ALPHA!!'), mkComment('c2', 'gamma', 'GAMMA'), mkComment('c3', ''),
      ])));
      await act(async () => api.review('k', reqBase));
      fetchMock.mockReset();
    };

    it('returns null when text differs from expectedText', async () => {
      await setup();
      let out: string | null = 'x';
      act(() => { out = api.apply('k', 'r1', 'c1', TEXT + ' edited'); });
      expect(out).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('applies, shifts later comments, updates expectedText and posts the outcome', async () => {
      await setup();
      fetchMock.mockResolvedValue(okJson({ ok: true, outcomes: { c1: { status: 'applied', at: 't', byUpn: 'u' } } }));
      let out: string | null = null;
      await act(async () => { out = api.apply('k', 'r1', 'c1', TEXT); });
      expect(out).toBe('ALPHA!! beta gamma delta.');
      const e = api.byKey.k;
      expect(e.expectedText).toBe(out);
      const c2 = e.comments.find((c) => c.id === 'c2')!;
      expect(out!.slice(c2.start, c2.end)).toBe('gamma');
      expect(e.review.outcomes.c1.status).toBe('applied');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(fetchMock.mock.calls[0][0]).toBe('/api/ai/review-feedback/outcome');
      expect(body).toMatchObject({ reviewId: 'r1', commentId: 'c1', status: 'applied', idToken: 'tok-u1' });
      // second apply against the new expected text still works
      let out2: string | null = null;
      await act(async () => { out2 = api.apply('k', 'r1', 'c2', out!); });
      expect(out2).toBe('ALPHA!! beta GAMMA delta.');
    });

    it('returns null for an unknown review id, comment or whole-message comment', async () => {
      await setup();
      expect(api.apply('k', 'other', 'c1', TEXT)).toBeNull();
      expect(api.apply('k', 'r1', 'nope', TEXT)).toBeNull();
      expect(api.apply('k', 'r1', 'c3', TEXT)).toBeNull();
    });

    it('keeps local status and sets outcomeErrors on failure, then retries', async () => {
      await setup();
      fetchMock.mockResolvedValueOnce(errJson(503, 'save_failed', 'Try later.'));
      await act(async () => { api.apply('k', 'r1', 'c1', TEXT); });
      expect(api.outcomeErrors.k).toBe("Couldn't save that — retry");
      expect(api.byKey.k.review.outcomes.c1.status).toBe('applied');
      fetchMock.mockResolvedValueOnce(okJson({ ok: true, outcomes: { c1: { status: 'applied', at: 't', byUpn: 'u' } } }));
      await act(async () => { await api.retryOutcome('k'); });
      expect(api.outcomeErrors.k).toBeUndefined();
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ commentId: 'c1', status: 'applied' });
    });

    it('keeps an unsaved outcome across re-review and retries it under its own reviewId', async () => {
      await setup();
      fetchMock.mockResolvedValueOnce(errJson(503, 'save_failed', 'x'));
      await act(async () => { api.apply('k', 'r1', 'c1', TEXT); });
      expect(api.outcomeErrors.k).toBeDefined();
      fetchMock.mockResolvedValueOnce(okJson(mkReview('r2', [])));
      await act(async () => api.review('k', reqBase));
      expect(api.byKey.k.review.reviewId).toBe('r2');
      expect(api.outcomeErrors.k).toBeDefined();
      fetchMock.mockResolvedValueOnce(okJson({ ok: true, outcomes: {} }));
      await act(async () => { await api.retryOutcome('k'); });
      expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ reviewId: 'r1', commentId: 'c1', status: 'applied' });
      expect(api.outcomeErrors.k).toBeUndefined();
    });

    it('re-enables Apply when a manual edit is reverted to the expected text', async () => {
      await setup();
      expect(api.apply('k', 'r1', 'c2', TEXT + '!')).toBeNull();
      fetchMock.mockResolvedValue(okJson({ ok: true, outcomes: {} }));
      let out: string | null = null;
      await act(async () => { out = api.apply('k', 'r1', 'c2', TEXT); });
      expect(out).toBe('Alpha beta GAMMA delta.');
    });

    it('clears everything, including a failed outcome, when the uid changes', async () => {
      await setup();
      fetchMock.mockResolvedValueOnce(errJson(503, 'save_failed', 'x'));
      await act(async () => { api.apply('k', 'r1', 'c1', TEXT); });
      expect(api.outcomeErrors.k).toBeDefined();
      await render(mkUser('u2'));
      expect(api.outcomeErrors).toEqual({});
      expect(api.byKey).toEqual({});
      fetchMock.mockClear();
      await act(async () => { await api.retryOutcome('k'); });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('dismissed comments can still be applied; the outcome posts applied', async () => {
      await setup();
      fetchMock.mockResolvedValue(okJson({ ok: true, outcomes: {} }));
      await act(async () => api.dismiss('k', 'r1', 'c1'));
      let out: string | null = null;
      await act(async () => { out = api.apply('k', 'r1', 'c1', TEXT); });
      expect(out).toBe('ALPHA!! beta gamma delta.');
      expect(api.byKey.k.review.outcomes.c1.status).toBe('applied');
      expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ commentId: 'c1', status: 'applied' });
      // applied is final
      expect(api.apply('k', 'r1', 'c1', out!)).toBeNull();
      await act(async () => api.dismiss('k', 'r1', 'c1'));
      expect(api.byKey.k.review.outcomes.c1.status).toBe('applied');
    });

    it('serialises dismissed then applied: applied stays local, posts after dismiss settles, no spurious error', async () => {
      await setup();
      const d = deferred<unknown>();
      fetchMock.mockReturnValueOnce(d.promise); // dismiss, in flight
      let dp!: Promise<void>;
      await act(async () => { dp = api.dismiss('k', 'r1', 'c1'); await Promise.resolve(); });
      fetchMock.mockResolvedValueOnce(okJson({ ok: true, outcomes: { c1: { status: 'applied', at: 't', byUpn: 'u' } } }));
      await act(async () => { api.apply('k', 'r1', 'c1', TEXT); await Promise.resolve(); });
      expect(fetchMock).toHaveBeenCalledTimes(1); // applied waits for the dismiss to settle
      await act(async () => { d.resolve(okJson({ ok: true, outcomes: { c1: { status: 'dismissed', at: 't', byUpn: 'u' } } })); await dp; });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).status).toBe('dismissed');
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).status).toBe('applied');
      expect(api.byKey.k.review.outcomes.c1.status).toBe('applied');
      expect(api.outcomeErrors.k).toBeUndefined();
    });

    it('a dismissed 409 after apply sets no error, and a failed applied POST stays retryable', async () => {
      await setup();
      const d = deferred<unknown>();
      fetchMock.mockReturnValueOnce(d.promise);
      let dp!: Promise<void>;
      await act(async () => { dp = api.dismiss('k', 'r1', 'c1'); await Promise.resolve(); });
      fetchMock.mockResolvedValueOnce(errJson(503, 'save_failed', 'x')); // applied fails
      await act(async () => { api.apply('k', 'r1', 'c1', TEXT); await Promise.resolve(); });
      await act(async () => { d.resolve(errJson(409, 'outcome_final', 'x')); await dp; });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(api.byKey.k.review.outcomes.c1.status).toBe('applied');
      expect(api.outcomeErrors.k).toBe("Couldn't save that — retry"); // from the applied failure only
      fetchMock.mockResolvedValueOnce(okJson({ ok: true, outcomes: {} }));
      await act(async () => { await api.retryOutcome('k'); });
      expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ commentId: 'c1', status: 'applied' });
      expect(api.outcomeErrors.k).toBeUndefined();
    });

    it('dismiss posts the outcome and keeps status on failure', async () => {
      await setup();
      fetchMock.mockResolvedValueOnce(okJson({ ok: true, outcomes: {} }));
      await act(async () => api.dismiss('k', 'r1', 'c2'));
      expect(api.byKey.k.review.outcomes.c2.status).toBe('dismissed');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ reviewId: 'r1', commentId: 'c2', status: 'dismissed' });
      fetchMock.mockResolvedValueOnce(errJson(500, 'x', 'Bad.'));
      await act(async () => api.dismiss('k', 'r1', 'c3'));
      expect(api.outcomeErrors.k).toBe("Couldn't save that — retry");
      expect(api.byKey.k.review.outcomes.c3.status).toBe('dismissed');
    });
  });

  it('reviewIdsForEntry covers all fields of the entry', async () => {
    await render(u1);
    fetchMock.mockResolvedValueOnce(okJson(mkReview('a', [], 'e1', 'overall')));
    fetchMock.mockResolvedValueOnce(okJson(mkReview('b', [], 'e1', 'vocab')));
    fetchMock.mockResolvedValueOnce(okJson(mkReview('c', [], 'e2', 'overall')));
    await act(async () => api.review('e1-overall', reqBase));
    await act(async () => api.review('e1-vocab', { ...reqBase, fieldKey: 'vocab' }));
    await act(async () => api.review('e2-overall', { ...reqBase, entryId: 'e2' }));
    expect(api.reviewIdsForEntry('e1').sort()).toEqual(['a', 'b']);
  });

  describe('Microsoft identity scope and auth epoch', () => {
    it('clears state when the Microsoft account changes under the same uid', async () => {
      await render(u1, 'a@x.com');
      fetchMock.mockResolvedValueOnce(okJson(mkReview('rA', [mkComment('c1', 'Alpha', 'ALPHA')])));
      await act(async () => api.review('k', reqBase));
      expect(api.byKey.k).toBeDefined();
      await render(u1, 'b@x.com');
      expect(api.byKey).toEqual({});
      expect(api.reviewIdsForEntry('e1')).toEqual([]);
      expect(api.apply('k', 'rA', 'c1', TEXT)).toBeNull();
      fetchMock.mockResolvedValueOnce(okJson(mkReview('rB', [])));
      await act(async () => api.review('k', reqBase));
      expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).supersedesReviewId).toBeUndefined();
    });

    it('skips the POST when the scope changes while the token is being fetched', async () => {
      // Resolve the token by hand, only after the scope switch, so the test
      // does not depend on timer ordering inside act().
      let resolveToken!: (token: string) => void;
      const slowUser = { uid: 'u1', getIdToken: vi.fn(() => new Promise<string>((r) => { resolveToken = r; })) } as never;
      await render(slowUser, 'a@x.com');
      let p!: Promise<void>;
      await act(async () => { p = api.review('k', reqBase); });
      await render(slowUser, 'b@x.com');
      await act(async () => { resolveToken('t'); await p; });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('renders empty state for the new scope in the very first render after the switch', async () => {
      await render(u1, 'a@x.com');
      fetchMock.mockResolvedValueOnce(okJson(mkReview('rA', [])));
      await act(async () => api.review('k', reqBase));
      renderLog.length = 0;
      await render(u1, 'b@x.com');
      expect(renderLog[0]).toBe(0);
    });

    it('treats UPN case and whitespace as the same account', async () => {
      await render(u1, 'a@x.com');
      fetchMock.mockResolvedValueOnce(okJson(mkReview('rA', [])));
      await act(async () => api.review('k', reqBase));
      await render(u1, ' A@X.com ');
      expect(api.byKey.k).toBeDefined();
    });

    it('ignores a stale response after A -> B -> A on the same key', async () => {
      await render(u1, 'a@x.com');
      const d1 = deferred<unknown>();
      fetchMock.mockReturnValueOnce(d1.promise);
      let p1!: Promise<void>;
      await act(async () => { p1 = api.review('k', reqBase); await Promise.resolve(); });
      await render(u1, 'b@x.com');
      await render(u1, 'a@x.com');
      fetchMock.mockResolvedValueOnce(okJson(mkReview('fresh', [])));
      await act(async () => api.review('k', reqBase));
      await act(async () => { d1.resolve(okJson(mkReview('stale', []))); await p1; });
      expect(api.byKey.k.review.reviewId).toBe('fresh');
    });

    it('ignores a stale response after sign-out and back', async () => {
      await render(u1);
      const d1 = deferred<unknown>();
      fetchMock.mockReturnValueOnce(d1.promise);
      let p1!: Promise<void>;
      await act(async () => { p1 = api.review('k', reqBase); await Promise.resolve(); });
      await render(null, null);
      await render(u1);
      fetchMock.mockResolvedValueOnce(okJson(mkReview('fresh', [])));
      await act(async () => api.review('k', reqBase));
      await act(async () => { d1.resolve(okJson(mkReview('stale', []))); await p1; });
      expect(api.byKey.k.review.reviewId).toBe('fresh');
    });

    it('drops an in-flight outcome result after the scope changes and A -> B -> A', async () => {
      await render(u1);
      fetchMock.mockResolvedValueOnce(okJson(mkReview('r1', [mkComment('c1', 'Alpha', 'ALPHA')])));
      await act(async () => api.review('k', reqBase));
      const d = deferred<unknown>();
      fetchMock.mockReturnValueOnce(d.promise);
      await act(async () => { api.apply('k', 'r1', 'c1', TEXT); await Promise.resolve(); });
      await render(u1, 'b@x.com');
      await render(u1);
      await act(async () => { d.resolve(errJson(500, 'x', 'y')); await Promise.resolve(); });
      expect(api.outcomeErrors).toEqual({});
    });
  });

  describe('sentReviewRefsForEntry', () => {
    it('prioritises current and applied reviews and reports the omitted count', async () => {
      await render(u1);
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).endsWith('/outcome')) return okJson({ ok: true, outcomes: {} });
        const n = (fetchMock.mock.calls.filter((c) => !String(c[0]).endsWith('/outcome')).length);
        return okJson(mkReview(`r${n}`, n === 5 || n === 21 ? [mkComment('c1', 'Alpha', 'ALPHA')] : [], 'e1', n === 1 ? 'vocab' : 'overall'));
      });
      await act(async () => api.review('e1-vocab', { ...reqBase, fieldKey: 'vocab' })); // r1, current for vocab
      for (let i = 2; i <= 21; i++) {
        await act(async () => api.review('e1-overall', reqBase)); // r2..r21
        if (i === 5) await act(async () => { api.apply('e1-overall', 'r5', 'c1', TEXT); });
      }
      const refs = api.sentReviewRefsForEntry('e1');
      expect(refs.ids).toHaveLength(20);
      expect(refs.omitted).toBe(1);
      expect(refs.ids.slice(0, 2)).toEqual(expect.arrayContaining(['r1', 'r21']));
      expect(refs.ids).toContain('r5');
      expect(refs.ids).not.toContain('r2');
      expect(new Set(refs.ids).size).toBe(20);
    });

    it('returns everything with omitted 0 when within the cap', async () => {
      await render(u1);
      fetchMock.mockResolvedValueOnce(okJson(mkReview('a', [], 'e1', 'overall')));
      await act(async () => api.review('e1-overall', reqBase));
      expect(api.sentReviewRefsForEntry('e1')).toEqual({ ids: ['a'], omitted: 0 });
    });
  });
});
