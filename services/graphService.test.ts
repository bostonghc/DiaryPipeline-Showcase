import { describe, it, expect } from 'vitest';
import { buildOneOnOneChatPayload } from './graphService';

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
