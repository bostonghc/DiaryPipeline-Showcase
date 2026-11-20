import type { User } from 'firebase/auth';
import type { AuthResponseBody } from '../hooks/useCollaborationAccess';

interface MicrosoftRecovery {
  refresh: () => Promise<AuthResponseBody | null>;
  openSignIn: () => Promise<Window | null>;
  /** True while another sign-in is already opening (a null popup then is not a popup block). */
  isSignInBusy?: () => boolean;
  timeoutMs?: number;
}

/** Opening a popup is not a completed sign-in. Resolve only after the server confirms it. */
export async function recoverAiReviewMicrosoftSignIn({ refresh, openSignIn, isSignInBusy, timeoutMs = 120_000 }: MicrosoftRecovery): Promise<void> {
  const existing = await refresh();
  if (existing?.account) return;
  if (!existing) throw new Error('Could not check your Microsoft sign-in. Try again.');

  await new Promise<void>((resolve, reject) => {
    let popup: Window | null = null;
    let finished = false;
    let checking = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timeout);
      clearInterval(closed);
      if (error) reject(error);
      else resolve();
    };
    const confirm = async () => {
      if (finished || checking) return;
      checking = true;
      try {
        const result = await refresh();
        if (!result?.account) throw new Error('Microsoft sign-in did not complete. Try again.');
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Could not confirm your Microsoft sign-in.'));
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.type !== 'OAUTH_AUTH_SUCCESS') return;
      if (!popup || event.source !== popup) return;
      void confirm();
    };
    const timeout = setTimeout(() => finish(new Error('Microsoft sign-in timed out. Try again.')), timeoutMs);
    const closed = setInterval(() => {
      if (popup?.closed && !checking) finish(new Error('Microsoft sign-in was cancelled. Try again.'));
    }, 250);
    window.addEventListener('message', onMessage);
    if (isSignInBusy?.()) {
      finish(new Error('A sign-in window is already open.'));
      return;
    }
    void openSignIn().then((opened) => {
      popup = opened;
      if (!opened) finish(new Error('Could not open Microsoft sign-in. Allow popups and try again.'));
    }).catch((error) => finish(error instanceof Error ? error : new Error('Could not open Microsoft sign-in.')));
  });
}

/** An already signed-in Google user still needs a fresh token after a server token error. */
export async function recoverAiReviewGoogleSignIn({
  currentUser, openSignIn,
}: {
  currentUser: () => User | null;
  openSignIn: () => Promise<void>;
}): Promise<void> {
  if (!currentUser()) await openSignIn();
  const user = currentUser();
  if (!user) throw new Error('Google sign-in did not complete. Try again.');
  await user.getIdToken(true);
}
