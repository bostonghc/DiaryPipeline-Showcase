import { useEffect, useRef } from 'react';
import {
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_PATH,
  interpretKeepAliveStatus,
  shouldSendKeepAlive,
} from '../services/sessionKeepAlive';

// What counts as using the page. Pointer movement is included on purpose: someone
// presenting to a room points and talks without clicking, and is still present.
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

/**
 * Keeps the server session alive while a signed-in person is actually using the
 * page, because most of what they do reads Firestore directly and the server
 * would otherwise see them as idle. Pings stop once they stop. The server
 * decides sign-out; when it says the sign-in ended, `onSessionEnded` lets the
 * access controller find out and show the signed-out state.
 */
export const useSessionKeepAlive = ({
  signedIn,
  onSessionEnded,
}: {
  signedIn: boolean;
  onSessionEnded: () => void;
}): void => {
  const onSessionEndedRef = useRef(onSessionEnded);
  useEffect(() => {
    onSessionEndedRef.current = onSessionEnded;
  }, [onSessionEnded]);

  useEffect(() => {
    if (!signedIn) return undefined;

    // Opening the page or signing in is itself interaction.
    let lastActivityMs: number | null = Date.now();
    const noteActivity = () => {
      lastActivityMs = Date.now();
    };
    // Capture phase so scrolling inside nested panes is seen too (scroll does not bubble).
    const listenerOptions = { passive: true, capture: true } as const;
    ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, noteActivity, listenerOptions));

    const timer = window.setInterval(async () => {
      if (!shouldSendKeepAlive({ signedIn: true, nowMs: Date.now(), lastActivityMs })) return;
      try {
        const response = await fetch(KEEPALIVE_PATH, { method: 'POST', credentials: 'same-origin' });
        if (interpretKeepAliveStatus(response.status) === 'signed-out') onSessionEndedRef.current();
      } catch {
        // Offline or the server is restarting: the next tick tries again.
      }
    }, KEEPALIVE_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, noteActivity, listenerOptions));
    };
  }, [signedIn]);
};
