/**
 * Browser side of the session keep-alive. The server idle timeout restarts on
 * every request, but most of what a person does in the dashboard reads Firestore
 * directly and never reaches the server, so someone actively working looks idle
 * to it. While the person is really using the page we send a tiny ping to say so;
 * once they stop, the pings stop and the idle timeout runs as normal. The 5-hour
 * cap on one Microsoft sign-in still applies (services/sessionLifetime.ts).
 */

export const KEEPALIVE_PATH = '/api/auth/keepalive';

/** How often to check whether a ping is due. Well inside the 60-minute default idle timeout. */
export const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

/** A person counts as present for this long after their last click, key, scroll or touch. */
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

export type KeepAliveOutcome = 'renewed' | 'signed-out' | 'unreachable';

export const shouldSendKeepAlive = (state: {
  signedIn: boolean;
  nowMs: number;
  /** Null until the page has seen any interaction. */
  lastActivityMs: number | null;
}): boolean =>
  state.signedIn &&
  state.lastActivityMs !== null &&
  state.nowMs - state.lastActivityMs < ACTIVE_WINDOW_MS;

/**
 * Only a 401 means the Microsoft sign-in ended. A 5xx or gateway timeout (a
 * restarting instance, a slow cold start) says nothing about the session, so it
 * must not be shown to the person as a sign-out; the next ping tries again.
 */
export const interpretKeepAliveStatus = (status: number): KeepAliveOutcome => {
  if (status === 401) return 'signed-out';
  return status >= 200 && status < 300 ? 'renewed' : 'unreachable';
};
