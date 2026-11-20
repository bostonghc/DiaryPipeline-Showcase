// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ParsedDiaryEntry } from '../types';
import {
  DEFAULT_PROGRESS_RUBRIC,
  buildProgressExport,
  collectLoadedProgressPages,
  countDiaryWords,
  progressCacheKey,
  scoreProgressPage,
} from './progressReportService';
import { extractLabeledDiaryProgressVocabCounts as extractProgressVocabFromHtml } from './parserService';

const entry = (overrides: Partial<ParsedDiaryEntry> = {}): ParsedDiaryEntry => ({
  id: overrides.id || 'entry-1',
  date: 'April 15, 2026',
  weather: 'Sunny',
  weekNumber: '1',
  photoCount: 2,
  diaryText: Array.from({ length: 25 }, (_, i) => `word${i + 1}`).join(' '),
  peerFeedback: [],
  vocabItems: [],
  vocabCount: 0,
  translations: [
    { japanese: '猫', englishDefinition: 'cat', englishExample: '' },
    { japanese: '走る', englishDefinition: '', englishExample: 'I run.' },
    { japanese: '青い', englishDefinition: 'blue', englishExample: '' },
  ],
  translationCount: 3,
  chatbotFeedback: { present: false, data: '' },
  ...overrides,
});

const source = {
  classId: 'class-a',
  className: '2026 English A',
  pageId: 'page-1',
  pageTitle: '1234567 - Test Student',
  studentName: 'Test Student',
  oneNoteLastModified: '2026-05-01T00:00:00Z',
};

describe('progress report scoring', () => {
  it('counts 25 diary words as valid and 24 as incomplete', () => {
    expect(countDiaryWords(Array.from({ length: 25 }, (_, i) => `w${i}`).join(' '))).toBe(25);

    const score = scoreProgressPage(
      source,
      [
        entry({ id: 'valid' }),
        entry({
          id: 'short',
          date: 'April 22, 2026',
          weekNumber: '2',
          diaryText: Array.from({ length: 24 }, (_, i) => `w${i}`).join(' '),
        }),
      ],
      'label-first',
      'labeled-diary-v1',
      'fresh',
    );

    expect(score.entriesFound).toBe(2);
    expect(score.diaryValidEntries).toBe(1);
  });

  it('scores metadata, photos, vocab Japanese, vocab English/example, and AI booster separately', () => {
    const score = scoreProgressPage(
      source,
      [
        entry({
          chatbotFeedback: { present: true, data: 'Try using more transitions.' },
          translations: [
            { japanese: '猫', englishDefinition: 'cat', englishExample: '' },
            { japanese: '走る', englishDefinition: '', englishExample: 'I run.' },
            { japanese: '', englishDefinition: 'blue', englishExample: '' },
          ],
        }),
      ],
      'label-first',
      'labeled-diary-v1',
      'fresh',
    );

    expect(score.metadataComplete).toBe(3);
    expect(score.photosFound).toBe(2);
    expect(score.vocabJapaneseComplete).toBe(2);
    expect(score.vocabEnglishOrExampleComplete).toBe(3);
    expect(score.aiFeedbackBoosterCount).toBe(1);
  });

  it('adds a diagnostic warning when a page parses to zero entries', () => {
    const score = scoreProgressPage(
      source,
      [],
      'label-first',
      'labeled-diary-v1',
      'fresh',
    );
    const result = buildProgressExport([score], DEFAULT_PROGRESS_RUBRIC);

    expect(score.parseWarnings).toEqual(['Parser returned 0 entries from this OneNote page.']);
    expect(result.rows[0].ScanStatus).toBe('needs_review');
    expect(result.rows[0].PagesFailed).toBe(1);
    expect(result.rows[0].ProgressNotes).toContain('Parser returned 0 entries');
    expect(result.rows[0].MissingSummary).toBe('Scan failed or parser found no entries; progress not scored');
  });

  it('aggregates rows per student and caps required components at the 13-entry target', () => {
    const fullPage = scoreProgressPage(
      source,
      Array.from({ length: 15 }, (_, index) => entry({ id: `entry-${index}`, weekNumber: String(index + 1) })),
      'label-first',
      'labeled-diary-v1',
      'fresh',
    );
    const result = buildProgressExport([fullPage], DEFAULT_PROGRESS_RUBRIC);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      EntriesFound: 15,
      EntryTarget: 13,
      EntryPct: 100,
      MetadataComplete: 39,
      MetadataTarget: 39,
      PhotoPct: 100,
      DiaryPct: 100,
      VocabJapanesePct: 100,
      VocabEnglishOrExamplePct: 100,
      MissingSummary: 'Complete for target rubric',
    });
  });

  it('collects currently loaded pages from the notebook tree without discovering unloaded sections', () => {
    const pages = collectLoadedProgressPages(
      [
        {
          id: 'class-a',
          displayName: '2026 English A',
          type: 'sectionGroup',
          children: [
            {
              id: 'collab',
              displayName: 'Collaboration Space',
              type: 'sectionGroup',
              children: [
                {
                  id: 'diary-section',
                  displayName: 'Diary Group',
                  type: 'section',
                  children: [
                    {
                      id: 'page-1',
                      displayName: '? 1234567 - Test Student',
                      type: 'page',
                      lastModified: '2026-05-01T00:00:00Z',
                    },
                    {
                      id: 'untitled',
                      displayName: '? Untitled Page',
                      type: 'page',
                      lastModified: '2026-05-01T00:00:00Z',
                    },
                  ],
                },
                {
                  id: 'unloaded-section',
                  displayName: 'Empty until expanded',
                  type: 'section',
                  children: [],
                },
              ],
            },
          ],
        },
      ],
      new Set(['class-a']),
    );

    expect(pages).toEqual([
      {
        classId: 'class-a',
        className: '2026 English A',
        diaryGroupId: 'diary-section',
        diaryGroupName: 'Diary Group',
        pageId: 'page-1',
        pageTitle: '1234567 - Test Student',
        studentName: 'Test Student',
        studentNumber: '1234567',
        oneNoteLastModified: '2026-05-01T00:00:00Z',
      },
    ]);
  });

  it('uses vocab item text as the fallback English/example count', () => {
    const score = scoreProgressPage(
      source,
      [
        entry({
          vocabItems: [{ wordOrPhrase: 'ecosystem' }, { wordOrPhrase: 'habitat' }, { wordOrPhrase: 'climate' }],
          translations: [
            { japanese: '生態系', englishDefinition: '', englishExample: '' },
            { japanese: '生息地', englishDefinition: '', englishExample: '' },
            { japanese: '気候', englishDefinition: '', englishExample: '' },
          ],
        }),
      ],
      'label-first',
      'labeled-diary-v1',
      'fresh',
    );

    expect(score.vocabJapaneseComplete).toBe(3);
    expect(score.vocabEnglishOrExampleComplete).toBe(3);
  });

  it('extracts labeled template vocab counts independently from raw HTML labels', () => {
    const html = `
      <table>
        <tr><td>[SEMESTER_START]</td></tr>
        <tr><td>[ENTRY START]</td></tr>
        <tr><td>[KEYWORDS_EN]</td><td>[KEYWORDS_JP]</td><td>[ENGLISH_DEFINITIONS]</td></tr>
        <tr>
          <td><p>apple</p><p>banana</p><p>cherry</p></td>
          <td><p>りんご</p><p>バナナ</p></td>
          <td><p>I ate an apple.</p><p>A yellow banana.</p></td>
        </tr>
        <tr><td>[ENTRY END]</td></tr>
      </table>
    `;

    expect(extractProgressVocabFromHtml(html)).toEqual([
      {
        japaneseComplete: 2,
        englishOrExampleComplete: 5,
      },
    ]);
  });

  it('keys the progress cache by OneNote version, parser, template, and rubric', () => {
    const base = progressCacheKey(source, 'label-first', 'labeled-diary-v1');
    const changedPage = progressCacheKey(
      { ...source, oneNoteLastModified: '2026-05-02T00:00:00Z' },
      'label-first',
      'labeled-diary-v1',
    );
    const changedRubric = progressCacheKey(
      source,
      'label-first',
      'labeled-diary-v1',
      { ...DEFAULT_PROGRESS_RUBRIC, diaryMinWords: 20 },
    );

    expect(base.startsWith('progress-report-v4::')).toBe(true);
    expect(changedPage).not.toBe(base);
    expect(changedRubric).not.toBe(base);
  });
});
