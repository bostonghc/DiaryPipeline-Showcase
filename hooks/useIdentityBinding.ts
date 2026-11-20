import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import type { CollaborationAccessProfile } from '../services/collaborationAccess';
import { buildIdentityClaims, claimsMatchAccount, type IdentityClaims } from '../services/identityClaims';

/**
 * Keeps the Firebase sign-in carrying the live Microsoft identity as custom
 * claims (server: POST/DELETE /api/auth/firebase-binding).
 *
 * - Binds once both sign-ins exist and the access profile allows the user, and
 *   rebinds when the profile's role or class scope changes.
 * - Claims count as valid only while they name the live Microsoft account
 *   (`claimsMatchAccount`): a Google sign-in left over from someone else's
 *   session must never attest the wrong author.
 * - `unbind()` runs before Microsoft sign-out and clears the claims.
 *
 * Status 'bound' is what later steps gate on (sending feedback, the review
 * screen); until Firestore rules require the claims, a failure here is shown
 * but does not block anything.
 */

export type IdentityBindingStatus = 'idle' | 'binding' | 'bound' | 'error';

const sameScope = (claims: Partial<IdentityClaims>, expected: IdentityClaims): boolean =>
  claims.ms_role === expected.ms_role &&
  claims.ms_name === expected.ms_name &&
  JSON.stringify(claims.ms_classes) === JSON.stringify(expected.ms_classes);

export const useIdentityBinding = (
  firebaseUser: User | null,
  microsoftUsername: string | undefined,
  profile: CollaborationAccessProfile | null
) => {
  const [status, setStatus] = useState<IdentityBindingStatus>('idle');
  const [claims, setClaims] = useState<Partial<IdentityClaims> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);

  const expected = profile ? buildIdentityClaims(profile, '') : null;
  const expectedKey = expected ? JSON.stringify({ ...expected, ms_bound_at: undefined }) : '';

  const bind = useCallback(async (force: boolean) => {
    const run = ++attempt.current;
    const current = () => run === attempt.current;
    if (!firebaseUser || !microsoftUsername || !expected) {
      setStatus('idle');
      setClaims(null);
      if (force) throw new Error('Sign in with Microsoft and Google before linking your accounts.');
      return;
    }
    try {
      // Already bound to this person with this scope? Then nothing to write.
      const cached = force ? null : (await firebaseUser.getIdTokenResult()).claims as Partial<IdentityClaims>;
      if (cached && claimsMatchAccount(cached, microsoftUsername) && sameScope(cached, expected)) {
        if (current()) {
          setClaims(cached);
          setStatus('bound');
          setError(null);
        }
        return;
      }
      if (!current()) throw new Error('Your sign-in changed while linking your accounts.');
      setStatus('binding');
      const idToken = await firebaseUser.getIdToken(force);
      if (!current()) throw new Error('Your sign-in changed while linking your accounts.');
      const response = await fetch('/api/auth/firebase-binding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      if (!response.ok) throw new Error(`binding failed (${response.status})`);
      // A new claim is absent from the cached token until it is refreshed.
      const refreshed = (await firebaseUser.getIdTokenResult(true)).claims as Partial<IdentityClaims>;
      if (!claimsMatchAccount(refreshed, microsoftUsername)) throw new Error('claims did not match the Microsoft account');
      if (!current()) throw new Error('Your sign-in changed while linking your accounts.');
      setClaims(refreshed);
      setStatus('bound');
      setError(null);
    } catch (err) {
      if (current()) {
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
    // expectedKey stands in for `expected`: it captures role, name and class scope.
  }, [firebaseUser, microsoftUsername, expectedKey]);

  useEffect(() => {
    void bind(false).catch(() => { /* error state is published by bind */ });
    return () => { attempt.current += 1; };
  }, [bind]);

  /** A manual retry validates the binding with the server, even if cached claims look current. */
  const retry = useCallback(() => bind(true), [bind]);

  /** Clear the identity claims, e.g. before Microsoft sign-out. Never throws. */
  const unbind = useCallback(async () => {
    attempt.current += 1;
    setStatus('idle');
    setClaims(null);
    if (!firebaseUser) return;
    try {
      await fetch('/api/auth/firebase-binding', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: await firebaseUser.getIdToken() }),
      });
      await firebaseUser.getIdToken(true);
    } catch {
      // Sign-out proceeds regardless; claims that no longer match the
      // Microsoft account are already treated as unbound.
    }
  }, [firebaseUser]);

  return { status, claims, error, unbind, retry };
};
