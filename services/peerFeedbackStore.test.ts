import { describe, it, expect } from 'vitest';
import {
  aliasDocId,
  completeInternUpn,
  effectiveTermBoundary,
  hydrateCohortPeerSettings,
  internEmailDomain,
  cleanInternProfiles,
  hydrateClassPeerSettings,
  hydrateContributorAlias,
  hydrateInternProfiles,
  serializeClassPeerSettings,
  serializeContributorAlias,
} from './peerFeedbackStore';

const NOW = '2026-10-05T00:00:00.000Z';

describe('contributor aliases', () => {
  it('round-trips a group-scoped student alias, normalizing the label', () => {
    const wire = serializeContributorAlias(
      { classId: 'c1', label: 'Hina-san', target: { kind: 'student', key: 'ak1@x.jp' }, groupId: 'g1' },
      NOW
    );
    expect(wire).toEqual({ classId: 'c1', label: 'hina', targetKind: 'student', targetKey: 'ak1@x.jp', groupId: 'g1', updatedAt: NOW });
    expect(hydrateContributorAlias(wire)).toEqual({ classId: 'c1', label: 'hina', target: { kind: 'student', key: 'ak1@x.jp' }, groupId: 'g1' });
  });

  it('lower-cases intern UPNs and omits groupId for class scope', () => {
    const wire = serializeContributorAlias({ classId: 'c1', label: 'Emma', target: { kind: 'intern', upn: ' Emma@X.jp ' } }, NOW);
    expect(wire).not.toHaveProperty('groupId');
    expect(wire.targetKey).toBe('emma@x.jp');
  });

  it('drops malformed records instead of passing them to attribution', () => {
    expect(hydrateContributorAlias({ classId: 'c1', label: 'hina', targetKind: 'teacher' as never, targetKey: 'x' })).toBeNull();
    expect(hydrateContributorAlias({ classId: 'c1', label: '', targetKind: 'student', targetKey: 'x' })).toBeNull();
  });

  it('gives one document per scope and label, safe as a Firestore ID', () => {
    expect(aliasDocId({ label: 'hina' })).toBe(aliasDocId({ label: 'hina' }));
    expect(aliasDocId({ label: 'hina', groupId: 'g1' })).not.toBe(aliasDocId({ label: 'hina' }));
    expect(aliasDocId({ label: 'mei kanno', groupId: '1-abc/def' })).not.toContain('/');
  });
});

describe('class settings', () => {
  it('de-duplicates exclusions and keeps a valid term date', () => {
    const wire = serializeClassPeerSettings({ classId: 'c1', excludedAuthorKeys: ['a', 'a', ''], termBoundary: '2026-10-01' }, NOW);
    expect(wire).toEqual({ classId: 'c1', excludedAuthorKeys: ['a'], termBoundary: '2026-10-01', departures: {}, dismissedDepartures: [], updatedAt: NOW });
  });

  it('hydrates a missing document to empty settings and ignores a bad date', () => {
    expect(hydrateClassPeerSettings('c1', undefined)).toEqual({ classId: 'c1', excludedAuthorKeys: [], departures: {}, dismissedDepartures: [] });
    expect(hydrateClassPeerSettings('c1', { termBoundary: 'next week' })).not.toHaveProperty('termBoundary');
  });
});

describe('intern profiles', () => {
  it('cleans rows and drops ones without a name or a UPN', () => {
    expect(
      cleanInternProfiles([
        { upn: ' Matt@X.jp ', displayName: ' Matthew ', labels: ['Matt', 'Matthew', 'Matt', ' '], activeFrom: '2026-09-01' },
        { upn: 'no-at-sign', displayName: 'Bad', labels: [] },
        { upn: 'x@y.jp', displayName: '', labels: [] },
      ])
    ).toEqual([{ upn: 'matt@x.jp', displayName: 'Matthew', labels: ['Matt', 'Matthew'], activeFrom: '2026-09-01' }]);
  });

  it('hydrates defensively from untrusted document data', () => {
    expect(hydrateInternProfiles(undefined)).toEqual([]);
    expect(hydrateInternProfiles({ interns: [null, 'x', { upn: 'e@x.jp', displayName: 'Emma', labels: ['Emma', 3] }] })).toEqual([
      { upn: 'e@x.jp', displayName: 'Emma', labels: ['Emma'] },
    ]);
  });
});

describe('departures', () => {
  it('keeps valid departure dates and drops malformed ones', () => {
    const settings = hydrateClassPeerSettings('c1', {
      departures: { 'ak1@x.jp': '2026-09-15', 'ak2@x.jp': 'September', '': '2026-09-15' },
      dismissedDepartures: ['ak3@x.jp', 4],
    });
    expect(settings.departures).toEqual({ 'ak1@x.jp': '2026-09-15' });
    expect(settings.dismissedDepartures).toEqual(['ak3@x.jp']);
  });
});

describe('shared term split', () => {
  it('uses a class override, else the shared date, else none', () => {
    expect(effectiveTermBoundary({ termBoundary: '2026-10-01' }, { classId: 'c1', excludedAuthorKeys: [], termBoundary: '2026-09-25' })).toBe('2026-09-25');
    expect(effectiveTermBoundary({ termBoundary: '2026-10-01' }, { classId: 'c1', excludedAuthorKeys: [] })).toBe('2026-10-01');
    expect(effectiveTermBoundary({}, undefined)).toBe('');
  });

  it('hydrates only a valid date', () => {
    expect(hydrateCohortPeerSettings({ termBoundary: '2026-10-01' })).toEqual({ termBoundary: '2026-10-01' });
    expect(hydrateCohortPeerSettings({ termBoundary: 'soon' })).toEqual({});
  });
});

describe('intern email completion', () => {
  it('completes an ID with the most common saved domain and leaves full addresses alone', () => {
    const domain = internEmailDomain([
      { upn: 'a@uni.ac.jp', displayName: 'A', labels: [] },
      { upn: 'b@uni.ac.jp', displayName: 'B', labels: [] },
      { upn: 'c@other.jp', displayName: 'C', labels: [] },
    ]);
    expect(domain).toBe('uni.ac.jp');
    expect(completeInternUpn(' Emma ', domain)).toBe('emma@uni.ac.jp');
    expect(completeInternUpn('emma@else.jp', domain)).toBe('emma@else.jp');
    expect(completeInternUpn('emma', null)).toBe('emma');
  });
});

describe('intern group assignments', () => {
  it('keeps class assignments, de-duplicates groups, and drops malformed rows', () => {
    const [intern] = hydrateInternProfiles({
      interns: [
        {
          upn: 'noelia@x.jp',
          displayName: 'Noelia',
          labels: ['Noelia'],
          assignments: [
            { classId: 'eduA', groups: ['Diary Group 1', 'Diary Group 1', ' ', 'Diary Group 2'] },
            { classId: 'nutri', groups: [] },
            { groups: ['Diary Group 3'] },
            'nonsense',
          ],
        },
      ],
    });
    expect(intern.assignments).toEqual([
      { classId: 'eduA', groups: ['Diary Group 1', 'Diary Group 2'] },
      { classId: 'nutri', groups: [] },
    ]);
  });

  it('omits assignments when there are none', () => {
    expect(cleanInternProfiles([{ upn: 'e@x.jp', displayName: 'E', labels: ['E'] }])[0]).not.toHaveProperty('assignments');
  });
});
