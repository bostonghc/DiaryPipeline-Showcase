import { describe, expect, it } from 'vitest';
import { sanitizeSyncJobItemWire } from './syncJobService';
import type { SyncJobItem } from '../types';

const item = (overrides: Partial<SyncJobItem> = {}): SyncJobItem => ({
  itemId: 'item-1',
  jobId: 'job-1',
  classId: 'class-1',
  pageId: 'page-1',
  pageTitle: 'April 25',
  studentName: 'Student A',
  diaryGroupId: 'group-1',
  diaryGroupName: 'Diary Group 1',
  parserMode: 'label-first',
  templateVersion: 'labeled-diary-v1',
  status: 'queued',
  createdAt: '2026-06-06T00:00:00.000Z',
  updatedAt: '2026-06-06T00:00:00.000Z',
  ...overrides,
});

describe('sanitizeSyncJobItemWire', () => {
  it('omits undefined optional identity fields before Firestore writes', () => {
    const wire = sanitizeSyncJobItemWire(
      item({ studentGraphId: undefined, studentUpn: undefined })
    );

    expect('studentGraphId' in wire).toBe(false);
    expect('studentUpn' in wire).toBe(false);
  });

  it('keeps present optional identity fields', () => {
    const wire = sanitizeSyncJobItemWire(
      item({ studentGraphId: 'graph-1', studentUpn: 'student@example.edu' })
    );

    expect(wire.studentGraphId).toBe('graph-1');
    expect(wire.studentUpn).toBe('student@example.edu');
  });
});
