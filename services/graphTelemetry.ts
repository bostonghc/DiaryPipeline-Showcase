import { createHmac } from 'crypto';

// Graph proxy telemetry (pilot readiness).
//
// Answers one question the app cannot currently answer: what does a sync run
// cost in Microsoft Graph requests, and which endpoint family spends it?
// OneNote's documented delegated limits are per app, per user — 5 concurrent,
// 120/minute, 400/hour — and the hourly figure is potentially the binding
// constraint for the hosted pilot. Designing around it without measuring first
// would be guesswork, so this instruments before anything is scheduled.
//
// Privacy: no UPNs, display names, page titles, or class ids reach the logs.
// The path is reduced to an endpoint family with every identifier stripped, and
// the account id is replaced by a keyed digest.

export type GraphEndpointFamily =
  | 'notebooks'
  | 'section_groups'
  | 'sections'
  | 'section_pages'
  | 'page_content'
  | 'identity'
  | 'roster'
  | 'mail'
  | 'chat'
  | 'other';

/**
 * Reduce a proxied Graph path to a low-cardinality family label.
 *
 * Ordering matters: the more specific OneNote shapes are tested before the
 * generic ones, because `/sections/{id}/pages` also matches `sections`.
 */
export const classifyGraphEndpointFamily = (rawPath: string): GraphEndpointFamily => {
  const path = rawPath.split('?')[0].replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();

  if (/\/pages\/[^/]+\/content$/.test(path)) return 'page_content';
  if (/\/sections\/[^/]+\/pages$/.test(path)) return 'section_pages';
  if (/\/pages$/.test(path)) return 'section_pages';
  if (/\/sectiongroups(\/[^/]+)?$/.test(path)) return 'section_groups';
  if (/\/sections(\/[^/]+)?$/.test(path)) return 'sections';
  if (/\/notebooks(\/[^/]+)?$/.test(path)) return 'notebooks';
  if (/^me\/sendmail$/.test(path)) return 'mail';
  if (/^chats(\/.*)?$/.test(path)) return 'chat';
  if (/members$/.test(path) || /^education\/classes$/.test(path)) return 'roster';
  if (/^me(\/memberof|\/joinedteams)?$/.test(path) || /^users(\/.*)?$/.test(path)) return 'identity';
  return 'other';
};

/**
 * Families that spend the documented OneNote per-user budget (5 concurrent,
 * 120/minute, 400/hour). Identity, roster, mail and chat are Graph traffic but
 * are not OneNote requests, so they must not be counted against that figure.
 * Exported so the canary analysis and this code cannot drift apart.
 */
export const ONENOTE_BUDGET_FAMILIES: readonly GraphEndpointFamily[] = [
  'notebooks',
  'section_groups',
  'sections',
  'section_pages',
  'page_content',
];

export const isOneNoteBudgetFamily = (family: GraphEndpointFamily): boolean =>
  ONENOTE_BUDGET_FAMILIES.includes(family);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The sync-run correlation id is client-supplied, so it is validated before it
 * reaches a log field. An unvalidated value would let a client inject arbitrary
 * text and create unbounded log cardinality.
 */
export const isValidSyncRunId = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value);

export const readSyncRunId = (headerValue: unknown): string | undefined => {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return isValidSyncRunId(value) ? value : undefined;
};

/**
 * Stable per-user telemetry key.
 *
 * HMAC rather than a plain digest: a bare hash of an account id can be
 * confirmed by anyone who already holds that id, which would make the log
 * entries re-identifiable. Keying with the deployment secret means the digest
 * is only linkable inside this deployment, and truncation keeps it short
 * without making collisions likely at pilot scale.
 */
export const deriveTelemetryUserKey = (
  accountId: string | undefined,
  secret: string | undefined
): string | undefined => {
  if (!accountId) return undefined;
  if (!secret) return undefined;
  return createHmac('sha256', `graph-telemetry:${secret}`)
    .update(accountId)
    .digest('hex')
    .slice(0, 12);
};

/**
 * Where a request ended.
 * - `upstream`: reached Microsoft Graph.
 * - `rejected`: refused by the proxy (allowlist, auth, class scope) before any
 *   upstream call. These cost no Graph budget but a storm of them is a signal.
 * - `server`: a Graph call the BFF makes directly, outside /api/graph/*, e.g.
 *   the membership lookup behind an access check. It spends the same per-user
 *   budget and would otherwise be invisible.
 */
export type GraphRequestOutcome = 'upstream' | 'rejected' | 'server';

export interface GraphRequestTelemetry {
  family: GraphEndpointFamily;
  method: string;
  status: number;
  outcome: GraphRequestOutcome;
  /** Time spent awaiting the upstream Graph response. Zero for rejected requests. */
  upstreamMs: number;
  /**
   * Time from request arrival to the upstream call starting: token acquisition
   * plus the collaboration access check, which can itself call Graph. This is
   * NOT queue time — nothing queues server-side yet — and it will not read 0.
   */
  preflightMs: number;
  timedOut: boolean;
  syncRunId?: string;
  userKey?: string;
}

/** Outcome of a whole sync run, so a partial run is not read as a cheap one. */
export interface SyncRunTelemetry {
  syncRunId: string;
  outcome: 'completed' | 'failed' | 'aborted';
  classCount?: number;
}

export const isValidSyncRunOutcome = (value: unknown): value is SyncRunTelemetry['outcome'] =>
  value === 'completed' || value === 'failed' || value === 'aborted';

export const formatSyncRunTelemetryLine = (
  entry: SyncRunTelemetry & { userKey?: string }
): string => JSON.stringify({ severity: 'INFO', event: 'sync_run', ...entry });

/** One structured line per proxied Graph request; Cloud Logging ingests JSON on stdout natively. */
export const formatGraphTelemetryLine = (entry: GraphRequestTelemetry): string =>
  JSON.stringify({ severity: 'INFO', event: 'graph_request', ...entry });
