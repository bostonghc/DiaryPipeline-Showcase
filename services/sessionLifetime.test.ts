import express from 'express';
import session from 'express-session';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSessionOptions,
  enforceSessionCap,
  evaluateSessionAge,
  keepAliveHandler,
  readSessionLifetimeConfig,
} from './sessionLifetime';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe('session lifetime config', () => {
  it('defaults to a 60-minute idle timeout and a 5-hour cap', () => {
    expect(readSessionLifetimeConfig({})).toEqual({ idleMs: 60 * MINUTE, maxMs: 5 * HOUR });
  });

  it('reads both limits from the environment', () => {
    const config = readSessionLifetimeConfig({ SESSION_IDLE_MINUTES: '30', SESSION_MAX_HOURS: '2' });
    expect(config).toEqual({ idleMs: 30 * MINUTE, maxMs: 2 * HOUR });
  });

  it('falls back to the defaults for values that are not positive numbers', () => {
    const config = readSessionLifetimeConfig({ SESSION_IDLE_MINUTES: '0', SESSION_MAX_HOURS: 'soon' });
    expect(config).toEqual({ idleMs: 60 * MINUTE, maxMs: 5 * HOUR });
  });
});

describe('absolute session cap', () => {
  const signedInAt = 1_000_000;

  it('leaves a session without a Microsoft sign-in alone', () => {
    expect(evaluateSessionAge({ signedIn: false }, signedInAt + 10 * HOUR, 5 * HOUR)).toBe('ok');
  });

  it('asks for a sign-in time to be recorded on a signed-in session that has none', () => {
    expect(evaluateSessionAge({ signedIn: true }, signedInAt, 5 * HOUR)).toBe('stamp');
  });

  it('keeps a signed-in session that is inside the cap', () => {
    expect(
      evaluateSessionAge({ signedIn: true, signedInAtMs: signedInAt }, signedInAt + 5 * HOUR - 1, 5 * HOUR)
    ).toBe('ok');
  });

  it('ends a signed-in session once it reaches the cap, however recently it was used', () => {
    expect(
      evaluateSessionAge({ signedIn: true, signedInAtMs: signedInAt }, signedInAt + 5 * HOUR, 5 * HOUR)
    ).toBe('expired');
  });
});

describe('rolling session cookie', () => {
  let server: Server | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  // A real express-session over HTTP: this checks the behavior users feel, not
  // just that an option is set. Only Date is faked so the server and fetch keep
  // working on real timers.
  const startApp = async () => {
    const app = express();
    app.use(session(buildSessionOptions({ secret: 'test-secret', secure: false, idleMs: HOUR })));
    app.use(enforceSessionCap(5 * HOUR));
    app.get('/sign-in', (req, res) => {
      (req.session as any).account = { username: 'owner@example.edu' };
      (req.session as any).signedInAtMs = Date.now();
      res.json({ ok: true });
    });
    // A session from before sign-in times were recorded: signed in, no stamp.
    app.get('/sign-in-unstamped', (req, res) => {
      (req.session as any).account = { username: 'owner@example.edu' };
      res.json({ ok: true });
    });
    app.get('/who', (req, res) => res.json({ account: (req.session as any).account ?? null }));
    app.post('/keepalive', keepAliveHandler);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Like a browser: a cookie past its Expires is not sent, which is what
    // actually signs a user out when the cookie is not renewed.
    let cookie = '';
    let cookieExpiresMs = 0;
    return async (path: string, method = 'GET') => {
      const sendCookie = cookie !== '' && Date.now() < cookieExpiresMs;
      const response = await fetch(`${base}${path}`, { method, headers: sendCookie ? { cookie } : {} });
      const setCookie = response.headers.getSetCookie()[0];
      if (setCookie) {
        cookie = setCookie.split(';')[0];
        cookieExpiresMs = Date.parse(/Expires=([^;]+)/.exec(setCookie)![1]);
      }
      const text = await response.text();
      return {
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
        body: text ? JSON.parse(text) : null,
        setCookie,
      };
    };
  };

  it('keeps a signed-in session alive past one hour while the user stays active', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const request = await startApp();

    await request('/sign-in');
    vi.setSystemTime(start + 40 * MINUTE);
    await request('/who');
    vi.setSystemTime(start + 80 * MINUTE);
    await request('/who');
    vi.setSystemTime(start + 120 * MINUTE);

    expect((await request('/who')).body.account).toEqual({ username: 'owner@example.edu' });
  });

  it('pushes the cookie expiry out on every request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const request = await startApp();

    await request('/sign-in');
    vi.setSystemTime(start + 30 * MINUTE);
    const renewed = (await request('/who')).setCookie;

    expect(renewed).toBeDefined();
    const expires = Date.parse(/Expires=([^;]+)/.exec(renewed as string)![1]);
    expect(expires).toBeGreaterThanOrEqual(start + 30 * MINUTE + HOUR - 1000);
  });

  it('still ends the session at the 5-hour cap for a user who never went idle', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const request = await startApp();

    await request('/sign-in');
    for (let minutes = 40; minutes < 5 * 60; minutes += 40) {
      vi.setSystemTime(start + minutes * MINUTE);
      expect((await request('/who')).body.account).not.toBeNull();
    }
    vi.setSystemTime(start + 5 * HOUR + MINUTE);

    expect((await request('/who')).body.account).toBeNull();
  });

  it('gives a session from before the cap existed a fresh 5 hours, not an immediate sign-out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const request = await startApp();

    await request('/sign-in-unstamped');
    expect((await request('/who')).body.account).not.toBeNull();
    for (let minutes = 40; minutes < 4 * 60; minutes += 40) {
      vi.setSystemTime(start + minutes * MINUTE);
      expect((await request('/who')).body.account).not.toBeNull();
    }
    vi.setSystemTime(start + 5 * HOUR + MINUTE);

    expect((await request('/who')).body.account).toBeNull();
  });

  it('signs the user out after an hour with no activity', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const request = await startApp();

    await request('/sign-in');
    vi.setSystemTime(start + HOUR + MINUTE);

    expect((await request('/who')).body.account).toBeNull();
  });

  describe('keep-alive request', () => {
    it('confirms a signed-in session with an empty 204 that is never cached', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const request = await startApp();

      await request('/sign-in');
      const response = await request('/keepalive', 'POST');

      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
      expect(response.cacheControl).toBe('no-store');
    });

    it('tells a visitor with no Microsoft sign-in that there is nothing to keep alive', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const request = await startApp();

      const response = await request('/keepalive', 'POST');

      expect(response.status).toBe(401);
      expect(response.cacheControl).toBe('no-store');
    });

    it('holds a session open past an hour when it is the only traffic', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.now();
      const request = await startApp();

      await request('/sign-in');
      for (let minutes = 5; minutes <= 150; minutes += 5) {
        vi.setSystemTime(start + minutes * MINUTE);
        expect((await request('/keepalive', 'POST')).status).toBe(204);
      }

      expect((await request('/who')).body.account).not.toBeNull();
    });

    it('does not extend a sign-in past the cap', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.now();
      const request = await startApp();

      await request('/sign-in');
      for (let minutes = 5; minutes < 5 * 60; minutes += 5) {
        vi.setSystemTime(start + minutes * MINUTE);
        expect((await request('/keepalive', 'POST')).status).toBe(204);
      }
      vi.setSystemTime(start + 5 * HOUR + MINUTE);

      expect((await request('/keepalive', 'POST')).status).toBe(401);
      expect((await request('/who')).body.account).toBeNull();
    });

    it('does not bring back a session that already went idle', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.now();
      const request = await startApp();

      await request('/sign-in');
      vi.setSystemTime(start + HOUR + MINUTE);

      expect((await request('/keepalive', 'POST')).status).toBe(401);
      expect((await request('/who')).body.account).toBeNull();
    });
  });
});
