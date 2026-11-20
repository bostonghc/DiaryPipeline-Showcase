import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  buildOneOnOneChatPayload,
  describeGraphError,
  GRAPH_FORBIDDEN_EVENT,
  GraphService,
  isGraphThrottleError,
} from './graphService';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buildOneOnOneChatPayload', () => {
  const senderId = '11111111-1111-1111-1111-111111111111';
  const recipientId = '22222222-2222-2222-2222-222222222222';

  it('produces a oneOnOne chat with exactly two members', () => {
    const payload = buildOneOnOneChatPayload(senderId, recipientId);
    expect(payload.chatType).toBe('oneOnOne');
    expect(payload.members).toHaveLength(2);
  });

  it('binds the sender via user@odata.bind to users(id), not /me', () => {
    const payload = buildOneOnOneChatPayload(senderId, recipientId);
    const sender = payload.members[0];
    expect(sender['@odata.type']).toBe('#microsoft.graph.aadUserConversationMember');
    expect(sender.roles).toEqual(['owner']);
    expect(sender['user@odata.bind']).toBe(
      `https://graph.microsoft.com/v1.0/users('${senderId}')`
    );
  });

  it('binds the recipient via user@odata.bind with the resolved id', () => {
    const payload = buildOneOnOneChatPayload(senderId, recipientId);
    const recipient = payload.members[1];
    expect(recipient['@odata.type']).toBe('#microsoft.graph.aadUserConversationMember');
    expect(recipient.roles).toEqual(['owner']);
    expect(recipient['user@odata.bind']).toBe(
      `https://graph.microsoft.com/v1.0/users('${recipientId}')`
    );
  });

  it('every member binds via users(id) and never /me (the Slice 8 failure mode)', () => {
    const payload = buildOneOnOneChatPayload(senderId, recipientId);
    for (const member of payload.members) {
      expect(member).toHaveProperty('user@odata.bind');
      expect(member['user@odata.bind']).toMatch(
        /^https:\/\/graph\.microsoft\.com\/v1\.0\/users\('/
      );
      expect(member['user@odata.bind']).not.toContain('/me');
    }
  });
});

describe('GraphService proxy transport', () => {
  it('routes SDK requests through the same-origin BFF instead of Microsoft Graph', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ value: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const graph = new GraphService('server-session-proxy', true);
    await graph.listClassStudentIdentities('class-a');

    expect(fetchMock).toHaveBeenCalled();
    const request = fetchMock.mock.calls[0][0] as RequestInfo | URL;
    const requestUrl = request instanceof Request ? request.url : request.toString();
    expect(requestUrl).toMatch(/^http:\/\/localhost:3000\/api\/graph\/education\/classes\/class-a\/members/);
    expect(requestUrl).not.toContain('graph.microsoft.com');
  });

  it('emits class-keyed access events when proxy fallbacks return 403', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost:3000' },
      dispatchEvent,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Class not permitted' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    )));

    const graph = new GraphService('server-session-proxy', true);
    await expect(graph.listClassStudentIdentities('class-a')).resolves.toEqual([]);

    expect(dispatchEvent).toHaveBeenCalledTimes(2);
    const event = dispatchEvent.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe(GRAPH_FORBIDDEN_EVENT);
    expect(event.detail).toMatchObject({ classId: 'class-a' });
  });

  it('follows section-page nextLink responses through the same-origin proxy', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost:3000' },
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [{
          id: 'page-1',
          title: '1234501 - Student One',
          lastModifiedDateTime: '2026-08-27T00:00:00.000Z',
          contentUrl: 'https://example.test/page-1',
        }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/groups/class-a/onenote/sections/section-a/pages?$skiptoken=next',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        value: [{
          id: 'page-2',
          title: '1234502 - Student Two',
          lastModifiedDateTime: '2026-08-27T00:00:00.000Z',
          contentUrl: 'https://example.test/page-2',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const graph = new GraphService('server-session-proxy', true);
    const pages = await graph.getSectionPages('class-a', 'section-a');

    expect(pages.map((page) => page.id)).toEqual(['page-1', 'page-2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const continuationRequest = fetchMock.mock.calls[1][0] as RequestInfo | URL;
    const continuationUrl = continuationRequest instanceof Request
      ? continuationRequest.url
      : continuationRequest.toString();
    expect(continuationUrl).toContain('/api/graph/groups/class-a/onenote/sections/section-a/pages');
    expect(continuationUrl).toContain('$skiptoken=next');
    expect(continuationUrl).not.toContain('graph.microsoft.com');
  });
});


describe('isGraphThrottleError', () => {
  it('detects a 429 status code', () => {
    expect(isGraphThrottleError({ statusCode: 429 })).toBe(true);
  });

  it('detects throttling described only in the message', () => {
    expect(isGraphThrottleError({ message: 'Too many requests on behalf of this user' })).toBe(true);
  });

  it('does not treat an ordinary failure as throttling', () => {
    expect(isGraphThrottleError({ statusCode: 504, message: 'Graph did not respond' })).toBe(false);
  });
});

describe('describeGraphError', () => {
  // Regression: proxy-generated failures used to arrive with no message at all
  // and rendered as "Unknown API Error", hiding the status that identified them.
  it('keeps the status code when the error carries no message', () => {
    expect(describeGraphError({ statusCode: 504 })).toBe('HTTP 504 — no error detail returned');
  });

  it('combines status and message when both are present', () => {
    expect(describeGraphError({ statusCode: 504, message: 'Graph did not respond within 90s.' }))
      .toBe('HTTP 504 — Graph did not respond within 90s.');
  });

  it('falls back to the error code when only a code is present', () => {
    expect(describeGraphError({ statusCode: 403, code: 'proxy_path_not_allowed' }))
      .toBe('HTTP 403 — proxy_path_not_allowed');
  });

  it('still describes an error with no status', () => {
    expect(describeGraphError({ message: 'network down' })).toBe('network down');
  });
});
