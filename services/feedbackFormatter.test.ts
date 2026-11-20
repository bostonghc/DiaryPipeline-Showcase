import { describe, it, expect } from 'vitest';
import {
  cleanStudentDisplayName,
  compileStructuredFeedback,
  deriveGreetingFirstName,
  renderBatchFeedbackToHTML,
  renderFeedbackToHTML,
  type StructuredFeedback,
} from './feedbackFormatter';
import type { ParsedDiaryEntry, TeacherFeedbackFields } from '../types';

/**
 * Snapshot tests for renderFeedbackToHTML. Captures the current rendered
 * output (field-interleaved blockquote-and-comment) so any
 * unintentional format change surfaces as a test failure.
 *
 * If a test fails *without* an intentional format change, something has
 * regressed. If a test fails *with* an intentional format change,
 * regenerate snapshots with `npm test -- -u` and review the diff as the
 * spec of the change. See TESTING.md and FEEDBACK_ANNOTATION_DESIGN.md.
 */

const baseEntry = (overrides: Partial<ParsedDiaryEntry> = {}): ParsedDiaryEntry => ({
  id: 'entry-1',
  date: 'April 24, 2026',
  weather: 'sunny',
  weekNumber: 'Week 1',
  photoCount: 0,
  diaryText: 'This week I went to the library and studied English. It was a productive week.',
  peerFeedback: [],
  vocabItems: [
    { wordOrPhrase: 'library' },
    { wordOrPhrase: 'productive' },
  ],
  vocabCount: 2,
  sentiment: 'positive',
  topics: ['study'],
  translations: [],
  translationCount: 0,
  chatbotFeedback: { present: false, data: '' },
  ...overrides,
});

const baseStructured = (overrides: Partial<StructuredFeedback> = {}): StructuredFeedback => ({
  greeting: 'Hi Hina,\n\nThank you for your journal entry this week!',
  diaryFeedback: 'Strong topic sentence. Watch tense consistency in paragraph two.',
  includeDiary: true,
  vocabFeedback: 'Good range. "Productive" used well in context.',
  includeVocab: true,
  overallFeedback: 'Steady week — keep building on this momentum.',
  includeOverall: true,
  closing: 'Keep up the great work!\n\nBest,\nMr. Carr',
  reviewNotice: 'This feedback is meant to support, not grade. Focus on one or two items at a time.',
  studentEmail: 'ak1234570@school.edu',
  ...overrides,
});

describe('renderFeedbackToHTML — field-interleaved blockquote-and-comment', () => {
  it('renders the full message with all three sections included', () => {
    const html = renderFeedbackToHTML(baseStructured(), baseEntry());
    expect(html).toMatchSnapshot();
  });

  it('pairs the diary blockquote directly with the diary comment', () => {
    const html = renderFeedbackToHTML(baseStructured(), baseEntry());
    // The diary quote and its paired comment must appear adjacent, with
    // no other section between them. Find both and confirm order + proximity.
    const quoteIdx = html.indexOf('This week I went to the library');
    const commentIdx = html.indexOf('Strong topic sentence');
    expect(quoteIdx).toBeGreaterThan(-1);
    expect(commentIdx).toBeGreaterThan(quoteIdx);
    // Nothing else between them — no "Vocabulary" or "Overall" labels.
    const between = html.slice(quoteIdx, commentIdx);
    expect(between).not.toContain('Vocabulary');
    expect(between).not.toContain('Overall');
  });

  it('renders vocab items as a quoted list above the vocab comment', () => {
    const html = renderFeedbackToHTML(baseStructured(), baseEntry());
    expect(html).toContain('<li');
    expect(html).toContain('library');
    expect(html).toContain('productive');
    // The list appears before the vocab comment text
    const listIdx = html.indexOf('library</li>');
    const commentIdx = html.indexOf('Good range');
    expect(listIdx).toBeGreaterThan(-1);
    expect(commentIdx).toBeGreaterThan(listIdx);
  });

  it('falls back to comment-only when vocab items are empty', () => {
    const html = renderFeedbackToHTML(
      baseStructured(),
      baseEntry({ vocabItems: [], vocabCount: 0 })
    );
    // No <ul> within the vocab section, but the comment still renders.
    expect(html).toContain('Vocabulary');
    expect(html).toContain('Good range');
    // Count <li>: should be zero now (none from vocab; diary section has none)
    expect(html.match(/<li/g)).toBeNull();
  });

  it('omits diary section when includeDiary is false', () => {
    const html = renderFeedbackToHTML(
      baseStructured({ includeDiary: false }),
      baseEntry()
    );
    expect(html).toMatchSnapshot();
    expect(html).not.toContain('Diary Content');
  });

  it('omits vocab section when includeVocab is false', () => {
    const html = renderFeedbackToHTML(
      baseStructured({ includeVocab: false }),
      baseEntry()
    );
    expect(html).toMatchSnapshot();
    expect(html).not.toContain('Vocabulary');
  });

  it('omits overall section when includeOverall is false', () => {
    const html = renderFeedbackToHTML(
      baseStructured({ includeOverall: false }),
      baseEntry()
    );
    expect(html).toMatchSnapshot();
    expect(html).not.toContain('Overall Comments');
  });

  it('omits review notice when empty', () => {
    const html = renderFeedbackToHTML(
      baseStructured({ reviewNotice: '' }),
      baseEntry()
    );
    expect(html).toMatchSnapshot();
    expect(html).not.toContain('#fff7ed');
  });

  it('renders only diary section when other includes are false and notice is empty', () => {
    const html = renderFeedbackToHTML(
      baseStructured({
        includeVocab: false,
        includeOverall: false,
        reviewNotice: '',
      }),
      baseEntry()
    );
    expect(html).toMatchSnapshot();
  });
});

describe('renderFeedbackToHTML — HTML escaping (XSS safety)', () => {
  it('neutralises a <script> payload in teacher feedback', () => {
    const html = renderFeedbackToHTML(
      baseStructured({ diaryFeedback: '<script>alert(1)</script>' }),
      baseEntry()
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('neutralises an <img onerror> payload in overall feedback', () => {
    const html = renderFeedbackToHTML(
      baseStructured({ overallFeedback: '<img src=x onerror="alert(1)">' }),
      baseEntry()
    );
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('escapes student diary text (the blockquote source)', () => {
    const html = renderFeedbackToHTML(
      baseStructured(),
      baseEntry({ diaryText: 'I said <b>hi</b> & left "early".' })
    );
    expect(html).toContain('I said &lt;b&gt;hi&lt;/b&gt; &amp; left &quot;early&quot;.');
    expect(html).not.toContain('<b>hi</b>');
  });

  it('escapes vocab list items', () => {
    const html = renderFeedbackToHTML(
      baseStructured(),
      baseEntry({ vocabItems: [{ wordOrPhrase: '<i>word</i>' }] })
    );
    expect(html).toContain('<li style="margin-bottom: 2px;">&lt;i&gt;word&lt;/i&gt;</li>');
    expect(html).not.toContain('<li style="margin-bottom: 2px;"><i>word</i></li>');
  });

  it('escapes each metacharacter (& < > " \') exactly once, ampersand-first', () => {
    const html = renderFeedbackToHTML(
      baseStructured({ closing: `& < > " '` }),
      baseEntry()
    );
    expect(html).toContain('&amp; &lt; &gt; &quot; &#39;');
    // No double-encoding: a lone & must not become &amp;amp;
    expect(html).not.toContain('&amp;amp;');
  });

  it('leaves Japanese text intact (no over-escaping of non-ASCII)', () => {
    const jp = 'よく書けています。次は時制に注意しましょう。';
    const html = renderFeedbackToHTML(
      baseStructured({ diaryFeedback: jp }),
      baseEntry()
    );
    expect(html).toContain(jp);
  });
});

describe('renderBatchFeedbackToHTML — multi-week feedback', () => {
  it('renders selected feedback entries and excludes internal review decisions', () => {
    const week3 = baseStructured({
      greeting: 'Hi Hina,',
      closing: 'Best,\nTeacher',
      diaryFeedback: 'Week 3 feedback',
      includeDiary: true,
    });
    const week4 = baseStructured({
      greeting: 'Hi Hina,',
      closing: 'Best,\nTeacher',
      diaryFeedback: 'Week 4 feedback',
      includeDiary: true,
    });

    const html = renderBatchFeedbackToHTML(
      [
        {
          label: 'Week 3',
          feedback: week3,
          entry: baseEntry({ diaryText: 'Week 3 diary' }),
        },
        {
          label: 'Week 4',
          feedback: week4,
          entry: baseEntry({ diaryText: 'Week 4 diary' }),
        },
      ],
      'Hi Hina,\n\nHere is feedback for several entries.',
      'Best,\nTeacher'
    );

    expect(html).toContain('Week 3');
    expect(html).toContain('Week 4');
    expect(html).toContain('Week 3 feedback');
    expect(html).toContain('Week 4 feedback');
    expect(html).not.toContain('reviewed_no_feedback');
    expect(html).not.toContain('no feedback needed');
    expect(html).toContain('Feedback packet');
    expect(html).toContain('Please avoid revising entries after feedback has been sent.');
    expect(html).not.toContain('This feedback is meant to support, not grade.');
  });
});

describe('compileStructuredFeedback — field contract (UI-shaped teacherFeedback)', () => {
  it('maps each UI key to the right compiled field (regression: vocab was read as vocabItems)', () => {
    const fb: TeacherFeedbackFields = {
      diaryText: 'diary comment',
      vocab: 'vocab comment',
      peerFeedback: 'peer comment',
      translations: 'translations comment',
      chatbot: 'chatbot comment',
      overall: 'overall comment',
    };
    const sf = compileStructuredFeedback('Hina', baseEntry(), fb);
    expect([sf.diaryFeedback, sf.includeDiary]).toEqual(['diary comment', true]);
    expect([sf.vocabFeedback, sf.includeVocab]).toEqual(['vocab comment', true]);
    expect([sf.peerFeedback, sf.includePeer]).toEqual(['peer comment', true]);
    expect([sf.translationsFeedback, sf.includeTranslations]).toEqual(['translations comment', true]);
    expect([sf.chatbotFeedback, sf.includeChatbot]).toEqual(['chatbot comment', true]);
    expect([sf.overallFeedback, sf.includeOverall]).toEqual(['overall comment', true]);
  });

  it('does NOT read the legacy vocabItems key (the original silent-discard bug)', () => {
    const sf = compileStructuredFeedback('Hina', baseEntry(), { vocabItems: 'wrong key' } as TeacherFeedbackFields);
    expect(sf.includeVocab).toBe(false);
    expect(sf.vocabFeedback).toBe('');
  });

  it('omits fields the teacher left blank', () => {
    const sf = compileStructuredFeedback('Hina', baseEntry(), { diaryText: 'only diary' });
    expect(sf.includeDiary).toBe(true);
    expect(sf.includePeer).toBe(false);
    expect(sf.includeVocab).toBe(false);
    expect(sf.includeTranslations).toBe(false);
    expect(sf.includeChatbot).toBe(false);
  });
});

describe('renderFeedbackToHTML — formatVersion 3 sections', () => {
  it('renders peer, translations, and chatbot sections with escaped source content', () => {
    const entry = baseEntry({
      peerFeedback: [{ contributor: 'Yuki', feedback: 'Nice <b>job</b>' }],
      translations: [{ japanese: '図書館', englishDefinition: 'library', englishExample: 'I go to the library.' }],
      chatbotFeedback: { present: true, data: 'I practiced <greetings>' },
    });
    const sf = compileStructuredFeedback('Hina', entry, {
      peerFeedback: 'Good peer engagement.',
      translations: 'Watch article usage.',
      chatbot: 'Nice use of the bot.',
    });
    const html = renderFeedbackToHTML(sf, entry);

    expect(html).toContain('Peer Feedback');
    expect(html).toContain('Good peer engagement.');
    expect(html).toContain('Yuki');
    expect(html).toContain('Nice &lt;b&gt;job&lt;/b&gt;'); // student source escaped
    expect(html).not.toContain('Nice <b>job</b>');

    expect(html).toContain('Definitions &amp; Examples');
    expect(html).toContain('Watch article usage.');
    expect(html).toContain('図書館');

    expect(html).toContain('Chatbot Exchange');
    expect(html).toContain('Nice use of the bot.');
    expect(html).toContain('I practiced &lt;greetings&gt;');
  });

  it('omits the new sections for a legacy v2-shaped record (only diary feedback)', () => {
    const sf = compileStructuredFeedback('Hina', baseEntry(), { diaryText: 'only diary' });
    const html = renderFeedbackToHTML(sf, baseEntry());
    expect(html).not.toContain('Peer Feedback');
    expect(html).not.toContain('Translations');
    expect(html).not.toContain('Chatbot Exchange');
  });
});

describe('cleanStudentDisplayName', () => {
  it('strips the standard ID-prefixed tenant format', () => {
    expect(cleanStudentDisplayName('1234570 - 山田陽菜')).toBe('山田陽菜');
  });

  it('strips a leading en-dash separator with no ID (the "Hi –," failure mode)', () => {
    expect(cleanStudentDisplayName('– Testing Testing')).toBe('Testing Testing');
  });

  it('strips a leading ASCII hyphen separator', () => {
    expect(cleanStudentDisplayName('- John Doe')).toBe('John Doe');
  });

  it('strips a leading status marker plus ID prefix', () => {
    expect(cleanStudentDisplayName('* 1234567 - Jane Smith')).toBe('Jane Smith');
  });

  it('leaves an already-clean name untouched', () => {
    expect(cleanStudentDisplayName('Riko Sato')).toBe('Riko Sato');
  });

  it('returns empty for punctuation-only or blank input', () => {
    expect(cleanStudentDisplayName('–')).toBe('');
    expect(cleanStudentDisplayName('')).toBe('');
  });
});

describe('deriveGreetingFirstName', () => {
  it('returns the first name token for a clean Latin name', () => {
    expect(deriveGreetingFirstName('- John Doe')).toBe('John');
  });

  it('returns the whole token for a space-less Japanese name', () => {
    expect(deriveGreetingFirstName('1234570 - 山田陽菜')).toBe('山田陽菜');
  });

  it('falls back to "there" when the name is a bare separator', () => {
    expect(deriveGreetingFirstName('– Testing')).toBe('Testing');
    expect(deriveGreetingFirstName('–')).toBe('there');
    expect(deriveGreetingFirstName('')).toBe('there');
  });
});

describe('compileStructuredFeedback — greeting name robustness', () => {
  it('greets by name after stripping a leading separator (no "Hi –,")', () => {
    const sf = compileStructuredFeedback('– Testing Testing', baseEntry(), { diaryText: 'x' });
    expect(sf.greeting).toContain('Testing');
    expect(sf.greeting).not.toContain('–');
  });

  it('falls back to "Hi there," when no usable name is present', () => {
    const sf = compileStructuredFeedback('–', baseEntry(), { diaryText: 'x' });
    expect(sf.greeting).toMatch(/\bthere\b/);
    expect(sf.greeting).not.toContain('–');
  });
});

describe('review notice is derived from the entry it describes', () => {
  it('names the entry that was compiled, not another one', () => {
    // Regression: reviewAndSend resolved the entry with find(e => e.id === id)
    // while every other lookup used entry.id || String(index). With duplicate
    // ids that compiled one entry's drafts against another entry's date, so a
    // Week 6 send carried a Week 7 notice — invisible in the modal, which does
    // not preview the notice.
    const week6 = { id: 'dup', date: 'May 28, 2020', weekNumber: '6' } as any;
    const compiled = compileStructuredFeedback('Geoff', week6, { diaryText: 'well done' } as any);
    expect(compiled.reviewNotice).toContain('May 28, 2020 (Week 6)');
    expect(compiled.reviewNotice).not.toContain('Week 7');
  });

  it('includes a field only when that field has text', () => {
    const entry = { id: 'e1', date: 'May 28, 2020', weekNumber: '6' } as any;
    const withText = compileStructuredFeedback('Geoff', entry, { diaryText: 'nice work' } as any);
    expect(withText.includeDiary).toBe(true);
    const empty = compileStructuredFeedback('Geoff', entry, {} as any);
    expect(empty.includeDiary).toBe(false);
    expect(empty.includeOverall).toBe(false);
  });
});
