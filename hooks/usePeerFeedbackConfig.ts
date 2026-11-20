import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Firestore } from 'firebase/firestore';
import type { ContributorAlias, InternProfile } from '../services/contributorAttribution';
import {
  deleteContributorAlias,
  listContributorAliases,
  loadClassPeerSettings,
  loadCohortPeerSettings,
  loadInternProfiles,
  saveClassPeerSettings,
  saveCohortPeerSettings,
  saveContributorAlias,
  saveInternProfiles,
  type ClassPeerSettings,
  type CohortPeerSettings,
} from '../services/peerFeedbackStore';
import { describeFirestoreError } from '../services/firestoreErrors';
import { publishPilotAssignments } from '../services/internScope';

/**
 * Peer & Intern Feedback configuration for the selected classes: confirmed
 * aliases and settings per class, plus the teacher's intern list and shared
 * term split.
 *
 * Writes are pessimistic — state changes only after Firestore accepts the
 * write — because a missing or stale rule rejects writes silently behind an
 * optimistic update (see firestore.rules). Every failure lands in `error`.
 */
interface ConfigSnapshot {
  interns: InternProfile[];
  cohort: CohortPeerSettings;
  aliasesByClass: Record<string, ContributorAlias[]>;
  settingsByClass: Record<string, ClassPeerSettings>;
}

/**
 * Session copy of the configuration, keyed by user and class set. Reopening the
 * Peer tab used to re-read every confirmed name (~150 and growing, twice under
 * React's development double-mount). This configuration is written only through
 * this hook, which keeps the copy current; another tab or device's changes show
 * after a page reload. An in-flight load is shared, so concurrent mounts read once.
 */
const sessionConfig = new Map<string, ConfigSnapshot>();
const inflightConfig = new Map<string, Promise<ConfigSnapshot>>();

const loadConfig = (db: Firestore, uid: string, ids: string[], key: string): Promise<ConfigSnapshot> => {
  const existing = inflightConfig.get(key);
  if (existing) return existing;
  const promise = Promise.all([
    loadInternProfiles(db, uid),
    loadCohortPeerSettings(db, uid),
    Promise.all(ids.map((id) => listContributorAliases(db, uid, id))),
    Promise.all(ids.map((id) => loadClassPeerSettings(db, uid, id))),
  ])
    .then(([interns, cohort, aliasLists, settingsList]) => {
      const snapshot = {
        interns,
        cohort,
        aliasesByClass: Object.fromEntries(ids.map((id, i) => [id, aliasLists[i]])),
        settingsByClass: Object.fromEntries(ids.map((id, i) => [id, settingsList[i]])),
      };
      sessionConfig.set(key, snapshot);
      return snapshot;
    })
    .finally(() => inflightConfig.delete(key));
  inflightConfig.set(key, promise);
  return promise;
};

export const usePeerFeedbackConfig = (
  db: Firestore,
  uid: string,
  classIds: string[],
  options: {
    /**
     * Owner only (claims ms_role 'owner'): mirror the intern list's group
     * assignments to the shared pilot/assignments document interns read.
     */
    publishAssignments?: boolean;
  } = {}
) => {
  const [aliasesByClass, setAliasesByClass] = useState<Record<string, ContributorAlias[]>>({});
  const [settingsByClass, setSettingsByClass] = useState<Record<string, ClassPeerSettings>>({});
  const [interns, setInterns] = useState<InternProfile[]>([]);
  const [cohort, setCohort] = useState<CohortPeerSettings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const classIdsKey = JSON.stringify([...classIds].sort());

  const sessionKey = `${uid}|${classIdsKey}`;
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const ids = JSON.parse(classIdsKey) as string[];
    let cancelled = false;
    const apply = (snapshot: ConfigSnapshot) => {
      setInterns(snapshot.interns);
      setCohort(snapshot.cohort);
      setAliasesByClass(snapshot.aliasesByClass);
      setSettingsByClass(snapshot.settingsByClass);
      setLoaded(true);
    };
    const remembered = sessionConfig.get(sessionKey);
    if (remembered) {
      apply(remembered);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    loadConfig(db, uid, ids, sessionKey)
      .then((snapshot) => {
        if (!cancelled) apply(snapshot);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`Peer feedback settings could not be loaded: ${describeFirestoreError(err)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [db, uid, classIdsKey, sessionKey]);

  // Share group assignments with interns whenever the owner's list loads or
  // changes. Publishing writes only when the shared copy differs.
  const publishAssignments = options.publishAssignments === true;
  useEffect(() => {
    if (!loaded || !publishAssignments) return;
    publishPilotAssignments(db, interns).catch((err: unknown) =>
      setError(`Group assignments could not be shared with interns: ${describeFirestoreError(err)}`)
    );
  }, [db, loaded, publishAssignments, interns]);

  // Keep the session copy in step with every successful write made here.
  useEffect(() => {
    if (loaded) sessionConfig.set(sessionKey, { interns, cohort, aliasesByClass, settingsByClass });
  }, [loaded, sessionKey, interns, cohort, aliasesByClass, settingsByClass]);

  const run = useCallback(async <T,>(action: () => Promise<T>, failure: string): Promise<T | undefined> => {
    setSaving(true);
    setError(null);
    try {
      return await action();
    } catch (err) {
      setError(`${failure}: ${describeFirestoreError(err)}`);
      return undefined;
    } finally {
      setSaving(false);
    }
  }, []);

  const confirmAliases = useCallback(
    (aliases: ContributorAlias[]) =>
      run(async () => {
        const saved = await Promise.all(aliases.map((alias) => saveContributorAlias(db, uid, alias)));
        setAliasesByClass((prev) => {
          const next = { ...prev };
          for (const alias of saved) {
            const others = (next[alias.classId] ?? []).filter(
              (existing) => !(existing.label === alias.label && existing.groupId === alias.groupId)
            );
            next[alias.classId] = [...others, alias];
          }
          return next;
        });
      }, 'The name could not be saved'),
    [db, uid, run]
  );

  const removeAlias = useCallback(
    (alias: ContributorAlias) =>
      run(async () => {
        await deleteContributorAlias(db, uid, alias);
        setAliasesByClass((prev) => ({
          ...prev,
          [alias.classId]: (prev[alias.classId] ?? []).filter(
            (existing) => !(existing.label === alias.label && existing.groupId === alias.groupId)
          ),
        }));
      }, 'The name could not be removed'),
    [db, uid, run]
  );

  const updateClassSettings = useCallback(
    (classId: string, patch: Partial<Omit<ClassPeerSettings, 'classId'>>) =>
      run(async () => {
        const current = settingsByClass[classId] ?? { classId, excludedAuthorKeys: [] };
        const saved = await saveClassPeerSettings(db, uid, { ...current, ...patch, classId });
        setSettingsByClass((prev) => ({ ...prev, [classId]: saved }));
      }, 'Class settings could not be saved'),
    [db, uid, run, settingsByClass]
  );

  const updateCohortSettings = useCallback(
    (next: CohortPeerSettings) =>
      run(async () => {
        setCohort(await saveCohortPeerSettings(db, uid, next));
      }, 'The shared term split could not be saved'),
    [db, uid, run]
  );

  const updateInterns = useCallback(
    (next: InternProfile[]) =>
      run(async () => {
        setInterns(await saveInternProfiles(db, uid, next));
      }, 'The intern list could not be saved'),
    [db, uid, run]
  );

  const aliases = useMemo(() => Object.values(aliasesByClass).flat(), [aliasesByClass]);

  return {
    aliases,
    settingsByClass,
    cohort,
    interns,
    loading,
    saving,
    error,
    dismissError: () => setError(null),
    confirmAliases,
    removeAlias,
    updateClassSettings,
    updateCohortSettings,
    updateInterns,
  };
};
