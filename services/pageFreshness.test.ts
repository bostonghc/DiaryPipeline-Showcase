import { describe, it, expect } from 'vitest';
import { decidePageQueue, isContentUnchanged, pageContentFingerprint } from './pageFreshness';

const saved = { syncState: 'saved' as const, oneNoteLastModified: '2021-02-06T07:08:49Z' };

describe('decidePageQueue', () => {
  const NOW = Date.parse('2026-10-05T12:00:00Z');
  const readAt = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();

  it('re-reads a label-first page once its last download is outside the window, despite an old OneNote date', () => {
    // The real failure: a template-copied page stays at 2021 while students write in 2026.
    expect(decidePageQueue({ parserMode: 'label-first', forceResync: false, record: { ...saved, lastReadAt: readAt(13) }, oneNoteLastModified: saved.oneNoteLastModified, now: NOW }))
      .toEqual({ queue: true, reason: 'refresh-due' });
    expect(decidePageQueue({ parserMode: 'label-first', forceResync: false, record: saved, oneNoteLastModified: saved.oneNoteLastModified, now: NOW }).reason)
      .toBe('refresh-due');
  });

  it('skips a label-first page read within the window, so repeat syncs stay cheap', () => {
    expect(decidePageQueue({ parserMode: 'label-first', forceResync: false, record: { ...saved, lastReadAt: readAt(2) }, oneNoteLastModified: saved.oneNoteLastModified, now: NOW }))
      .toEqual({ queue: false, reason: 'recently-read' });
  });

  it('reads any page whose OneNote date did move, window or not', () => {
    expect(decidePageQueue({ parserMode: 'label-first', forceResync: false, record: { ...saved, lastReadAt: readAt(1) }, oneNoteLastModified: '2026-10-05T11:00:00Z', now: NOW }).reason)
      .toBe('modified');
  });

  it('re-reads a page last read under an older parser, even inside the window', async () => {
    const { PARSER_REVISION } = await import('./pageFreshness');
    const record = { ...saved, lastReadAt: readAt(1), contentHash: `r${PARSER_REVISION - 1}:label-first:labeled-diary-v1:10:abc` };
    expect(decidePageQueue({ parserMode: 'label-first', forceResync: false, record, oneNoteLastModified: saved.oneNoteLastModified, now: NOW }).reason)
      .toBe('parser-updated');
    const current = { ...record, contentHash: `r${PARSER_REVISION}:label-first:labeled-diary-v1:10:abc` };
    expect(decidePageQueue({ parserMode: 'label-first', forceResync: false, record: current, oneNoteLastModified: saved.oneNoteLastModified, now: NOW }).reason)
      .toBe('recently-read');
  });

  it('keeps the date check alone for AI-parsed classes', () => {
    expect(decidePageQueue({ parserMode: 'ai', forceResync: false, record: saved, oneNoteLastModified: saved.oneNoteLastModified, now: NOW }))
      .toEqual({ queue: false, reason: 'up-to-date' });
  });

  it('always queues forced syncs and pages never saved', () => {
    expect(decidePageQueue({ parserMode: 'label-first', forceResync: true, record: { ...saved, lastReadAt: readAt(0) }, now: NOW }).reason).toBe('forced');
    expect(decidePageQueue({ parserMode: 'ai', forceResync: false, record: null }).reason).toBe('never-saved');
    expect(decidePageQueue({ parserMode: 'ai', forceResync: false, record: { ...saved, syncState: 'error' } }).reason).toBe('never-saved');
  });
});

describe('pageContentFingerprint', () => {
  it('changes with content, parser mode or template, and is stable otherwise', () => {
    const a = pageContentFingerprint('<p>Entry</p>', 'label-first', 'labeled-diary-v1');
    expect(pageContentFingerprint('<p>Entry</p>', 'label-first', 'labeled-diary-v1')).toBe(a);
    expect(pageContentFingerprint('<p>Entry!</p>', 'label-first', 'labeled-diary-v1')).not.toBe(a);
    expect(pageContentFingerprint('<p>Entry</p>', 'ai', 'labeled-diary-v1')).not.toBe(a);
    expect(pageContentFingerprint('<p>Entry</p>', 'label-first', 'legacy-ai')).not.toBe(a);
  });
});

describe('isContentUnchanged', () => {
  const fingerprint = pageContentFingerprint('<p>x</p>', 'label-first', 'labeled-diary-v1');
  const record = { syncState: 'saved' as const, contentHash: fingerprint, entryCount: 5 };

  it('lets saved entries stand only for identical content after a good save', () => {
    expect(isContentUnchanged({ record, fingerprint })).toBe(true);
    expect(isContentUnchanged({ record: { ...record, contentHash: 'other' }, fingerprint })).toBe(false);
    expect(isContentUnchanged({ record: { ...record, contentHash: undefined }, fingerprint })).toBe(false);
    expect(isContentUnchanged({ record: { ...record, syncState: 'error' }, fingerprint })).toBe(false);
    expect(isContentUnchanged({ record: { ...record, entryCount: 0 }, fingerprint })).toBe(false);
  });

  it('never skips a forced re-read', () => {
    expect(isContentUnchanged({ forceReparse: true, record, fingerprint })).toBe(false);
  });
});
