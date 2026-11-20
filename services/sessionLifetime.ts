import type { RequestHandler } from 'express';
import type { SessionOptions } from 'express-session';

/**
 * Server session lifetime. The cookie is an idle timeout: it is renewed on every
 * request (`rolling`), so someone who is working is not signed out mid-task. The
 * absolute cap bounds how long activity alone can keep one Microsoft sign-in
 * alive, because the server silently refreshes the Microsoft token behind it.
 *
 * Sessions live in process memory (docs/collaboration-pilot-deployment.md), so a
 * restart ends them regardless of either limit.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const DEFAULT_IDLE_MINUTES = 60;
const DEFAULT_MAX_HOURS = 5;

export interface SessionLifetimeConfig {
  idleMs: number;
  maxMs: number;
}

const positiveNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const readSessionLifetimeConfig = (
  env: Record<string, string | undefined>
): SessionLifetimeConfig => ({
  idleMs: positiveNumber(env.SESSION_IDLE_MINUTES, DEFAULT_IDLE_MINUTES) * MINUTE_MS,
  maxMs: positiveNumber(env.SESSION_MAX_HOURS, DEFAULT_MAX_HOURS) * HOUR_MS,
});

export const buildSessionOptions = (options: {
  secret: string;
  secure: boolean;
  idleMs: number;
}): SessionOptions => ({
  secret: options.secret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: options.secure, // HTTPS only in production; plain http in local dev
    sameSite: 'lax', // CSRF defense: cookie not sent in third-party contexts
    httpOnly: true,
    maxAge: options.idleMs,
  },
});

/**
 * The browser's keep-alive (services/sessionKeepAlive.ts). The rolling cookie is
 * renewed by express-session on any request, so by the time this runs the work is
 * done; it only reports whether a Microsoft sign-in is still behind the cookie.
 *
 * It deliberately does nothing else. No token refresh, no Graph or membership
 * lookup: an intern's access profile is resolved by a Graph call, so reusing
 * /api/auth/me for a ping every few minutes would spend one per intern each time.
 * Mount after enforceSessionCap so a ping cannot outlive the cap.
 */
export const keepAliveHandler: RequestHandler = (req, res) => {
  // A cached 204 would answer from the browser and never reach the session.
  res.set('Cache-Control', 'no-store');
  const sessionState = req.session as unknown as { account?: unknown } | undefined;
  if (!sessionState?.account) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  res.status(204).end();
};

export type SessionAgeDecision = 'ok' | 'stamp' | 'expired';

/**
 * 'stamp' covers a signed-in session created before sign-in times were recorded
 * (for example across a deploy): it is given a start time now rather than being
 * ended, so rolling out the cap does not sign everyone out at once.
 */
export const evaluateSessionAge = (
  sessionState: { signedIn: boolean; signedInAtMs?: number },
  nowMs: number,
  maxMs: number
): SessionAgeDecision => {
  if (!sessionState.signedIn) return 'ok';
  if (sessionState.signedInAtMs === undefined) return 'stamp';
  return nowMs - sessionState.signedInAtMs >= maxMs ? 'expired' : 'ok';
};

/**
 * Applies the absolute cap. Mount after express-session. The Microsoft sign-in
 * callback records `signedInAtMs`; an expired session is replaced (not destroyed)
 * so later handlers can keep using req.session and see an anonymous visitor.
 */
export const enforceSessionCap = (maxMs: number): RequestHandler => (req, _res, next) => {
  const sessionState = req.session as unknown as { account?: unknown; signedInAtMs?: number };
  const decision = evaluateSessionAge(
    { signedIn: Boolean(sessionState?.account), signedInAtMs: sessionState?.signedInAtMs },
    Date.now(),
    maxMs
  );
  if (decision === 'stamp') sessionState.signedInAtMs = Date.now();
  if (decision !== 'expired') return next();
  req.session.regenerate((error) => next(error));
};
