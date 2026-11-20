import type { CollaborationAccessProfile, CollaborationRole } from './collaborationAccess';

/**
 * Microsoft identity carried on the Firebase sign-in as custom claims, so
 * Firestore rules can attest who wrote a record and what they may read.
 *
 * The browser has two unlinked sign-ins: Microsoft (role, class scope, who a
 * message is sent from) and Google/Firebase (whose Firestore data it is). The
 * server — which already resolves the authoritative access profile from its
 * own Microsoft session — writes that profile into the Firebase token. See
 * docs/reference/feedback-attribution-plan.md and ARCHITECTURE §46.
 *
 * Claim names are prefixed `ms_`: an unprefixed `name` would overwrite the
 * Google display name that Firebase already puts in the token.
 */

export interface IdentityClaims {
  ms_upn: string;
  ms_name: string;
  ms_role: CollaborationRole;
  /** 'all' for the owner; otherwise the class ids this user may see. */
  ms_classes: 'all' | string[];
  ms_bound_at: string;
}

export const IDENTITY_CLAIM_KEYS: Array<keyof IdentityClaims> = ['ms_upn', 'ms_name', 'ms_role', 'ms_classes', 'ms_bound_at'];

/** Firebase rejects a claims object over 1000 bytes of JSON. */
const MAX_CLAIMS_BYTES = 1000;

export const normalizeUpn = (value: string): string => value.trim().toLowerCase();

/** Claims for an allowed profile, or null when the profile grants no access. */
export const buildIdentityClaims = (profile: CollaborationAccessProfile, now: string): IdentityClaims | null => {
  if (!profile.allowed || !profile.role) return null;
  return {
    ms_upn: normalizeUpn(profile.upn),
    // Display names are self-reported in Microsoft too; cap the length so the
    // claims payload stays well under Firebase's limit.
    ms_name: profile.displayName.trim().slice(0, 100),
    ms_role: profile.role,
    ms_classes: profile.classScope.kind === 'all' ? 'all' : [...profile.classScope.classIds],
    ms_bound_at: now,
  };
};

/**
 * Merge identity claims into whatever claims the user already has.
 * `setCustomUserClaims` replaces the whole object, so other claims (an admin
 * flag, say) must be carried over. Passing null removes only the identity claims.
 */
export const mergeIdentityClaims = (
  existing: Record<string, unknown> | undefined,
  identity: IdentityClaims | null
): Record<string, unknown> => {
  const kept = Object.fromEntries(
    Object.entries(existing ?? {}).filter(([key]) => !(IDENTITY_CLAIM_KEYS as string[]).includes(key))
  );
  const merged = identity ? { ...kept, ...identity } : kept;
  if (JSON.stringify(merged).length > MAX_CLAIMS_BYTES) {
    throw new Error('Identity claims would exceed Firebase’s 1000-byte custom-claims limit.');
  }
  return merged;
};

/**
 * Whether a token's claims still describe the live Microsoft account. Claims
 * are a snapshot on the Google sign-in; after a Microsoft sign-out and a
 * different person signing in on the same browser, stale claims would
 * otherwise attest the wrong author. Callers treat a mismatch as unbound.
 */
export const claimsMatchAccount = (
  claims: Partial<IdentityClaims> | undefined,
  microsoftUsername: string | undefined
): boolean =>
  Boolean(claims?.ms_upn && microsoftUsername && claims.ms_upn === normalizeUpn(microsoftUsername));
