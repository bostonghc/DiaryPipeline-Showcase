// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { annotateSequenceWarnings, parseLabeledDiaryHTML } from './parserService';
import type { ParsedDiaryEntry } from '../types';

const seqEntry = (date: string, weekNumber: string): ParsedDiaryEntry => ({
  id: `${date}-${weekNumber}`,
  date,
  weather: '',
  weekNumber,
  photoCount: 0,
  diaryText: 'x',
  peerFeedback: [],
  vocabItems: [],
  vocabCount: 0,
  translations: [],
  translationCount: 0,
  chatbotFeedback: { present: false, data: '' },
});

const seqWarnings = (entries: ParsedDiaryEntry[]): boolean[] =>
  annotateSequenceWarnings(entries).map((e) =>
    (e.parseWarnings ?? []).some((w) => /earlier than the previous entry/.test(w))
  );

describe('annotateSequenceWarnings — term-aware date↔week consistency', () => {
  it('does not warn on a clean chronological page', () => {
    const entries = [
      seqEntry('April 13, 2026', '1'),
      seqEntry('April 20, 2026', '2'),
      seqEntry('April 27, 2026', '3'),
    ];
    expect(seqWarnings(entries)).toEqual([false, false, false]);
  });

  it('treats a week-number reset as a new term, not a backwards-date error', () => {
    // Term 2 restarts at week 1 with a later date — expected, no warning.
    const entries = [
      seqEntry('December 3, 2026', '14'),
      seqEntry('January 14, 2027', '1'),
      seqEntry('January 21, 2027', '2'),
    ];
    expect(seqWarnings(entries)).toEqual([false, false, false]);
  });

  it('flags a date that moves backwards within the same term', () => {
    const entries = [
      seqEntry('April 13, 2026', '1'),
      seqEntry('April 27, 2026', '2'),
      seqEntry('April 20, 2026', '3'), // date earlier than week 2 — suspicious
    ];
    expect(seqWarnings(entries)).toEqual([false, false, true]);
  });

  it('uses the page year for year-less dates before comparing', () => {
    // "May 5" must be read as 2026 (not Date.parse's 2001) so it does not look
    // like a backwards jump after the dated April entries.
    const entries = [
      seqEntry('April 15.2026', '1'),
      seqEntry('April 19.2026', '2'),
      seqEntry('May 5', '3'),
    ];
    expect(seqWarnings(entries)).toEqual([false, false, false]);
  });

  it('does not warn when a date is unparseable (advisory only, no false alarm)', () => {
    const entries = [
      seqEntry('April 13, 2026', '1'),
      seqEntry('???', '2'),
      seqEntry('April 27, 2026', '3'),
    ];
    expect(seqWarnings(entries)).toEqual([false, false, false]);
  });
});

// Fixture: real Graph HTML export for a 30-entry labeled-diary-v1 page.
// Used to guard against regressions in the label-first parser's entry-boundary
// detection and multi-entry extraction.
// Source: docs/local-reference/9876543 Geoff Carr.htm (gitignored; sanitized
// copy committed here as the tracked regression fixture).
const FIXTURE_PATH = join(
  __dirname,
  '__fixtures__/9876543-geoff-carr-30-entries.htm'
);

const collapseBySlot = (entries: ParsedDiaryEntry[]): ParsedDiaryEntry[] => {
  const seen = new Map<string, ParsedDiaryEntry>();
  for (const entry of entries) {
    const key = `${(entry.date || '').trim()}|${(entry.weekNumber || '').trim()}`;
    if (!seen.has(key)) seen.set(key, entry);
  }
  return Array.from(seen.values());
};

describe('parseLabeledDiaryHTML — 9876543 Geoff Carr fixture (30-entry page)', () => {
  const html = readFileSync(FIXTURE_PATH, 'utf8');

  it('raw parse returns 30 entries', () => {
    const raw = parseLabeledDiaryHTML(html, 'labeled-diary-v1');
    console.log('raw parsed count:', raw?.length ?? 0);
    expect(raw).not.toBeNull();
    expect(raw!.length).toBe(30);
  });

  it('collapsed count equals raw count (all entries have unique date+week slots)', () => {
    const raw = parseLabeledDiaryHTML(html, 'labeled-diary-v1')!;
    const collapsed = collapseBySlot(raw);
    console.log('collapsed count:', collapsed.length);
    expect(collapsed.length).toBe(raw.length);
  });

  it('every entry has a date and weekNumber', () => {
    const raw = parseLabeledDiaryHTML(html, 'labeled-diary-v1')!;
    const missing = raw.filter((e) => !e.date || !e.weekNumber);
    expect(missing).toHaveLength(0);
  });

  it('every entry has diary text', () => {
    const raw = parseLabeledDiaryHTML(html, 'labeled-diary-v1')!;
    const empty = raw.filter((e) => !e.diaryText || e.diaryText.trim() === '');
    expect(empty).toHaveLength(0);
  });
});

describe('parseFeedbackCell — how students actually label comments', () => {
  it('keeps the original [Name] convention, with comments running across lines', async () => {
    const { parseFeedbackCell } = await import('./parserService');
    expect(parseFeedbackCell('[Hina] Nice photo!\nWhere was it?\n[Kanoko] I like it')).toEqual([
      { contributor: 'Hina', feedback: 'Nice photo!\nWhere was it?' },
      { contributor: 'Kanoko', feedback: 'I like it' },
    ]);
  });

  it('reads {Name} and <Name> labels, keeping replies with their comment', async () => {
    const { parseFeedbackCell } = await import('./parserService');
    expect(parseFeedbackCell("{Rea}\nYou dad's birthday nice!\nWhat playing game?\nBUROSUTA\n<maaya>\nThat's nice")).toEqual([
      { contributor: 'Rea', feedback: "You dad's birthday nice!\nWhat playing game?\nBUROSUTA" },
      { contributor: 'maaya', feedback: "That's nice" },
    ]);
  });

  it('reads a name alone on a line when the cell alternates name and comment', async () => {
    const { parseFeedbackCell } = await import('./parserService');
    expect(parseFeedbackCell('Nanami\nThat’s good! What kind of sweets do you like?\nKokomi\nThat’s nice! Are you enjoying it?')).toEqual([
      { contributor: 'Nanami', feedback: 'That’s good! What kind of sweets do you like?' },
      { contributor: 'Kokomi', feedback: 'That’s nice! Are you enjoying it?' },
    ]);
  });

  it('does not mistake short comments for names when there is no alternating pattern', async () => {
    const { parseFeedbackCell } = await import('./parserService');
    const parsed = parseFeedbackCell("That's nice\nGood job\nI want to go too!");
    expect(parsed.map((p) => p.contributor)).toEqual(['Unspecified 1', 'Unspecified 2', 'Unspecified 3']);
  });

  it('drops labels with no comment, including several names on one line', async () => {
    const { parseFeedbackCell } = await import('./parserService');
    expect(parseFeedbackCell('[Aira Sawaya] [Honoka Shichinohe]\n[Satomi Tsushima]')).toEqual([]);
    expect(parseFeedbackCell('[Aira Sawaya] Great! [Honoka Shichinohe] Me too')).toEqual([
      { contributor: 'Aira Sawaya', feedback: 'Great!' },
      { contributor: 'Honoka Shichinohe', feedback: 'Me too' },
    ]);
  });

  it('reads a whole-line (Name) as a label', async () => {
    const { parseFeedbackCell } = await import('./parserService');
    expect(parseFeedbackCell('(Yuzuna)\nYakiniku is nice!\nWhat did you sing?\n(Honoka)\nThat’s good!')).toEqual([
      { contributor: 'Yuzuna', feedback: 'Yakiniku is nice!\nWhat did you sing?' },
      { contributor: 'Honoka', feedback: 'That’s good!' },
    ]);
  });

  it('reads (Name) at the start of a line, and tortoise-shell brackets', async () => {
    const { parseFeedbackCell } = await import('./parserService');
    expect(parseFeedbackCell('(Hiroto) I think that is tiring.\nWhere are you working?\n(Takumi)Very good.')).toEqual([
      { contributor: 'Hiroto', feedback: 'I think that is tiring.\nWhere are you working?' },
      { contributor: 'Takumi', feedback: 'Very good.' },
    ]);
    expect(parseFeedbackCell('〔Hiyu〕\nWow, very nice!\n〔Yuina〕\nSounds good!').map((f) => f.contributor)).toEqual(['Hiyu', 'Yuina']);
  });

  it('accepts bare names with multi-line comments and a trailing name not yet answered', async () => {
    const { parseFeedbackCell } = await import('./parserService');
    expect(parseFeedbackCell('Shohei\nGlasses shop is nice!\nHow many members?\nTowa\nVery good!!\nYuito')).toEqual([
      { contributor: 'Shohei', feedback: 'Glasses shop is nice!\nHow many members?' },
      { contributor: 'Towa', feedback: 'Very good!!' },
    ]);
  });

  it('does not read lower-case two-word comments as names', async () => {
    const { parseFeedbackCell } = await import('./parserService');
    expect(parseFeedbackCell('Hina\nVery good\nKanoko\nNice').map((f) => f.contributor)).toEqual(['Hina', 'Kanoko']);
  });

  it('leaves brackets inside a comment alone', async () => {
    const { parseFeedbackCell } = await import('./parserService');
    expect(parseFeedbackCell('[Hina] I liked (your) picture <3 and {so} much')).toEqual([
      { contributor: 'Hina', feedback: 'I liked (your) picture <3 and {so} much' },
    ]);
  });

  it('accepts full-width brackets and a colon after the label', async () => {
    const { parseFeedbackCell } = await import('./parserService');
    expect(parseFeedbackCell('【Jun】：Nice!\n｛Kaisei｝ Cool')).toEqual([
      { contributor: 'Jun', feedback: 'Nice!' },
      { contributor: 'Kaisei', feedback: 'Cool' },
    ]);
  });
});
