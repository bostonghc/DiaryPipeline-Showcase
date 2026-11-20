import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CustomAuthenticationProvider,
  HTTPMessageHandler,
  type Middleware,
} from '@microsoft/microsoft-graph-client';
import { buildGraphMiddlewareChain, getGraphRetryAfterMs, GraphService, GRAPH_FORBIDDEN_EVENT } from './graphService';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const authProvider = () => new CustomAuthenticationProvider((done) => done(null, 'test-token'));

/** Links a chain the way HTTPClient does, and swaps the transport for a probe. */
const runChain = async (
  chain: Middleware[],
  transport: (context: any) => Promise<void>,
  contexts: any[]
) => {
  const probe: Middleware = { execute: transport };
  for (let i = 0; i < chain.length - 1; i++) chain[i].setNext!(chain[i + 1]);
  chain[chain.length - 2].setNext!(probe); // replace HTTPMessageHandler
  return Promise.allSettled(contexts.map((c) => chain[0].execute(c)));
};

const makeContext = (url: string) => ({
  request: url,
  options: { method: 'GET', headers: {} },
  middlewareControl: undefined,
});

describe('graph middleware chain composition', () => {
  it('places the concurrency gate immediately before the transport', () => {
    const chain = buildGraphMiddlewareChain(authProvider());
    const names = chain.map((m) => m.constructor.name);
    expect(names[names.length - 1]).toBe('HTTPMessageHandler');
    expect(names[names.length - 2]).toBe('GraphConcurrencyMiddleware');
    // Gate must sit below RetryHandler so retry sleeps do not hold a slot.
    expect(names.indexOf('RetryHandler')).toBeLessThan(names.length - 2);
    expect(chain[chain.length - 1]).toBeInstanceOf(HTTPMessageHandler);
  });

  it('keeps the SDK default handlers rather than a hand-built chain', () => {
    const names = buildGraphMiddlewareChain(authProvider()).map((m) => m.constructor.name);
    expect(names).toContain('AuthenticationHandler');
    expect(names).toContain('RetryHandler');
    expect(names).toContain('TelemetryHandler');
  });
});

describe('graph concurrency gate', () => {
  it('caps concurrent transport calls at two', async () => {
    const chain = buildGraphMiddlewareChain(authProvider());
    let active = 0;
    let maxActive = 0;
    await runChain(
      chain,
      async (context) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        context.response = { status: 200, headers: new Headers() };
      },
      Array.from({ length: 8 }, (_, i) => makeContext(`https://graph.microsoft.com/v1.0/x${i}`))
    );
    expect(maxActive).toBe(2);
  });

  it('shares one semaphore across separate GraphService clients', async () => {
    // Each client builds its own adapter; the semaphore behind them is shared,
    // so two services cannot each run two requests at once.
    const chains = [buildGraphMiddlewareChain(authProvider()), buildGraphMiddlewareChain(authProvider())];
    let active = 0;
    let maxActive = 0;
    const transport = async (context: any) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      context.response = { status: 200, headers: new Headers() };
    };
    await Promise.all(
      chains.map((chain) =>
        runChain(chain, transport, Array.from({ length: 4 }, (_, i) => makeContext(`https://graph.microsoft.com/v1.0/y${i}`)))
      )
    );
    expect(maxActive).toBe(2);
  });

  it('releases its slot while a retry sleeps', async () => {
    // The reason the gate sits below RetryHandler. If a slot were held for the
    // whole retry sequence, a backoff sleep (Retry-After honoured up to 180s)
    // would stall unrelated Graph work. Assert the retried attempt lands last,
    // after every other request has passed through the gate during the sleep.
    const chain = buildGraphMiddlewareChain(authProvider());
    const retry: any = chain.find((m) => m.constructor.name === 'RetryHandler');
    retry.options.delay = 1;
    retry.options.maxRetries = 1;

    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const attempts = new Map<string, number>();

    await runChain(
      chain,
      async (context: any) => {
        const url: string = context.request;
        const name = url.slice(url.lastIndexOf('/') + 1);
        const attempt = (attempts.get(name) || 0) + 1;
        attempts.set(name, attempt);
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`${name}#${attempt}`);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        context.response =
          name === 'slow' && attempt === 1
            ? { status: 503, headers: new Headers() }
            : { status: 200, headers: new Headers() };
      },
      [
        makeContext('https://graph.microsoft.com/v1.0/slow'),
        ...Array.from({ length: 4 }, (_, i) => makeContext(`https://graph.microsoft.com/v1.0/fast${i}`)),
      ]
    );

    expect(maxActive).toBe(2);
    expect(attempts.get('slow')).toBe(2);
    // Every fast request got through while the retry was sleeping.
    expect(order[order.length - 1]).toBe('slow#2');
    expect(order.filter((o) => o.startsWith('fast')).length).toBe(4);
  });

  it('releases its slot when the transport rejects', async () => {
    const chain = buildGraphMiddlewareChain(authProvider());
    let calls = 0;
    const results = await runChain(
      chain,
      async (context) => {
        calls++;
        if (calls <= 2) throw new Error('transport failure');
        context.response = { status: 200, headers: new Headers() };
      },
      Array.from({ length: 6 }, (_, i) => makeContext(`https://graph.microsoft.com/v1.0/z${i}`))
    );
    // A leaked slot would deadlock the remaining requests rather than settle them.
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.status === 'fulfilled' || r.status === 'rejected')).toBe(true);
    expect(calls).toBe(6);
  });

  it('gives each client its own adapter instance', () => {
    const a = buildGraphMiddlewareChain(authProvider());
    const b = buildGraphMiddlewareChain(authProvider());
    const gateA = a[a.length - 2];
    const gateB = b[b.length - 2];
    // Sharing one middleware object would let client B overwrite A's setNext.
    expect(gateA).not.toBe(gateB);
  });
});

describe('getGraphRetryAfterMs', () => {
  it('reads Retry-After off an exhausted Graph error', () => {
    const error = { statusCode: 429, headers: new Headers({ 'Retry-After': '42' }) };
    expect(getGraphRetryAfterMs(error)).toBe(42 * 1000 + 500);
  });

  it('returns null when the response carried no Retry-After (the OneNote case)', () => {
    expect(getGraphRetryAfterMs({ statusCode: 429, headers: new Headers() })).toBeNull();
  });

  it('returns null for an error with no headers at all', () => {
    expect(getGraphRetryAfterMs(new Error('boom'))).toBeNull();
    expect(getGraphRetryAfterMs(undefined)).toBeNull();
  });
});

describe('proxy 403 events survive the middleware change', () => {
  it('dispatches GRAPH_FORBIDDEN_EVENT with the class id from the path', async () => {
    const dispatched: any[] = [];
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost:3000' },
      dispatchEvent: (e: any) => { dispatched.push(e); return true; },
    });
    vi.stubGlobal('CustomEvent', class { type: string; detail: any; constructor(t: string, i: any) { this.type = t; this.detail = i?.detail; } } as any);

    const graph = new GraphService('server-session-proxy', true);
    (graph as any).client = {
      api: () => ({
        select: function () { return this; },
        get: async () => { throw Object.assign(new Error('Forbidden'), { statusCode: 403 }); },
      }),
    };

    await expect(
      (graph as any).api('/groups/class-123/onenote/sections').select('id').get()
    ).rejects.toThrow('Forbidden');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe(GRAPH_FORBIDDEN_EVENT);
    expect(dispatched[0].detail.classId).toBe('class-123');
  });
});
