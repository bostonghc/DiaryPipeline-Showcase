import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  type Firestore,
} from 'firebase/firestore';
import type { ContributorAlias, ContributorRef, InternAssignment, InternProfile } from './contributorAttribution';
import { normalizeLabel } from './contributorAttribution';
import { recordRead } from './readMeter';

/**
 * Firestore persistence for Peer & Intern Feedback configuration. Three paths,
 * each with an explicit rule in firestore.rules (a path without one fails
 * silently behind optimistic UI, so callers here await every write and
 * surface errors):
 *
 *   users/{uid}/classes/{classId}/contributorAliases/{aliasId}   confirmed label → person
 *   users/{uid}/classes/{classId}/peerFeedbackSettings/class     excluded pages, term date
 *   users/{uid}/peerFeedbackSettings/interns                     cohort intern list
 *   users/{uid}/peerFeedbackSettings/cohort                      shared term split
 *
 * The intern list and the shared term split are per teacher, not per class:
 * interns serve the cohort and classes share an academic calendar. A class's
 * own termBoundary, when set, overrides the shared one.
 * Serializers and hydrators are pure and unit-tested; hydrators drop malformed
 * records rather than letting them reach attribution.
 */

export interface ClassPeerSettings {
  classId: string;
  /** Author keys (see studentKeyFor) to leave out — teacher test pages and the like. */
  excludedAuthorKeys: string[];
  /** ISO date overriding the shared term split for this class; display only. */
  termBoundary?: string;
  /**
   * Students no longer in class: author key → ISO date they left. One plain
   * status, no leave/return tracking; their earlier data stays as it is.
   */
  departures?: Record<string, string>;
  /** Author keys whose "no longer in class?" suggestion the teacher dismissed. */
  dismissedDepartures?: string[];
  updatedAt?: string;
}

const cleanDepartures = (value: unknown): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key, date]) => isNonEmptyString(key) && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))
          .slice(0, MAX_LIST)
      ) as Record<string, string>
    : {};

const MAX_LIST = 200;
const MAX_INTERNS = 50;
const isNonEmptyString = (value: unknown, max = 1000): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

/**
 * Deterministic document ID: one alias per (scope, label), so confirming the
 * same name twice overwrites rather than duplicates. `*` marks class scope.
 */
export const aliasDocId = (alias: Pick<ContributorAlias, 'label' | 'groupId'>): string =>
  encodeURIComponent(`${alias.groupId ?? '*'}|${alias.label}`);

export interface ContributorAliasWire {
  classId: string;
  label: string;
  targetKind: 'student' | 'intern';
  targetKey: string;
  groupId?: string;
  updatedAt: string;
}

export const serializeContributorAlias = (alias: ContributorAlias, now: string): ContributorAliasWire => ({
  classId: alias.classId,
  label: normalizeLabel(alias.label),
  targetKind: alias.target.kind,
  targetKey: alias.target.kind === 'student' ? alias.target.key : alias.target.upn.trim().toLowerCase(),
  ...(alias.groupId ? { groupId: alias.groupId } : {}),
  updatedAt: now,
});

export const hydrateContributorAlias = (data: Partial<ContributorAliasWire>): ContributorAlias | null => {
  if (!isNonEmptyString(data.classId) || !isNonEmptyString(data.label, 200) || !isNonEmptyString(data.targetKey)) {
    return null;
  }
  let target: ContributorRef;
  if (data.targetKind === 'student') target = { kind: 'student', key: data.targetKey };
  else if (data.targetKind === 'intern') target = { kind: 'intern', upn: data.targetKey };
  else return null;
  return {
    classId: data.classId,
    label: data.label,
    target,
    ...(isNonEmptyString(data.groupId) ? { groupId: data.groupId } : {}),
  };
};

const aliasesCollection = (db: Firestore, uid: string, classId: string) =>
  collection(db, 'users', uid, 'classes', classId, 'contributorAliases');

export const listContributorAliases = async (db: Firestore, uid: string, classId: string): Promise<ContributorAlias[]> => {
  const snapshot = await getDocs(aliasesCollection(db, uid, classId));
  recordRead('contributorAliases', snapshot.size);
  return snapshot.docs
    .map((aliasDoc) => hydrateContributorAlias(aliasDoc.data() as Partial<ContributorAliasWire>))
    .filter((alias): alias is ContributorAlias => alias !== null);
};

export const saveContributorAlias = async (db: Firestore, uid: string, alias: ContributorAlias): Promise<ContributorAlias> => {
  const wire = serializeContributorAlias(alias, new Date().toISOString());
  await setDoc(doc(aliasesCollection(db, uid, alias.classId), aliasDocId(wire)), wire);
  return hydrateContributorAlias(wire)!;
};

export const deleteContributorAlias = async (db: Firestore, uid: string, alias: ContributorAlias): Promise<void> => {
  await deleteDoc(doc(aliasesCollection(db, uid, alias.classId), aliasDocId(alias)));
};

// ---------------------------------------------------------------------------
// Class settings
// ---------------------------------------------------------------------------

export const serializeClassPeerSettings = (settings: ClassPeerSettings, now: string) => ({
  classId: settings.classId,
  excludedAuthorKeys: Array.from(new Set(settings.excludedAuthorKeys.filter((key) => isNonEmptyString(key)))).slice(0, MAX_LIST),
  ...(settings.termBoundary ? { termBoundary: settings.termBoundary } : {}),
  departures: cleanDepartures(settings.departures),
  dismissedDepartures: Array.from(new Set((settings.dismissedDepartures ?? []).filter((key) => isNonEmptyString(key)))).slice(0, MAX_LIST),
  updatedAt: now,
});

export const hydrateClassPeerSettings = (classId: string, data: Record<string, unknown> | undefined): ClassPeerSettings => ({
  classId,
  excludedAuthorKeys: Array.isArray(data?.excludedAuthorKeys)
    ? (data!.excludedAuthorKeys as unknown[]).filter((key): key is string => isNonEmptyString(key))
    : [],
  ...(typeof data?.termBoundary === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.termBoundary)
    ? { termBoundary: data.termBoundary }
    : {}),
  departures: cleanDepartures(data?.departures),
  dismissedDepartures: Array.isArray(data?.dismissedDepartures)
    ? (data!.dismissedDepartures as unknown[]).filter((key): key is string => isNonEmptyString(key))
    : [],
  ...(typeof data?.updatedAt === 'string' ? { updatedAt: data.updatedAt } : {}),
});

const classSettingsDoc = (db: Firestore, uid: string, classId: string) =>
  doc(db, 'users', uid, 'classes', classId, 'peerFeedbackSettings', 'class');

export const loadClassPeerSettings = async (db: Firestore, uid: string, classId: string): Promise<ClassPeerSettings> => {
  const snapshot = await getDoc(classSettingsDoc(db, uid, classId));
  recordRead('peerFeedbackSettings:class', 1);
  return hydrateClassPeerSettings(classId, snapshot.exists() ? snapshot.data() : undefined);
};

export const saveClassPeerSettings = async (db: Firestore, uid: string, settings: ClassPeerSettings): Promise<ClassPeerSettings> => {
  const wire = serializeClassPeerSettings(settings, new Date().toISOString());
  await setDoc(classSettingsDoc(db, uid, settings.classId), wire);
  return hydrateClassPeerSettings(settings.classId, wire);
};

// ---------------------------------------------------------------------------
// Interns
// ---------------------------------------------------------------------------

const isIsoDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

const cleanAssignments = (value: unknown): InternAssignment[] =>
  (Array.isArray(value) ? value : [])
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .map((row) => ({
      classId: typeof row.classId === 'string' ? row.classId : '',
      groups: Array.isArray(row.groups)
        ? Array.from(new Set(row.groups.filter((g): g is string => typeof g === 'string' && g.trim().length > 0).map((g) => g.trim())))
        : [],
    }))
    .filter((assignment) => assignment.classId.length > 0)
    .slice(0, 20);

/** Trimmed, lower-cased UPN, labels de-duplicated; drops rows without a name and UPN. */
export const cleanInternProfiles = (interns: InternProfile[]): InternProfile[] =>
  interns
    .map((intern) => {
      const assignments = cleanAssignments(intern.assignments);
      return {
        upn: intern.upn.trim().toLowerCase(),
        displayName: intern.displayName.trim(),
        labels: Array.from(new Set(intern.labels.map((label) => label.trim()).filter(Boolean))).slice(0, 10),
        ...(isIsoDate(intern.activeFrom) ? { activeFrom: intern.activeFrom } : {}),
        ...(isIsoDate(intern.activeUntil) ? { activeUntil: intern.activeUntil } : {}),
        ...(assignments.length > 0 ? { assignments } : {}),
      };
    })
    .filter((intern) => intern.upn.includes('@') && intern.displayName.length > 0)
    .slice(0, MAX_INTERNS);

export const hydrateInternProfiles = (data: Record<string, unknown> | undefined): InternProfile[] => {
  const rows = Array.isArray(data?.interns) ? (data!.interns as unknown[]) : [];
  return cleanInternProfiles(
    rows
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map((row) => ({
        upn: typeof row.upn === 'string' ? row.upn : '',
        displayName: typeof row.displayName === 'string' ? row.displayName : '',
        labels: Array.isArray(row.labels) ? row.labels.filter((label): label is string => typeof label === 'string') : [],
        activeFrom: typeof row.activeFrom === 'string' ? row.activeFrom : undefined,
        activeUntil: typeof row.activeUntil === 'string' ? row.activeUntil : undefined,
        assignments: cleanAssignments(row.assignments),
      }))
  );
};

const internsDoc = (db: Firestore, uid: string) => doc(db, 'users', uid, 'peerFeedbackSettings', 'interns');

export const loadInternProfiles = async (db: Firestore, uid: string): Promise<InternProfile[]> => {
  const snapshot = await getDoc(internsDoc(db, uid));
  recordRead('peerFeedbackSettings:interns', 1);
  return hydrateInternProfiles(snapshot.exists() ? snapshot.data() : undefined);
};

export const saveInternProfiles = async (db: Firestore, uid: string, interns: InternProfile[]): Promise<InternProfile[]> => {
  const cleaned = cleanInternProfiles(interns);
  await setDoc(internsDoc(db, uid), { interns: cleaned, updatedAt: new Date().toISOString() });
  return cleaned;
};

// ---------------------------------------------------------------------------
// Cohort settings (shared term split)
// ---------------------------------------------------------------------------

export interface CohortPeerSettings {
  /** ISO date; the term split for every class without its own. Display only. */
  termBoundary?: string;
}

export const hydrateCohortPeerSettings = (data: Record<string, unknown> | undefined): CohortPeerSettings =>
  isIsoDate(data?.termBoundary) ? { termBoundary: data!.termBoundary as string } : {};

const cohortDoc = (db: Firestore, uid: string) => doc(db, 'users', uid, 'peerFeedbackSettings', 'cohort');

export const loadCohortPeerSettings = async (db: Firestore, uid: string): Promise<CohortPeerSettings> => {
  const snapshot = await getDoc(cohortDoc(db, uid));
  recordRead('peerFeedbackSettings:cohort', 1);
  return hydrateCohortPeerSettings(snapshot.exists() ? snapshot.data() : undefined);
};

export const saveCohortPeerSettings = async (db: Firestore, uid: string, settings: CohortPeerSettings): Promise<CohortPeerSettings> => {
  const wire = { ...(isIsoDate(settings.termBoundary) ? { termBoundary: settings.termBoundary } : {}), updatedAt: new Date().toISOString() };
  await setDoc(cohortDoc(db, uid), wire);
  return hydrateCohortPeerSettings(wire);
};

/** The term split a class uses: its own override, else the shared date. */
export const effectiveTermBoundary = (cohort: CohortPeerSettings, cls?: ClassPeerSettings): string =>
  cls?.termBoundary ?? cohort.termBoundary ?? '';

/**
 * Complete an intern ID to a full address with the cohort's domain. All
 * interns share one university domain, so typing "matt" is enough once any
 * saved intern carries it. The full UPN is always what is stored: Track B
 * matches intern-sent feedback by full address.
 */
export const internEmailDomain = (interns: InternProfile[]): string | null => {
  const counts = new Map<string, number>();
  for (const intern of interns) {
    const domain = intern.upn.split('@')[1];
    if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

export const completeInternUpn = (value: string, domain: string | null): string => {
  const trimmed = value.trim().toLowerCase();
  return trimmed && !trimmed.includes('@') && domain ? `${trimmed}@${domain}` : trimmed;
};
