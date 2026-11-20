import { doc, getDoc, setDoc, type Firestore } from 'firebase/firestore';
import type { NotebookNode } from '../types';
import { diaryGroupKey, type InternAssignment, type InternProfile } from './contributorAttribution';
import { recordRead } from './readMeter';

/**
 * Interns cover diary groups, not whole classes. Their Microsoft membership
 * grants a whole class, so the app narrows what they see and sync to their
 * assigned groups (app-side, within the trusted-cohort model; ROADMAP).
 *
 * The owner's intern list lives in the owner's own Firestore area, which
 * interns cannot read. Saving it therefore also publishes the assignments to a
 * shared document, `pilot/assignments`: readable by any bound pilot member,
 * writable only by a token whose claims say owner (firestore.rules).
 */

export interface PublishedIntern {
  upn: string;
  displayName: string;
  assignments: InternAssignment[];
}

export interface PilotAssignments {
  interns: PublishedIntern[];
  updatedAt?: string;
}

const assignmentsDoc = (db: Firestore) => doc(db, 'pilot', 'assignments');

/** The shareable part of the intern list: no diary labels or active dates. */
export const toPublishedInterns = (interns: InternProfile[]): PublishedIntern[] =>
  interns
    .map((intern) => ({
      upn: intern.upn.trim().toLowerCase(),
      displayName: intern.displayName,
      assignments: (intern.assignments ?? []).map((a) => ({ classId: a.classId, groups: [...a.groups] })),
    }))
    .sort((a, b) => a.upn.localeCompare(b.upn));

export const loadPilotAssignments = async (db: Firestore): Promise<PilotAssignments | null> => {
  const snapshot = await getDoc(assignmentsDoc(db));
  recordRead('pilot:assignments', 1);
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  return { interns: Array.isArray(data.interns) ? (data.interns as PublishedIntern[]) : [], updatedAt: data.updatedAt };
};

/** Publish when the shareable part differs from what is published. Returns whether it wrote. */
export const publishPilotAssignments = async (db: Firestore, interns: InternProfile[]): Promise<boolean> => {
  const next = toPublishedInterns(interns);
  const current = await loadPilotAssignments(db);
  if (current && JSON.stringify(current.interns) === JSON.stringify(next)) return false;
  await setDoc(assignmentsDoc(db), { interns: next, updatedAt: new Date().toISOString() });
  return true;
};

/**
 * What a signed-in user may see and sync. Everyone but interns: everything
 * their class access allows. An intern with a published entry: only assigned
 * groups (an empty group list means the whole class; a class with no entry is
 * hidden). An intern with no published entry: their whole classes, as before —
 * the app logs that their assignment is missing rather than showing nothing.
 */
export type GroupScope = { kind: 'all' } | { kind: 'groups'; byClass: Record<string, string[] | 'all'> };

export const groupScopeFor = (
  role: string | undefined,
  upn: string | undefined,
  published: PilotAssignments | null
): GroupScope => {
  if (role !== 'intern' || !upn || !published) return { kind: 'all' };
  const entry = published.interns.find((intern) => intern.upn === upn.trim().toLowerCase());
  if (!entry) return { kind: 'all' };
  const byClass: Record<string, string[] | 'all'> = {};
  for (const assignment of entry.assignments) byClass[assignment.classId] = assignment.groups.length === 0 ? 'all' : assignment.groups;
  return { kind: 'groups', byClass };
};

export const isGroupInScope = (scope: GroupScope, classId: string, groupName: string): boolean => {
  if (scope.kind === 'all') return true;
  const groups = scope.byClass[classId];
  if (!groups) return false;
  return groups === 'all' || groups.some((group) => diaryGroupKey(group) === diaryGroupKey(groupName));
};

/** A class's notebook structure limited to in-scope diary sections. */
export const scopeNotebookStructure = (structure: NotebookNode[], classId: string, scope: GroupScope): NotebookNode[] =>
  scope.kind === 'all'
    ? structure
    : structure.map((sectionGroup) => ({
        ...sectionGroup,
        children: (sectionGroup.children ?? []).filter((section) => isGroupInScope(scope, classId, section.displayName)),
      }));
