// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverAiReviewGoogleSignIn, recoverAiReviewMicrosoftSignIn } from './aiReviewRecoveryActions';
import type { User } from 'firebase/auth';

const authenticated = { account: { username: 'teacher@example.edu' } } as never;
const signedOut = { error: 'not_authenticated' };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('AI review Microsoft recovery', () => {
  it('clears a stale auth error only after the server confirms the existing session', async () => {
    const result = deferred<never>();
    const refresh = vi.fn(() => result.promise);
    const openSignIn = vi.fn();
    let finished = false;
    const p = recoverAiReviewMicrosoftSignIn({ refresh, openSignIn }).then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    result.resolve(authenticated);
    await p;
    expect(finished).toBe(true);
    expect(openSignIn).not.toHaveBeenCalled();
  });

  it('waits for its popup success and a validated session, ignoring unrelated messages', async () => {
    const popup = { closed: false } as Window;
    const refresh = vi.fn().mockResolvedValueOnce(signedOut).mockResolvedValueOnce(authenticated);
    const opened = deferred<Window | null>();
    let finished = false;
    const p = recoverAiReviewMicrosoftSignIn({ refresh, openSignIn: () => opened.promise }).then(() => { finished = true; });
    opened.resolve(popup);
    await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false);
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://untrusted.example', source: popup, data: { type: 'OAUTH_AUTH_SUCCESS' } }));
    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data: { type: 'OAUTH_AUTH_SUCCESS' } }));
    expect(refresh).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, source: popup, data: { type: 'OAUTH_AUTH_SUCCESS' } }));
    await p;
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(finished).toBe(true);
  });

  it('rejects blocked or cancelled sign-in rather than declaring recovery', async () => {
    await expect(recoverAiReviewMicrosoftSignIn({ refresh: async () => signedOut, openSignIn: async () => null })).rejects.toThrow('Allow popups');
    vi.useFakeTimers();
    const p = recoverAiReviewMicrosoftSignIn({ refresh: async () => signedOut, openSignIn: async () => ({ closed: true } as Window) });
    const failed = expect(p).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(250);
    await failed;
  });

  it('says a sign-in window is already open instead of blaming popups when busy', async () => {
    const openSignIn = vi.fn(async () => null);
    await expect(recoverAiReviewMicrosoftSignIn({ refresh: async () => signedOut, openSignIn, isSignInBusy: () => true }))
      .rejects.toThrow('A sign-in window is already open.');
    expect(openSignIn).not.toHaveBeenCalled();
  });

  it('does not treat a success message as sufficient when the session still fails', async () => {
    const popup = { closed: false } as Window;
    const p = recoverAiReviewMicrosoftSignIn({ refresh: async () => signedOut, openSignIn: async () => popup });
    const failed = expect(p).rejects.toThrow('did not complete');
    await Promise.resolve(); await Promise.resolve();
    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, source: popup, data: { type: 'OAUTH_AUTH_SUCCESS' } }));
    await failed;
  });
});

describe('AI review Google recovery', () => {
  it('refreshes the token when an existing Google sign-in was rejected by the server', async () => {
    const user = { getIdToken: vi.fn().mockResolvedValue('fresh') } as unknown as User;
    const openSignIn = vi.fn();
    await recoverAiReviewGoogleSignIn({ currentUser: () => user, openSignIn });
    expect(user.getIdToken).toHaveBeenCalledWith(true);
    expect(openSignIn).not.toHaveBeenCalled();
  });

  it('awaits a new sign-in, and does not call cancellation or token failure a success', async () => {
    let user: User | null = null;
    const signedIn = { getIdToken: vi.fn().mockResolvedValue('fresh') } as unknown as User;
    await recoverAiReviewGoogleSignIn({ currentUser: () => user, openSignIn: async () => { user = signedIn; } });
    expect(signedIn.getIdToken).toHaveBeenCalledWith(true);
    await expect(recoverAiReviewGoogleSignIn({ currentUser: () => null, openSignIn: async () => {} })).rejects.toThrow('did not complete');
    const bad = { getIdToken: vi.fn().mockRejectedValue(new Error('token refresh failed')) } as unknown as User;
    await expect(recoverAiReviewGoogleSignIn({ currentUser: () => bad, openSignIn: vi.fn() })).rejects.toThrow('token refresh failed');
  });
});
