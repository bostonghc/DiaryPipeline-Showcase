import type { CollaborationAccessProfile } from './collaborationAccess';

export const buildAccountStorageKey = (
  prefix: string,
  localAccountId: string,
  mode: string
): string => `${prefix}:${localAccountId}:${mode}`;

export const getAllowedClassIds = (
  profile: CollaborationAccessProfile | null | undefined
): Set<string> | null => {
  if (!profile?.allowed) return new Set();
  return profile.classScope.kind === 'all'
    ? null
    : new Set(profile.classScope.classIds);
};

export const filterClassIdsForAccess = (
  ids: Iterable<string>,
  profile: CollaborationAccessProfile | null | undefined
): string[] => {
  const allowed = getAllowedClassIds(profile);
  const unique = Array.from(new Set(ids));
  return allowed === null ? unique : unique.filter((id) => allowed.has(id));
};

export const filterClassesForAccess = <T extends { id: string }>(
  classes: T[],
  profile: CollaborationAccessProfile | null | undefined
): T[] => {
  const allowed = getAllowedClassIds(profile);
  return allowed === null ? classes : classes.filter((item) => allowed.has(item.id));
};

export const buildAccessSelectionSignature = (
  localAccountId: string,
  profile: CollaborationAccessProfile,
  mode: string,
  ids: Iterable<string>
): string => {
  const scope = profile.classScope.kind === 'all'
    ? 'all'
    : profile.classScope.classIds.slice().sort().join(',');
  return `${localAccountId}|${profile.resolvedAt}|${scope}|${mode}|${Array.from(ids).sort().join(',')}`;
};
