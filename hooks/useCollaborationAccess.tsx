import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CollaborationAccessProfile, CollaborationRole } from '../services/collaborationAccess';
import { isClassAllowed as isProfileClassAllowed } from '../services/collaborationAccess';
import { GRAPH_FORBIDDEN_EVENT, type GraphForbiddenDetail } from '../services/graphService';

export interface MicrosoftAccount {
  homeAccountId: string;
  localAccountId: string;
  tenantId?: string;
  username: string;
  name?: string;
}

export type CollaborationAccessStatus = 'loading' | 'ready' | 'denied' | 'error';

export interface AuthResponseBody {
  account?: MicrosoftAccount;
  access?: CollaborationAccessProfile;
  aiReview?: { configured?: boolean };
  error?: string;
}

export type AccessResponseDecision =
  | { kind: 'ready'; account: MicrosoftAccount; profile: CollaborationAccessProfile }
  | { kind: 'denied'; account: MicrosoftAccount; profile: CollaborationAccessProfile; error: string }
  | { kind: 'signed_out' }
  | { kind: 'error'; error: string };

export const interpretAccessResponse = (
  status: number,
  ok: boolean,
  body: AuthResponseBody
): AccessResponseDecision => {
  if (status === 403 && body.account && body.access) {
    return { kind: 'denied', account: body.account, profile: body.access, error: body.error || 'not_assigned' };
  }
  if (status === 401) return { kind: 'signed_out' };
  if (!ok || !body.account || !body.access) {
    return { kind: 'error', error: body.error || `Access check failed (${status})` };
  }
  if (!body.access.allowed) {
    return { kind: 'denied', account: body.account, profile: body.access, error: body.error || 'not_assigned' };
  }
  return { kind: 'ready', account: body.account, profile: body.access };
};

/**
 * The role the browser last saw while signed in. It survives the Microsoft
 * session ending (a 401 clears the profile) so screens can say "your sign-in
 * expired" instead of treating the person as someone without permission. An
 * explicit sign-out or a denied account forgets it.
 */
export const nextLastKnownRole = (
  previous: CollaborationRole | null,
  decision: AccessResponseDecision
): CollaborationRole | null => {
  if (decision.kind === 'ready') return decision.profile.role;
  if (decision.kind === 'denied') return null;
  return previous;
};

export interface CollaborationAccessValue {
  account: MicrosoftAccount | null;
  profile: CollaborationAccessProfile | null;
  lastKnownRole: CollaborationRole | null;
  status: CollaborationAccessStatus;
  error: string | null;
  /** Server says the AI review credential is set up (from /api/auth/me). */
  aiReviewConfigured?: boolean;
  isClassAllowed: (classId: string) => boolean;
  refresh: (options?: { force?: boolean }) => Promise<AuthResponseBody | null>;
  clear: () => void;
}

const PROFILE_TTL_MS = 5 * 60 * 1000;
const FORBIDDEN_REFRESH_FLOOR_MS = 15 * 1000;

const CollaborationAccessContext = createContext<CollaborationAccessValue | null>(null);

export const useCollaborationAccessController = (): CollaborationAccessValue => {
  const [account, setAccount] = useState<MicrosoftAccount | null>(null);
  const [profile, setProfile] = useState<CollaborationAccessProfile | null>(null);
  const [lastKnownRole, setLastKnownRole] = useState<CollaborationRole | null>(null);
  const [status, setStatus] = useState<CollaborationAccessStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [aiReviewConfigured, setAiReviewConfigured] = useState(false);
  const forbiddenRefreshes = useRef(new Map<string, number>());
  const profileRef = useRef<CollaborationAccessProfile | null>(null);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  const refresh = useCallback(async (options: { force?: boolean } = {}) => {
    try {
      const suffix = options.force ? '?refresh=force' : '';
      const response = await fetch(`/api/auth/me${suffix}`, { credentials: 'same-origin' });
      const body = await response.json().catch(() => ({})) as AuthResponseBody;
      const decision = interpretAccessResponse(response.status, response.ok, body);

      if (decision.kind !== 'error') {
        setLastKnownRole((previous) => nextLastKnownRole(previous, decision));
      }

      if (decision.kind === 'denied' || decision.kind === 'ready') {
        setAiReviewConfigured(body.aiReview?.configured === true);
      }

      if (decision.kind === 'denied') {
        setAccount(decision.account);
        setProfile(decision.profile);
        setStatus('denied');
        setError(decision.error);
        return body;
      }
      if (decision.kind === 'signed_out') {
        setAccount(null);
        setProfile(null);
        setAiReviewConfigured(false);
        setStatus('ready');
        setError(null);
        return body;
      }
      if (decision.kind === 'error') {
        throw new Error(decision.error);
      }

      setAccount(decision.account);
      setProfile(decision.profile);
      setStatus('ready');
      setError(null);
      return body;
    } catch (caught) {
      setStatus('error');
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    }
  }, []);

  const clear = useCallback(() => {
    setAccount(null);
    setProfile(null);
    setLastKnownRole(null);
    setAiReviewConfigured(false);
    setStatus('ready');
    setError(null);
    forbiddenRefreshes.current.clear();
  }, []);

  useEffect(() => {
    void refresh();

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') void refresh({ force: true });
    };
    const handleForbidden = (event: Event) => {
      const detail = (event as CustomEvent<GraphForbiddenDetail>).detail;
      const key = detail.classId || detail.path || 'unknown';
      const now = Date.now();
      const lastRefresh = forbiddenRefreshes.current.get(key);
      if (lastRefresh !== undefined && now - lastRefresh < FORBIDDEN_REFRESH_FLOOR_MS) return;
      forbiddenRefreshes.current.set(key, now);
      void refresh({ force: true });
    };
    const handleFocus = () => {
      const currentProfile = profileRef.current;
      const resolvedAt = currentProfile?.resolvedAt ? Date.parse(currentProfile.resolvedAt) : 0;
      if (resolvedAt > 0 && Date.now() - resolvedAt >= PROFILE_TTL_MS) void refresh();
    };

    window.addEventListener('message', handleMessage);
    window.addEventListener(GRAPH_FORBIDDEN_EVENT, handleForbidden);
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener(GRAPH_FORBIDDEN_EVENT, handleForbidden);
      window.removeEventListener('focus', handleFocus);
    };
  }, [refresh]);

  const isClassAllowed = useCallback(
    (classId: string) => isProfileClassAllowed(profile, classId),
    [profile]
  );

  return useMemo(() => ({
    account,
    profile,
    lastKnownRole,
    status,
    error,
    aiReviewConfigured,
    isClassAllowed,
    refresh,
    clear,
  }), [account, profile, lastKnownRole, status, error, aiReviewConfigured, isClassAllowed, refresh, clear]);
};

export const CollaborationAccessProvider: React.FC<{
  value: CollaborationAccessValue;
  children: React.ReactNode;
}> = ({ value, children }) => (
  <CollaborationAccessContext.Provider value={value}>
    {children}
  </CollaborationAccessContext.Provider>
);

export const useCollaborationAccess = (): CollaborationAccessValue => {
  const value = useContext(CollaborationAccessContext);
  if (!value) throw new Error('useCollaborationAccess must be used inside CollaborationAccessProvider');
  return value;
};
