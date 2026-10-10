import { useCallback, useEffect, useState } from 'react';
import type { Firestore } from 'firebase/firestore';
import { ExportFormat, ExportPreset } from '../types';
import { loadUserPreferences, saveUserPreferences } from '../services/firestoreDataService';

export const BUILT_IN_PRESETS: ExportPreset[] = [
  {
    id: 'grading',
    name: 'Grading',
    description: 'Student identity, dates, workflow status, and participation counts. One row per entry. Feedback Ready entries only.',
    fieldGroups: ['identity', 'dates', 'status', 'counts'],
    statusFilter: ['approved'],
    format: ExportFormat.XLSX,
    isBuiltIn: true,
  },
  {
    id: 'feedback-review',
    name: 'Feedback Review',
    description: 'Entry content and individual teacher feedback fields. One row per entry. Feedback Ready entries only.',
    fieldGroups: ['identity', 'dates', 'status', 'counts', 'content', 'feedback'],
    statusFilter: ['approved'],
    format: ExportFormat.XLSX,
    isBuiltIn: true,
  },
  {
    id: 'research',
    name: 'Research',
    description: 'All fields including parser metadata, parse warnings, and raw text. All entry statuses.',
    fieldGroups: ['identity', 'dates', 'status', 'counts', 'content', 'feedback', 'metadata'],
    statusFilter: 'all',
    format: ExportFormat.XLSX,
    isBuiltIn: true,
  },
];

export const useExportPresets = (db: Firestore, uid: string) => {
  const [customPresets, setCustomPresets] = useState<ExportPreset[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadUserPreferences(db, uid)
      .then((prefs) => setCustomPresets(prefs.exportPresets ?? []))
      .catch(() => { /* built-ins still work */ })
      .finally(() => setIsLoading(false));
  }, [db, uid]);

  const allPresets = [...BUILT_IN_PRESETS, ...customPresets];

  const saveCustomPreset = useCallback(
    async (name: string, basePreset: ExportPreset): Promise<ExportPreset> => {
      const newPreset: ExportPreset = {
        ...basePreset,
        id: `custom-${Date.now()}`,
        name,
        isBuiltIn: false,
      };
      const updated = [...customPresets, newPreset];
      await saveUserPreferences(db, uid, { exportPresets: updated });
      setCustomPresets(updated);
      return newPreset;
    },
    [db, uid, customPresets],
  );

  const deleteCustomPreset = useCallback(
    async (id: string): Promise<void> => {
      const updated = customPresets.filter((p) => p.id !== id);
      await saveUserPreferences(db, uid, { exportPresets: updated });
      setCustomPresets(updated);
    },
    [db, uid, customPresets],
  );

  return { allPresets, customPresets, isLoading, saveCustomPreset, deleteCustomPreset };
};
