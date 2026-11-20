/**
 * AI feedback review: server-side handlers (pure; all I/O injected).
 *
 * Every access check runs before any Gemini call or write, in the order set by
 * the design spec (docs/superpowers/specs/2026-11-18-ai-feedback-review-design.md §S2).
 * server.ts is a thin adapter that builds AiReviewDeps and sends the result.
 * Runs in the Docker runtime image: imports from ../types must be `import type`.
 */
import type { FeedbackHistoryRecord } from '../types';
import {
  AI_REVIEW_PROMPT_VERSION,
  AI_REVIEW_RESPONSE_SCHEMA,
  DEFAULT_FIELD_REVIEW_FOCUS,
  ITEM_COUNT_HINTS,
  buildReviewSystemInstruction,
  buildReviewUserPrompt,
  priorFeedbackText,
  sanitizeReview,
  studentContentForField,
  validateReviewClientRequest,
  type AiReviewClientRequest,
  type AiReviewComment,
  type AiReviewFieldKey,
  type PriorFeedbackInput,
} from './aiFeedbackReview';
import { DEFAULT_FEEDBACK_MODEL, findGeminiModel } from './geminiModels';
import { isClassAllowed, type CollaborationAccessProfile } from './collaborationAccess';
import { normalizeUpn } from './identityClaims';
import { decodeStoredEntryForReview } from './storedEntryWire';

export const AI_REVIEW_LOG_PURPOSE = 'gemini:feedback-review';
// Input budget for fetched (server-side) inputs; the instructor's own draft and
// review focus are capped by request validation and are never truncated here.
export const MAX_STUDENT_CONTENT_CHARS = 12000;
export const MAX_PRIOR_TEXT_CHARS = 2000;
export const MAX_TOTAL_INPUT_CHARS = 30000;
export const AI_REVIEW_RATE_LIMIT = 30;
export const AI_REVIEW_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Rolling-window limiter. Per instance and in memory: a development safeguard,
 * not a deployment-wide spending ceiling.
 */
export function createRateLimiter(
  limit: number,
  windowMs: number,
  now: () => number = Date.now
): (key: string) => boolean {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((h) => t - h < windowMs);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    return true;
  };
}

export interface AiReviewDeps {
  geminiConfigured: boolean;
  verifyToken: (idToken: unknown) => Promise<{ uid: string; claims: Record<string, unknown> } | null>;
  readDoc: (path: string[]) => Promise<Record<string, unknown> | null>;
  writeDoc: (path: string[], data: Record<string, unknown>) => Promise<void>;
  updateDoc: (path: string[], data: Record<string, unknown>) => Promise<void>;
  /**
   * Atomic read-modify-write of one document. `fn` runs against the freshly
   * read document (may re-run on contention) and must be side-effect free; its
   * `update` (field-path keys allowed) is applied in the same transaction.
   */
  transact: <T>(
    path: string[],
    fn: (current: Record<string, unknown> | null) => { update?: Record<string, unknown>; result: T }
  ) => Promise<T>;
  generate: (model: string, system: string, user: string) => Promise<string>;
  allow: (key: string) => boolean;
  newId: () => string;
  now: () => string;
  /** One line per review. Never receives student or feedback text. */
  log?: (line: string) => void;
}

export interface AiFeedbackReviewRecord {
  schemaVersion: 1;
  reviewId: string;
  createdAt: string;
  authorFirebaseUid: string;
  authorUpn: string;
  authorName: string;
  authorRole: string;
  classId: string;
  pageId: string;
  entryId: string;
  fieldKey: AiReviewFieldKey;
  studentUpn?: string;
  inputs: {
    feedbackTextSnapshot: string;
    studentContentSnapshot: string;
    entryUpdatedAt?: string;
    reviewFocus: string;
    reviewFocusSource: 'default' | 'custom';
    tone: string;
    itemCountSetting: string;
    priorFeedback: PriorFeedbackInput[];
    model: string;
    promptVersion: string;
    truncated: { studentContent: boolean; priorFeedbackIds: string[] };
  };
  supersedesReviewId?: string;
  summary: string;
  comments: AiReviewComment[];
  outcomes: Record<string, { status: 'applied' | 'dismissed'; at: string; byUpn: string }>;
  updatedAt: string;
}

type ErrBody = { error: string; message: string };
type Failure = { status: number; body: ErrBody };
const fail = (status: number, error: string, message: string): Failure => ({ status, body: { error, message } });

// Firestore document ids cannot contain '/'; reject rather than build a bad path.
const safeId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1500 && !v.includes('/');
const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const asIso = (v: unknown): string | undefined => {
  if (typeof v === 'string' && v) return v;
  const td = (v as { toDate?: () => Date } | null)?.toDate;
  if (typeof td === 'function') {
    try { return td.call(v).toISOString(); } catch { return undefined; }
  }
  return undefined;
};

/** Checks 1, 4 and 5, shared by the review and outcome routes. */
async function authenticate(
  access: CollaborationAccessProfile | null,
  idToken: unknown,
  deps: AiReviewDeps
): Promise<{ uid: string; claims: Record<string, unknown> } | Failure> {
  if (!access) return fail(401, 'not_authenticated', 'Sign in with Microsoft to use this.');
  return authenticateToken(access, idToken, deps);
}

async function authenticateToken(
  access: CollaborationAccessProfile,
  idToken: unknown,
  deps: AiReviewDeps
): Promise<{ uid: string; claims: Record<string, unknown> } | Failure> {
  const verified = await deps.verifyToken(idToken);
  if (!verified) return fail(401, 'invalid_firebase_token', 'Your Google sign-in is missing or expired. Sign in again.');
  if (access.pilotEnabled) {
    const upn = verified.claims.ms_upn;
    if (typeof upn !== 'string' || normalizeUpn(upn) !== normalizeUpn(access.upn)) {
      return fail(403, 'identity_not_bound', 'Your Google sign-in is not linked to your Microsoft account yet.');
    }
  }
  return verified;
}

const isFailure = (v: unknown): v is Failure => Boolean(v) && typeof (v as Failure).status === 'number';

export async function handleReviewFeedback(
  access: CollaborationAccessProfile | null,
  body: unknown,
  deps: AiReviewDeps
): Promise<{ status: number; body: { review: AiFeedbackReviewRecord } | ErrBody }> {
  const ctx: { model?: string } = {};
  const result = await runReview(access, body, deps, ctx);
  const code = 'error' in result.body ? result.body.error : 'none';
  deps.log?.(`[${AI_REVIEW_LOG_PURPOSE}] status=${result.status} model=${ctx.model ?? 'none'} error=${code}`);
  return result;
}

async function runReview(
  access: CollaborationAccessProfile | null,
  body: unknown,
  deps: AiReviewDeps,
  ctx: { model?: string }
): Promise<{ status: number; body: { review: AiFeedbackReviewRecord } | ErrBody }> {
  // 1. session
  if (!access) return fail(401, 'not_authenticated', 'Sign in with Microsoft to use this.');
  // 2. capability
  if (!access.allowed || !access.capabilities?.canUseAiReview) {
    return fail(403, 'not_enabled', 'AI review is not enabled for your role. Ask the course owner.');
  }
  // 3. server key
  if (!deps.geminiConfigured) return fail(503, 'not_configured', 'AI review is not configured on the server.');

  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  // 4-5. token and identity binding
  const auth = await authenticateToken(access, raw.idToken, deps);
  if (isFailure(auth)) return auth;
  const { uid, claims } = auth;

  // 6. class
  const { classId, pageId, entryId } = raw;
  if (typeof classId !== 'string' || !classId) return fail(400, 'invalid_request', 'Missing classId.');
  if (!isClassAllowed(access, classId)) return fail(403, 'class_not_allowed', 'You do not have access to this class.');

  // 7. entry association (two point reads)
  const notSaved = fail(409, 'entry_not_saved', 'Save this entry before reviewing it.');
  if (!safeId(entryId) || !safeId(pageId)) return notSaved;
  const entryRaw = await deps.readDoc(['users', uid, 'entries', entryId]);
  if (!entryRaw) return notSaved;
  // Saved entries are stored in wire format (JSON-text fields); decode before use.
  const entry = decodeStoredEntryForReview(entryRaw);
  if (entry.pageId !== pageId || entry.classId !== classId) return notSaved;
  const page = await deps.readDoc(['users', uid, 'pages', pageId]);
  if (!page || page.classId !== classId) return notSaved;

  // 8. request shape
  const parsed = validateReviewClientRequest(body);
  if (!parsed.ok) return fail(400, 'invalid_request', (parsed as { error: string }).error);
  const req = (parsed as { value: AiReviewClientRequest }).value;

  // Lineage: a re-review must be of the same entry and field, by the same author.
  const boundUpn = normalizeUpn(typeof claims.ms_upn === 'string' && claims.ms_upn ? claims.ms_upn : access.upn);
  let supersedesReviewId: string | undefined;
  if (req.supersedesReviewId) {
    const old = safeId(req.supersedesReviewId)
      ? await deps.readDoc(['users', uid, 'aiFeedbackReviews', req.supersedesReviewId])
      : null;
    const matches = old &&
      old.classId === classId && old.pageId === pageId && old.entryId === entryId && old.fieldKey === req.fieldKey &&
      (!access.pilotEnabled || (typeof old.authorUpn === 'string' && normalizeUpn(old.authorUpn) === boundUpn));
    if (!matches) return fail(400, 'invalid_request', 'supersedesReviewId does not match this entry and field.');
    supersedesReviewId = req.supersedesReviewId;
  }

  // 9. rate limit
  if (!deps.allow(uid)) return fail(429, 'rate_limited', 'Too many reviews. Try again later.');

  // Settings
  const requested = findGeminiModel(req.model);
  const model = requested && !requested.deprecated ? requested.id : DEFAULT_FEEDBACK_MODEL;
  ctx.model = model;
  const customFocus = req.reviewFocus.trim();
  const reviewFocus = customFocus || DEFAULT_FIELD_REVIEW_FOCUS[req.fieldKey];
  const reviewFocusSource: 'default' | 'custom' = customFocus ? req.reviewFocusSource : 'default';

  // Prior feedback: point reads, then scope checks.
  const pageUpn = asStr(page.studentUpn);
  const priorFeedback: PriorFeedbackInput[] = [];
  const truncatedPriorIds: string[] = [];
  for (const id of req.priorFeedbackIds) {
    if (!safeId(id)) continue;
    const rec = await deps.readDoc(['users', uid, 'feedbackHistory', id]);
    if (!rec || rec.classId !== classId) continue;
    const sameStudent = pageUpn
      ? typeof rec.studentUpn === 'string' && normalizeUpn(rec.studentUpn) === normalizeUpn(pageUpn)
      : rec.pageId === pageId;
    if (!sameStudent) continue;
    const sentAt = asIso(rec.sentAt);
    const text = priorFeedbackText(rec as unknown as FeedbackHistoryRecord);
    if (!sentAt || !text) continue;
    if (text.length > MAX_PRIOR_TEXT_CHARS) {
      priorFeedback.push({ feedbackId: id, sentAt, text: text.slice(0, MAX_PRIOR_TEXT_CHARS) });
      truncatedPriorIds.push(id);
    } else {
      priorFeedback.push({ feedbackId: id, sentAt, text });
    }
  }

  let studentContent = studentContentForField(entry, req.fieldKey);
  let studentTruncated = false;
  if (studentContent.length > MAX_STUDENT_CONTENT_CHARS) {
    studentContent = studentContent.slice(0, MAX_STUDENT_CONTENT_CHARS);
    studentTruncated = true;
  }
  // Combined budget. With the per-field caps this cannot trip today, but it
  // keeps the total bounded if a cap is raised. Fetched inputs shrink, the
  // instructor's draft and focus never do.
  let overBy = req.feedbackText.length + reviewFocus.length + studentContent.length +
    priorFeedback.reduce((n, p) => n + p.text.length, 0) - MAX_TOTAL_INPUT_CHARS;
  for (let i = priorFeedback.length - 1; i >= 0 && overBy > 0; i--) {
    const cut = Math.min(overBy, priorFeedback[i].text.length);
    priorFeedback[i] = { ...priorFeedback[i], text: priorFeedback[i].text.slice(0, priorFeedback[i].text.length - cut) };
    if (!truncatedPriorIds.includes(priorFeedback[i].feedbackId)) truncatedPriorIds.push(priorFeedback[i].feedbackId);
    overBy -= cut;
  }
  if (overBy > 0) {
    studentContent = studentContent.slice(0, Math.max(0, studentContent.length - overBy));
    studentTruncated = true;
  }
  const promptInput = {
    fieldKey: req.fieldKey,
    studentName: asStr(page.studentName) ?? 'the student',
    studentContent,
    feedbackText: req.feedbackText,
    priorFeedback,
    reviewFocus,
    tone: req.tone,
    itemCountHint: ITEM_COUNT_HINTS[req.itemCountSetting],
  };

  let text: string;
  try {
    text = await deps.generate(model, buildReviewSystemInstruction(promptInput), buildReviewUserPrompt(promptInput));
  } catch {
    return fail(502, 'model_failed', 'The AI reviewer could not be reached. Try again.');
  }
  let review: ReturnType<typeof sanitizeReview> = null;
  try { review = sanitizeReview(JSON.parse(text), req.feedbackText); } catch { review = null; }
  if (!review) return fail(502, 'bad_response', 'The AI reviewer returned an unusable response. Try again.');

  const now = deps.now();
  const claimStr = (k: string) => (typeof claims[k] === 'string' && claims[k] ? (claims[k] as string) : undefined);
  const record: AiFeedbackReviewRecord = {
    schemaVersion: 1,
    reviewId: deps.newId(),
    createdAt: now,
    authorFirebaseUid: uid,
    authorUpn: claimStr('ms_upn') ?? normalizeUpn(access.upn),
    authorName: claimStr('ms_name') ?? access.displayName,
    // Role comes from the live access profile; a claim can lag a role change.
    authorRole: access.role ?? 'owner',
    classId,
    pageId,
    entryId,
    fieldKey: req.fieldKey,
    ...(pageUpn ? { studentUpn: pageUpn } : {}),
    inputs: {
      feedbackTextSnapshot: req.feedbackText,
      studentContentSnapshot: studentContent,
      ...(asIso(entry.updatedAt) ? { entryUpdatedAt: asIso(entry.updatedAt) } : {}),
      reviewFocus,
      reviewFocusSource,
      tone: req.tone,
      itemCountSetting: req.itemCountSetting,
      priorFeedback,
      model,
      promptVersion: AI_REVIEW_PROMPT_VERSION,
      truncated: { studentContent: studentTruncated, priorFeedbackIds: truncatedPriorIds },
    },
    ...(supersedesReviewId ? { supersedesReviewId } : {}),
    summary: review.summary,
    comments: review.comments,
    outcomes: {},
    updatedAt: now,
  };
  try {
    await deps.writeDoc(['users', uid, 'aiFeedbackReviews', record.reviewId], record as unknown as Record<string, unknown>);
  } catch {
    return fail(503, 'save_failed', 'The review could not be saved. Try again.');
  }
  return { status: 200, body: { review: record } };
}

type Outcomes = AiFeedbackReviewRecord['outcomes'];

export async function handleReviewOutcome(
  access: CollaborationAccessProfile | null,
  body: unknown,
  deps: AiReviewDeps
): Promise<{ status: number; body: { ok: true; outcomes: Outcomes } | ErrBody }> {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const auth = await authenticate(access, raw.idToken, deps);
  if (isFailure(auth)) return auth;

  const { reviewId, commentId, status } = raw;
  const actorUpn = normalizeUpn(
    typeof auth.claims.ms_upn === 'string' && auth.claims.ms_upn ? auth.claims.ms_upn : access!.upn
  );
  if (!safeId(reviewId)) return fail(400, 'invalid_request', 'Missing reviewId.');
  if (typeof commentId !== 'string' || !commentId) return fail(400, 'invalid_request', 'Missing commentId.');
  if (status !== 'applied' && status !== 'dismissed') return fail(400, 'invalid_request', 'Unknown status.');

  // Path is built from the verified uid, so another user's review is simply not found.
  const path = ['users', auth.uid, 'aiFeedbackReviews', reviewId];
  const at = deps.now();
  type R = { status: number; body: { ok: true; outcomes: Outcomes } | ErrBody };
  try {
    // Every check runs against the document read inside the transaction, and
    // only outcomes.<commentId> and updatedAt are written, so concurrent posts
    // cannot lose each other's outcomes or reverse an applied one.
    return await deps.transact<R>(path, (review) => {
      if (!review) return { result: fail(404, 'review_not_found', 'Review not found.') };
      // Pilot: only the review's author (by bound Microsoft identity) may record outcomes,
      // even if another Google account was rebound onto this Firebase uid.
      if (access!.pilotEnabled && !(typeof review.authorUpn === 'string' && normalizeUpn(review.authorUpn) === actorUpn)) {
        return { result: fail(403, 'not_review_author', 'Only the reviewer can record outcomes for this review.') };
      }
      const comments = Array.isArray(review.comments) ? (review.comments as Array<{ id?: unknown }>) : [];
      if (!comments.some((c) => c && c.id === commentId)) {
        return { result: fail(400, 'invalid_request', 'Unknown commentId.') };
      }
      const outcomes: Outcomes = { ...((review.outcomes as Outcomes | undefined) ?? {}) };
      const current = outcomes[commentId]?.status;
      // Applied is final; dismissed may become applied but never the reverse.
      if (current === 'applied' && status === 'dismissed') {
        return { result: fail(409, 'outcome_final', 'That comment was already applied.') };
      }
      if (current === status) return { result: { status: 200, body: { ok: true, outcomes } } };
      outcomes[commentId] = { status, at, byUpn: actorUpn };
      return {
        update: { [`outcomes.${commentId}`]: outcomes[commentId], updatedAt: at },
        result: { status: 200, body: { ok: true, outcomes } },
      };
    });
  } catch {
    return fail(503, 'save_failed', 'The outcome could not be saved. Try again.');
  }
}

export const AI_REVIEW_GEMINI_CONFIG = {
  responseMimeType: 'application/json',
  responseSchema: AI_REVIEW_RESPONSE_SCHEMA,
  temperature: 0.3,
} as const;
