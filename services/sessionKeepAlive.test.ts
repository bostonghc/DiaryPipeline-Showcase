import { describe, expect, it } from 'vitest';
import {
  ACTIVE_WINDOW_MS,
  KEEPALIVE_INTERVAL_MS,
  interpretKeepAliveStatus,
  shouldSendKeepAlive,
} from './sessionKeepAlive';
import { readSessionLifetimeConfig } from './sessionLifetime';

const MINUTE = 60 * 1000;
const now = 10_000_000;

describe('when to send a keep-alive', () => {
  it('sends while the person has used the page within the active window', () => {
    expect(shouldSendKeepAlive({ signedIn: true, nowMs: now, lastActivityMs: now - 2 * MINUTE })).toBe(true);
  });

  it('stays quiet once the person has been inactive for the whole window', () => {
    expect(
      shouldSendKeepAlive({ signedIn: true, nowMs: now, lastActivityMs: now - ACTIVE_WINDOW_MS })
    ).toBe(false);
  });

  it('stays quiet when nothing has been seen yet', () => {
    expect(shouldSendKeepAlive({ signedIn: true, nowMs: now, lastActivityMs: null })).toBe(false);
  });

  it('stays quiet when there is no Microsoft sign-in to keep alive', () => {
    expect(shouldSendKeepAlive({ signedIn: false, nowMs: now, lastActivityMs: now })).toBe(false);
  });
});

describe('reading the keep-alive reply', () => {
  it('treats a 204 as the session being renewed', () => {
    expect(interpretKeepAliveStatus(204)).toBe('renewed');
  });

  it('treats a 401 as the Microsoft sign-in having ended', () => {
    expect(interpretKeepAliveStatus(401)).toBe('signed-out');
  });

  it('does not mistake a server error or a gateway timeout for a sign-out', () => {
    expect(interpretKeepAliveStatus(500)).toBe('unreachable');
    expect(interpretKeepAliveStatus(503)).toBe('unreachable');
    expect(interpretKeepAliveStatus(504)).toBe('unreachable');
  });
});

describe('keep-alive timing against the server idle timeout', () => {
  it('pings several times inside the idle timeout, so one lost request does not sign anyone out', () => {
    const { idleMs } = readSessionLifetimeConfig({});
    expect(KEEPALIVE_INTERVAL_MS * 3).toBeLessThanOrEqual(idleMs);
  });

  it('keeps pinging at least twice after the last interaction', () => {
    expect(ACTIVE_WINDOW_MS).toBeGreaterThanOrEqual(KEEPALIVE_INTERVAL_MS * 2);
  });
});
