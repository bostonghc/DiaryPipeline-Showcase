import type { PageSyncRecord, ParserMode, TemplateVersion } from '../types';

/**
 * Whether a OneNote page needs reading again, and whether its content changed.
 *
 * OneNote's page `lastModifiedDateTime` cannot be trusted for diary pages: on
 * pages copied from an older template it stays at the template's date (2021)
 * while students write in them all year. Sync used it to skip "unchanged"
 * pages, so most 2026 diary work went uncaptured until a Force re-sync.
 *
 * Rules:
 * - Label-first pages are re-read when the last download is older than
 *   REFRESH_WINDOW_MS (or OneNote's date did move). Not on every sync: OneNote
 *   allows 400 requests/hour per user (ARCHITECTURE §45), and one full read of
 *   four classes is ~160 requests. A second sync inside the window is nearly free.
 * - A fingerprint of the downloaded content is stored on the page record. When
 *   it matches the last saved read, nothing is re-parsed or re-written, so an
 *   unchanged page costs one download and one small write, not one write per entry.
 * - AI-parsed classes keep the date check, because a re-read there costs AI
 *   calls. Its blind spot (template-copied pages) is documented, not solved.
 * - Force re-sync bypasses both checks.
 */

/**
 * Bump when label-first parser output changes for the same HTML, so stored
 * fingerprints stop matching and every page is re-parsed once, at the next
 * sync (a page read under an older revision is queued regardless of the window).
 *
 * 2 — peer-feedback cells: {Name}, <Name>, (Name), 〔Name〕 and bare-name lines
 *     read as labels; empty and name-only comments dropped (2026-10-06).
 */
export const PARSER_REVISION = 2;

const readUnderOlderParser = (contentHash?: string): boolean =>
  Boolean(contentHash) && !contentHash!.startsWith(`r${PARSER_REVISION}:`);

/**
 * How long a label-first page's last download stays good enough. New diary
 * entries can take up to this long to appear; Force re-sync bypasses it.
 */
export const REFRESH_WINDOW_MS = 12 * 60 * 60 * 1000;

/** 53-bit string hash (cyrb53). Fast, synchronous, and plenty for change detection. */
const cyrb53 = (value: string, seed = 0): string => {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
};

/** Fingerprint of page content as a given parser would read it. */
export const pageContentFingerprint = (
  html: string,
  parserMode: ParserMode,
  templateVersion: TemplateVersion
): string => `r${PARSER_REVISION}:${parserMode}:${templateVersion}:${html.length}:${cyrb53(html)}`;

const parseTime = (value?: string): number | null => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

export type QueueDecision =
  | { queue: true; reason: 'forced' | 'never-saved' | 'refresh-due' | 'modified' | 'parser-updated' }
  | { queue: false; reason: 'up-to-date' | 'recently-read' };

/** Discovery: should this page be queued for download? */
export const decidePageQueue = ({
  parserMode,
  forceResync,
  record,
  oneNoteLastModified,
  now = Date.now(),
}: {
  parserMode: ParserMode;
  forceResync: boolean;
  record?: Pick<PageSyncRecord, 'syncState' | 'oneNoteLastModified' | 'lastReadAt' | 'contentHash'> | null;
  oneNoteLastModified?: string;
  now?: number;
}): QueueDecision => {
  if (forceResync) return { queue: true, reason: 'forced' };
  if (!record || record.syncState !== 'saved') return { queue: true, reason: 'never-saved' };
  const oneNote = parseTime(oneNoteLastModified);
  const saved = parseTime(record.oneNoteLastModified) ?? 0;
  const dateMoved = oneNote === null || saved === 0 || oneNote > saved;
  if (dateMoved) return { queue: true, reason: 'modified' };
  if (parserMode !== 'label-first') return { queue: false, reason: 'up-to-date' };
  if (readUnderOlderParser(record.contentHash)) return { queue: true, reason: 'parser-updated' };
  // The date can't be trusted for label-first pages; read them on a schedule.
  const lastRead = parseTime(record.lastReadAt);
  if (lastRead !== null && now - lastRead < REFRESH_WINDOW_MS) return { queue: false, reason: 'recently-read' };
  return { queue: true, reason: 'refresh-due' };
};

/**
 * After download: can the saved entries stand? Only when the last read saved
 * successfully, produced entries, and saw exactly this content.
 */
export const isContentUnchanged = ({
  forceReparse,
  record,
  fingerprint,
}: {
  forceReparse?: boolean;
  record?: Pick<PageSyncRecord, 'syncState' | 'contentHash' | 'entryCount'> | null;
  fingerprint: string;
}): boolean =>
  !forceReparse &&
  record?.syncState === 'saved' &&
  (record.entryCount ?? 0) > 0 &&
  record.contentHash === fingerprint;
