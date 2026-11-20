// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIdentityBinding } from './useIdentityBinding';
import { buildIdentityClaims } from '../services/identityClaims';
import { readCollaborationConfig, resolveCollaborationAccess } from '../services/collaborationAccess';
import type { User } from 'firebase/auth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const profile = resolveCollaborationAccess(readCollaborationConfig({}), { username: 'teacher@example.edu', name: 'Teacher' });
const claims = buildIdentityClaims(profile, 'now')!;
describe('identity binding recovery', () => {
  let root: Root;
  let api: ReturnType<typeof useIdentityBinding>;
  const fetchMock = vi.fn();
  const user = () => ({
    uid: 'google-user',
    getIdToken: vi.fn().mockResolvedValue('token'),
    getIdTokenResult: vi.fn().mockResolvedValue({ claims }),
  }) as unknown as User;
  const Probe = ({ firebaseUser }: { firebaseUser: User | null }) => {
    api = useIdentityBinding(firebaseUser, 'teacher@example.edu', profile);
    return null;
  };
  beforeEach(() => { root = createRoot(document.createElement('div')); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

  it('manual retry validates with the server even when cached claims already look bound', async () => {
    const u = user();
    await act(async () => root.render(createElement(Probe, { firebaseUser: u })));
    expect(api.status).toBe('bound');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue({ ok: true });
    await act(async () => api.retry());
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/firebase-binding', expect.objectContaining({ method: 'POST' }));
    expect(u.getIdToken).toHaveBeenCalledWith(true);
    expect(u.getIdTokenResult).toHaveBeenLastCalledWith(true);
    expect(api.status).toBe('bound');
  });

  it('rejects retry when linking fails and preserves the failed state for recovery', async () => {
    await act(async () => root.render(createElement(Probe, { firebaseUser: user() })));
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await act(async () => { await expect(api.retry()).rejects.toThrow('binding failed'); });
    expect(api.status).toBe('error');
    expect(api.error).toContain('503');
  });

  it('rejects retry without a Firebase sign-in', async () => {
    await act(async () => root.render(createElement(Probe, { firebaseUser: null })));
    await act(async () => { await expect(api.retry()).rejects.toThrow('Sign in'); });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
