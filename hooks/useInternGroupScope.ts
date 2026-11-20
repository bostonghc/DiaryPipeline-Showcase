import { useEffect, useState } from 'react';
import type { Firestore } from 'firebase/firestore';
import type { IdentityClaims } from '../services/identityClaims';
import { groupScopeFor, loadPilotAssignments, type GroupScope } from '../services/internScope';

/**
 * The signed-in user's diary-group scope (services/internScope.ts). Only
 * interns are limited; everyone else resolves to 'all' at once. For an intern
 * the scope is read from the owner-published pilot/assignments document once
 * their identity claims are bound (the rules let only bound pilot members read
 * it). `ready` stays false until then, so callers can hold off syncing rather
 * than sync whole classes by mistake.
 */
export const useInternGroupScope = (db: Firestore, claims: Partial<IdentityClaims> | null) => {
  const [scope, setScope] = useState<GroupScope>({ kind: 'all' });
  const [ready, setReady] = useState(false);
  const [missingAssignment, setMissingAssignment] = useState(false);
  const isIntern = claims?.ms_role === 'intern';
  const upn = claims?.ms_upn;

  useEffect(() => {
    if (!isIntern) {
      setScope({ kind: 'all' });
      setMissingAssignment(false);
      setReady(claims !== null);
      return;
    }
    let cancelled = false;
    setReady(false);
    loadPilotAssignments(db)
      .then((published) => {
        if (cancelled) return;
        const next = groupScopeFor('intern', upn, published);
        setScope(next);
        setMissingAssignment(next.kind === 'all');
        setReady(true);
      })
      .catch(() => {
        // Unreadable: keep whole-class scope, as before this feature, and say so.
        if (cancelled) return;
        setScope({ kind: 'all' });
        setMissingAssignment(true);
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [db, isIntern, upn, claims !== null]);

  return { scope, ready, isIntern, missingAssignment };
};
