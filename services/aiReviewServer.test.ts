import { describe, expect, it, vi } from 'vitest';
import {
  createRateLimiter,
  handleReviewFeedback,
  handleReviewOutcome,
  type AiReviewDeps,
} from './aiReviewServer';
import { DEFAULT_FIELD_REVIEW_FOCUS } from './aiFeedbackReview';
import { DEFAULT_FEEDBACK_MODEL } from './geminiModels';
import type { CollaborationAccessProfile } from './collaborationAccess';

const access = (over: Partial<CollaborationAccessProfile> = {}): CollaborationAccessProfile => ({
  pilotEnabled: true,
  allowed: true,
  role: 'intern',
  upn: 'Intern@Uni.EDU',
  displayName: 'Ina Intern',
  classScope: { kind: 'classes', classIds: ['c1'] },
  capabilities: {
    canSendFeedback: true, canReviewAllFeedback: false, canExport: false, canSync: true,
    canManageSettings: false, canManageAccess: false, canUseAiReview: true,
  },
  source: 'configured_role',
  resolvedAt: '2026-11-18T00:00:00.000Z',
  ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  idToken: 'tok', classId: 'c1', pageId: 'p1', entryId: 'e1', fieldKey: 'diaryText',
  feedbackText: 'You wrote "I go" but past tense is better.',
  priorFeedbackIds: [], reviewFocus: 'Check accuracy.', reviewFocusSource: 'custom',
  tone: 'warm', itemCountSetting: '3-4',
  ...over,
});

const goodModelText = JSON.stringify({
  summary: 'Clear and kind.',
  comments: [{ quote: 'I go', category: 'accuracy', basis: 'student_text', note: 'Fine.', suggestion: 'I went' }],
});

function makeDeps(docs: Record<string, Record<string, unknown>> = {}, over: Partial<AiReviewDeps> = {}) {
  const store: Record<string, Record<string, unknown>> = {
    // Wire format, as written by serializeStoredEntry.
    'users/u1/entries/e1': {
      pageId: 'p1', classId: 'c1', diaryTextOriginal: 'I go to school yesterday.',
      peerFeedback: JSON.stringify([{ peerName: 'Ken', comment: 'Nice trip' }]),
      vocabItems: JSON.stringify([{ word: 'yesterday' }]),
      translations: JSON.stringify([]),
      chatbotFeedback: JSON.stringify({ present: true, data: 'Bot said: use past tense.' }),
      updatedAt: '2026-11-17T00:00:00.000Z',
    },
    'users/u1/pages/p1': { classId: 'c1', studentUpn: 'stu@uni.edu', studentName: 'Sam Student' },
    ...docs,
  };
  const deps = {
    geminiConfigured: true,
    verifyToken: vi.fn(async () => ({ uid: 'u1', claims: { ms_upn: 'intern@uni.edu', ms_name: 'Ina Intern', ms_role: 'intern' } })),
    readDoc: vi.fn(async (p: string[]) => store[p.join('/')] ?? null),
    writeDoc: vi.fn(async (p: string[], d: Record<string, unknown>) => { store[p.join('/')] = d; }),
    updateDoc: vi.fn(async (p: string[], d: Record<string, unknown>) => { store[p.join('/')] = { ...store[p.join('/')], ...d }; }),
    transact: vi.fn(async (p: string[], fn: any) => {
      const key = p.join('/');
      const { update, result } = fn(store[key] ?? null);
      if (update) {
        const next: Record<string, any> = { ...store[key] };
        for (const [k, v] of Object.entries(update)) {
          if (k.startsWith('outcomes.')) next.outcomes = { ...next.outcomes, [k.slice(9)]: v };
          else next[k] = v;
        }
        store[key] = next;
      }
      return result;
    }),
    generate: vi.fn(async () => goodModelText),
    allow: vi.fn(() => true),
    newId: () => 'rev1',
    now: () => '2026-11-18T01:00:00.000Z',
    ...over,
  } as AiReviewDeps & Record<string, any>;
  return { deps: deps as any, store };
}

const expectDenied = (deps: any, r: any, status: number, code: string) => {
  expect(r.status).toBe(status);
  expect(r.body.error).toBe(code);
  expect(deps.generate).not.toHaveBeenCalled();
  expect(deps.writeDoc).not.toHaveBeenCalled();
};

describe('createRateLimiter', () => {
  it('allows 30, blocks the 31st, recovers after the window', () => {
    let t = 0;
    const allow = createRateLimiter(30, 3600_000, () => t);
    for (let i = 0; i < 30; i++) expect(allow('u')).toBe(true);
    expect(allow('u')).toBe(false);
    expect(allow('other')).toBe(true);
    t = 3600_001;
    expect(allow('u')).toBe(true);
  });
});

describe('handleReviewFeedback denials (in order, no Gemini, no write)', () => {
  it('not_authenticated', async () => {
    const { deps } = makeDeps();
    expectDenied(deps, await handleReviewFeedback(null, body(), deps), 401, 'not_authenticated');
    expect(deps.verifyToken).not.toHaveBeenCalled();
  });
  it('not_enabled', async () => {
    const { deps } = makeDeps();
    const a = access({ capabilities: { ...access().capabilities, canUseAiReview: false } });
    expectDenied(deps, await handleReviewFeedback(a, body(), deps), 403, 'not_enabled');
  });
  it('not_configured precedes token verification', async () => {
    const { deps } = makeDeps({}, { geminiConfigured: false });
    expectDenied(deps, await handleReviewFeedback(access(), body(), deps), 503, 'not_configured');
    expect(deps.verifyToken).not.toHaveBeenCalled();
  });
  it('invalid_firebase_token', async () => {
    const { deps } = makeDeps({}, { verifyToken: vi.fn(async () => null) });
    expectDenied(deps, await handleReviewFeedback(access(), body(), deps), 401, 'invalid_firebase_token');
  });
  it('identity_not_bound on mismatched ms_upn in pilot mode', async () => {
    const { deps } = makeDeps({}, { verifyToken: vi.fn(async () => ({ uid: 'u1', claims: { ms_upn: 'someone@else.edu' } })) });
    expectDenied(deps, await handleReviewFeedback(access(), body(), deps), 403, 'identity_not_bound');
  });
  it('identity_not_bound when ms_upn claim is missing in pilot mode', async () => {
    const { deps } = makeDeps({}, { verifyToken: vi.fn(async () => ({ uid: 'u1', claims: {} })) });
    expectDenied(deps, await handleReviewFeedback(access(), body(), deps), 403, 'identity_not_bound');
  });
  it('non-pilot mode is exempt from the binding check', async () => {
    const { deps } = makeDeps({}, { verifyToken: vi.fn(async () => ({ uid: 'u1', claims: {} })) });
    const a = access({ pilotEnabled: false, role: 'owner', classScope: { kind: 'all' } });
    const r = await handleReviewFeedback(a, body(), deps);
    expect(r.status).toBe(200);
  });
  it('class_not_allowed', async () => {
    const { deps } = makeDeps();
    expectDenied(deps, await handleReviewFeedback(access(), body({ classId: 'c2' }), deps), 403, 'class_not_allowed');
  });
  it('entry_not_saved: entry missing', async () => {
    const { deps } = makeDeps();
    expectDenied(deps, await handleReviewFeedback(access(), body({ entryId: 'nope' }), deps), 409, 'entry_not_saved');
  });
  it('entry_not_saved: entry pageId mismatch', async () => {
    const { deps } = makeDeps({ 'users/u1/entries/e1': { pageId: 'other', classId: 'c1', diaryTextOriginal: 'x' } });
    expectDenied(deps, await handleReviewFeedback(access(), body(), deps), 409, 'entry_not_saved');
  });
  it('entry_not_saved: page classId mismatch', async () => {
    const { deps } = makeDeps({ 'users/u1/pages/p1': { classId: 'c9' } });
    expectDenied(deps, await handleReviewFeedback(access(), body(), deps), 409, 'entry_not_saved');
  });
  it('invalid_request', async () => {
    const { deps } = makeDeps();
    expectDenied(deps, await handleReviewFeedback(access(), body({ feedbackText: '  ' }), deps), 400, 'invalid_request');
  });
  it('rate_limited keyed by uid', async () => {
    const allow = vi.fn(() => false);
    const { deps } = makeDeps({}, { allow });
    expectDenied(deps, await handleReviewFeedback(access(), body(), deps), 429, 'rate_limited');
    expect(allow).toHaveBeenCalledWith('u1');
  });
  it('model_failed', async () => {
    const { deps } = makeDeps({}, { generate: vi.fn(async () => { throw new Error('boom'); }) });
    const r: any = await handleReviewFeedback(access(), body(), deps);
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('model_failed');
    expect(deps.writeDoc).not.toHaveBeenCalled();
  });
  it('bad_response on non-JSON and on unusable JSON', async () => {
    for (const text of ['not json', JSON.stringify({ comments: [] })]) {
      const { deps } = makeDeps({}, { generate: vi.fn(async () => text) });
      const r: any = await handleReviewFeedback(access(), body(), deps);
      expect(r.status).toBe(502);
      expect(r.body.error).toBe('bad_response');
      expect(deps.writeDoc).not.toHaveBeenCalled();
    }
  });
  it('save_failed', async () => {
    const { deps } = makeDeps({}, { writeDoc: vi.fn(async () => { throw new Error('nope'); }) });
    const r: any = await handleReviewFeedback(access(), body(), deps);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('save_failed');
  });
});

describe('handleReviewFeedback success', () => {
  it('uses entry content (ignores body studentContent), snapshots, author from claims', async () => {
    const { deps, store } = makeDeps();
    const r: any = await handleReviewFeedback(access(), body({ studentContent: 'INJECTED' }), deps);
    expect(r.status).toBe(200);
    const rec = r.body.review;
    expect(deps.generate.mock.calls[0][2]).toContain('I go to school yesterday.');
    expect(deps.generate.mock.calls[0][2]).not.toContain('INJECTED');
    expect(deps.generate.mock.calls[0][1]).toContain('Sam Student');
    expect(rec.schemaVersion).toBe(1);
    expect(rec.reviewId).toBe('rev1');
    expect(rec.outcomes).toEqual({});
    expect(rec.authorFirebaseUid).toBe('u1');
    expect(rec.authorUpn).toBe('intern@uni.edu');
    expect(rec.authorName).toBe('Ina Intern');
    expect(rec.authorRole).toBe('intern');
    expect(rec.studentUpn).toBe('stu@uni.edu');
    expect(rec.inputs.studentContentSnapshot).toBe('I go to school yesterday.');
    expect(rec.inputs.feedbackTextSnapshot).toBe(body().feedbackText);
    expect(rec.inputs.entryUpdatedAt).toBe('2026-11-17T00:00:00.000Z');
    expect(rec.inputs.promptVersion).toBe('review-v1');
    expect(rec.comments[0].suggestion).toBe('I went');
    expect(store['users/u1/aiFeedbackReviews/rev1']).toBeTruthy();
    expect(deps.generate.mock.calls[0][0]).toBe(DEFAULT_FEEDBACK_MODEL);
  });
  it('invalid or deprecated model falls back to the default; valid one is kept', async () => {
    for (const m of ['bogus', 'gemini-2.5-flash']) {
      const { deps } = makeDeps();
      await handleReviewFeedback(access(), body({ model: m }), deps);
      expect(deps.generate.mock.calls[0][0]).toBe(DEFAULT_FEEDBACK_MODEL);
    }
    const { deps } = makeDeps();
    const r: any = await handleReviewFeedback(access(), body({ model: 'gemini-3.5-flash' }), deps);
    expect(deps.generate.mock.calls[0][0]).toBe('gemini-3.5-flash');
    expect(r.body.review.inputs.model).toBe('gemini-3.5-flash');
  });
  it('blank reviewFocus uses the field default and records source default', async () => {
    const { deps } = makeDeps();
    const r: any = await handleReviewFeedback(access(), body({ reviewFocus: '  ', reviewFocusSource: 'custom' }), deps);
    expect(r.body.review.inputs.reviewFocus).toBe(DEFAULT_FIELD_REVIEW_FOCUS.diaryText);
    expect(r.body.review.inputs.reviewFocusSource).toBe('default');
  });
  it('filters prior feedback by class, student and page; snapshots dates and text', async () => {
    const fh = (o: Record<string, unknown>) => ({
      classId: 'c1', studentUpn: 'STU@uni.edu', pageId: 'p0', sentAt: '2026-11-10T00:00:00.000Z',
      structuredFeedback: { diaryFeedback: 'Prior diary note', includeDiary: true }, ...o,
    });
    const { deps } = makeDeps({
      'users/u1/feedbackHistory/ok': fh({}),
      'users/u1/feedbackHistory/badclass': fh({ classId: 'c2' }),
      'users/u1/feedbackHistory/badstu': fh({ studentUpn: 'other@uni.edu', structuredFeedback: { diaryFeedback: 'OTHER STUDENT', includeDiary: true } }),
    });
    const r: any = await handleReviewFeedback(
      access(), body({ priorFeedbackIds: ['ok', 'badclass', 'badstu'] }), deps);
    expect(r.body.review.inputs.priorFeedback).toEqual([
      { feedbackId: 'ok', sentAt: '2026-11-10T00:00:00.000Z', text: 'Diary: Prior diary note' },
    ]);
    expect(deps.generate.mock.calls[0][2]).toContain('Prior diary note');
    expect(deps.generate.mock.calls[0][2]).not.toContain('OTHER STUDENT');
  });
  it('when the page has no studentUpn, prior records must match pageId', async () => {
    const { deps } = makeDeps({
      'users/u1/pages/p1': { classId: 'c1', studentName: 'Sam' },
      'users/u1/feedbackHistory/same': { classId: 'c1', pageId: 'p1', studentUpn: 'a@b', sentAt: '2026-11-01T00:00:00.000Z', content: 'same page' },
      'users/u1/feedbackHistory/diff': { classId: 'c1', pageId: 'p9', studentUpn: 'a@b', sentAt: '2026-11-01T00:00:00.000Z', content: 'diff page' },
    });
    const r: any = await handleReviewFeedback(access(), body({ priorFeedbackIds: ['same', 'diff'] }), deps);
    expect(r.body.review.inputs.priorFeedback.map((p: any) => p.feedbackId)).toEqual(['same']);
  });
  it('supersedesReviewId must match class, page, entry, field and author', async () => {
    const old = { reviewId: 'old', classId: 'c1', pageId: 'p1', entryId: 'e1', fieldKey: 'diaryText', authorUpn: 'intern@uni.edu' };
    const { deps } = makeDeps({ 'users/u1/aiFeedbackReviews/old': old });
    const a: any = await handleReviewFeedback(access(), body({ supersedesReviewId: 'old' }), deps);
    expect(a.status).toBe(200);
    expect(a.body.review.supersedesReviewId).toBe('old');
  });
  it.each([
    ['another entry and field', { entryId: 'e2', fieldKey: 'translations' }],
    ['another author', { authorUpn: 'someone@else.edu' }],
    ['another class', { classId: 'c2' }],
    ['a missing review', null],
  ])('supersedesReviewId for %s is 400 and never calls Gemini', async (_n, over) => {
    const old = { reviewId: 'old', classId: 'c1', pageId: 'p1', entryId: 'e1', fieldKey: 'diaryText', authorUpn: 'intern@uni.edu' };
    const { deps } = makeDeps(over ? { 'users/u1/aiFeedbackReviews/old': { ...old, ...over } } : {});
    const r: any = await handleReviewFeedback(access(), body({ supersedesReviewId: 'old' }), deps);
    expectDenied(deps, r, 400, 'invalid_request');
    expect(r.body.message).toBe('supersedesReviewId does not match this entry and field.');
  });
  it('author role comes from the access profile, not a stale claim', async () => {
    const { deps } = makeDeps({}, { verifyToken: vi.fn(async () => ({ uid: 'u1', claims: { ms_upn: 'intern@uni.edu', ms_name: 'Ina Intern', ms_role: 'owner' } })) });
    const r: any = await handleReviewFeedback(access(), body(), deps);
    expect(r.body.review.authorRole).toBe('intern');
  });
  it('reads wire-format entries: diary, chatbot, overall and peer content reach the prompt', async () => {
    for (const [fieldKey, needle] of [
      ['diaryText', 'I go to school yesterday.'],
      ['chatbot', 'Bot said: use past tense.'],
      ['overall', 'I go to school yesterday.'],
      ['peerFeedback', 'Nice trip'],
    ] as const) {
      const { deps } = makeDeps();
      const r: any = await handleReviewFeedback(access(), body({ fieldKey }), deps);
      expect(r.status).toBe(200);
      expect(deps.generate.mock.calls[0][2]).toContain(needle);
      expect(r.body.review.inputs.studentContentSnapshot).toContain(needle);
    }
  });
  it('entry with another classId is entry_not_saved', async () => {
    const { deps } = makeDeps({ 'users/u1/entries/e1': { pageId: 'p1', classId: 'c2', diaryTextOriginal: 'x' } });
    expectDenied(deps, await handleReviewFeedback(access(), body(), deps), 409, 'entry_not_saved');
  });
  it('truncates oversized fetched inputs, flags it, and keeps the record small', async () => {
    const big = 'x'.repeat(500_000);
    const { deps } = makeDeps({
      'users/u1/entries/e1': { pageId: 'p1', classId: 'c1', diaryTextOriginal: big },
      'users/u1/feedbackHistory/f1': { classId: 'c1', studentUpn: 'stu@uni.edu', sentAt: '2026-11-01T00:00:00.000Z',
        structuredFeedback: { diaryFeedback: 'y'.repeat(50_000), includeDiary: true } },
    });
    const r: any = await handleReviewFeedback(access(), body({ priorFeedbackIds: ['f1'] }), deps);
    expect(r.status).toBe(200);
    const rec = r.body.review;
    expect(rec.inputs.studentContentSnapshot.length).toBeLessThanOrEqual(12000);
    expect(rec.inputs.priorFeedback[0].text.length).toBeLessThanOrEqual(2000);
    expect(rec.inputs.truncated).toEqual({ studentContent: true, priorFeedbackIds: ['f1'] });
    expect(JSON.stringify(rec).length).toBeLessThan(200_000);
    const total = deps.generate.mock.calls[0][2].length + deps.generate.mock.calls[0][1].length;
    expect(total).toBeLessThan(40_000);
  });
  it('untruncated inputs are flagged false', async () => {
    const { deps } = makeDeps();
    const r: any = await handleReviewFeedback(access(), body(), deps);
    expect(r.body.review.inputs.truncated).toEqual({ studentContent: false, priorFeedbackIds: [] });
  });
});

describe('handleReviewOutcome', () => {
  const review = () => ({
    'users/u1/aiFeedbackReviews/rev1': {
      reviewId: 'rev1', authorUpn: 'intern@uni.edu', comments: [{ id: 'c1' }, { id: 'c2' }], outcomes: {},
    },
  });
  const ob = (over: Record<string, unknown> = {}) => ({ idToken: 'tok', reviewId: 'rev1', commentId: 'c1', status: 'applied', ...over });

  it('denies unauthenticated, bad token, unbound without touching the review', async () => {
    const { deps } = makeDeps(review());
    expect((await handleReviewOutcome(null, ob(), deps)).status).toBe(401);
    const d2 = makeDeps(review(), { verifyToken: vi.fn(async () => null) }).deps;
    expect(((await handleReviewOutcome(access(), ob(), d2)) as any).body.error).toBe('invalid_firebase_token');
    const d3 = makeDeps(review(), { verifyToken: vi.fn(async () => ({ uid: 'u1', claims: { ms_upn: 'x@y' } })) }).deps;
    expect(((await handleReviewOutcome(access(), ob(), d3)) as any).body.error).toBe('identity_not_bound');
    for (const d of [deps, d2, d3]) expect(d.updateDoc).not.toHaveBeenCalled();
  });
  it('records applied; unknown commentId and status are 400', async () => {
    const { deps, store } = makeDeps(review());
    const ok: any = await handleReviewOutcome(access(), ob(), deps);
    expect(ok.status).toBe(200);
    expect(ok.body.outcomes.c1).toEqual({ status: 'applied', at: '2026-11-18T01:00:00.000Z', byUpn: 'intern@uni.edu' });
    expect((store['users/u1/aiFeedbackReviews/rev1'] as any).outcomes.c1.status).toBe('applied');
    expect((await handleReviewOutcome(access(), ob({ commentId: 'zz' }), deps)).status).toBe(400);
    expect((await handleReviewOutcome(access(), ob({ status: 'maybe' }), deps)).status).toBe(400);
  });
  it('another user\'s review is 404', async () => {
    const { deps } = makeDeps(review(), { verifyToken: vi.fn(async () => ({ uid: 'u2', claims: { ms_upn: 'intern@uni.edu' } })) });
    expect((await handleReviewOutcome(access(), ob(), deps)).status).toBe(404);
    expect(deps.updateDoc).not.toHaveBeenCalled();
  });
  it('applied -> dismissed is 409; dismissed -> applied is OK', async () => {
    const a = makeDeps(review()).deps;
    await handleReviewOutcome(access(), ob({ status: 'applied' }), a);
    const r = await handleReviewOutcome(access(), ob({ status: 'dismissed' }), a);
    expect(r.status).toBe(409);
    const b = makeDeps(review()).deps;
    await handleReviewOutcome(access(), ob({ status: 'dismissed' }), b);
    const r2 = await handleReviewOutcome(access(), ob({ status: 'applied' }), b);
    expect(r2.status).toBe(200);
  });
  it('evaluates transitions against the doc read inside the transaction', async () => {
    const { deps, store } = makeDeps(review());
    const real = deps.transact;
    // A concurrent request applies c1 between the handler's start and the transaction.
    deps.transact = vi.fn(async (p: string[], fn: any) => {
      (store['users/u1/aiFeedbackReviews/rev1'] as any).outcomes = { c1: { status: 'applied', at: 'x' } };
      return real(p, fn);
    });
    const r: any = await handleReviewOutcome(access(), ob({ status: 'dismissed' }), deps);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('outcome_final');
    expect((store['users/u1/aiFeedbackReviews/rev1'] as any).outcomes.c1.status).toBe('applied');
  });
  it('writes only the one outcome key plus updatedAt, preserving others', async () => {
    const { deps, store } = makeDeps({
      'users/u1/aiFeedbackReviews/rev1': { reviewId: 'rev1', authorUpn: 'intern@uni.edu', comments: [{ id: 'c1' }, { id: 'c2' }], outcomes: { c2: { status: 'applied', at: 'earlier' } } },
    });
    await handleReviewOutcome(access(), ob({ status: 'dismissed' }), deps);
    const update = deps.transact.mock.results.length ? (await deps.transact.mock.calls[0][1]({ authorUpn: 'intern@uni.edu', comments: [{ id: 'c1' }], outcomes: {} })).update : null;
    expect(Object.keys(update).sort()).toEqual(['outcomes.c1', 'updatedAt']);
    expect((store['users/u1/aiFeedbackReviews/rev1'] as any).outcomes.c2.at).toBe('earlier');
  });
  it('records the actor with each outcome', async () => {
    const { deps } = makeDeps(review());
    const r: any = await handleReviewOutcome(access(), ob(), deps);
    expect(r.body.outcomes.c1.byUpn).toBe('intern@uni.edu');
  });
  it('pilot: a rebound Google account with a different ms_upn is not_review_author and writes nothing', async () => {
    const { deps, store } = makeDeps(review(), { verifyToken: vi.fn(async () => ({ uid: 'u1', claims: { ms_upn: 'other@uni.edu' } })) });
    const a = access({ upn: 'other@uni.edu' });
    const r: any = await handleReviewOutcome(a, ob(), deps);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('not_review_author');
    expect((store['users/u1/aiFeedbackReviews/rev1'] as any).outcomes).toEqual({});
  });
  it('non-pilot is exempt from the author check and records the session UPN', async () => {
    const { deps } = makeDeps(review(), { verifyToken: vi.fn(async () => ({ uid: 'u1', claims: {} })) });
    const a = access({ pilotEnabled: false, upn: 'Owner@Uni.edu', role: 'owner' });
    const r: any = await handleReviewOutcome(a, ob(), deps);
    expect(r.status).toBe(200);
    expect(r.body.outcomes.c1.byUpn).toBe('owner@uni.edu');
  });
});
