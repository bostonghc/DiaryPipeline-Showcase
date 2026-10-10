import { describe, it, expect } from 'vitest';
import { isGraphPathAllowed } from './graphProxyAllowlist';

describe('isGraphPathAllowed — Graph proxy allowlist', () => {
  it('permits every (method, path) the app actually issues', () => {
    const allowed: Array<[string, string]> = [
      ['GET', 'me'],
      ['GET', 'me/joinedTeams'],
      ['GET', 'me/memberOf'],
      ['GET', 'me/onenote/notebooks'],
      ['GET', 'me/onenote/notebooks/abc123'],
      ['GET', 'me/onenote/sections/sec1/pages'],
      ['GET', 'me/onenote/pages/p1/content'],
      ['GET', 'groups/g1/onenote/sections'],
      ['GET', 'groups/g1/members'],
      ['GET', 'education/classes'],
      ['GET', 'education/classes/c1/members'],
      ['GET', 'users'],
      ['GET', "users/ak123@school.edu"],
      ['POST', 'me/sendMail'],
      ['POST', 'chats'],
      ['POST', 'chats/19:abc@thread/messages'],
    ];
    for (const [method, path] of allowed) {
      expect(isGraphPathAllowed(method, path), `${method} ${path}`).toBe(true);
    }
  });

  it('rejects disallowed methods on otherwise-known paths', () => {
    expect(isGraphPathAllowed('DELETE', 'me')).toBe(false);
    expect(isGraphPathAllowed('PATCH', 'me')).toBe(false);
    expect(isGraphPathAllowed('PUT', 'chats')).toBe(false);
    expect(isGraphPathAllowed('POST', 'me')).toBe(false);
    expect(isGraphPathAllowed('POST', 'me/onenote/notebooks')).toBe(false);
  });

  it('rejects arbitrary Graph paths not used by the app', () => {
    expect(isGraphPathAllowed('GET', 'chats')).toBe(false); // listing all chats
    expect(isGraphPathAllowed('POST', 'users')).toBe(false); // creating a user
    expect(isGraphPathAllowed('GET', 'me/messages')).toBe(false); // mailbox read
    expect(isGraphPathAllowed('GET', 'directory/deletedItems')).toBe(false);
    expect(isGraphPathAllowed('GET', 'subscriptions')).toBe(false);
    expect(isGraphPathAllowed('DELETE', 'me/onenote/pages/p1')).toBe(false);
  });

  it('normalises a leading slash, trailing slash, and query string', () => {
    expect(isGraphPathAllowed('GET', '/me')).toBe(true);
    expect(isGraphPathAllowed('GET', 'me/onenote/notebooks/')).toBe(true);
    expect(isGraphPathAllowed('GET', "users?$filter=startsWith(mail,'ak')")).toBe(true);
  });

  it('is case-insensitive on the HTTP method', () => {
    expect(isGraphPathAllowed('get', 'me')).toBe(true);
    expect(isGraphPathAllowed('post', 'chats')).toBe(true);
  });
});
