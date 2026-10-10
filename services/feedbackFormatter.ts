import {
  ChatbotFeedback,
  ParsedDiaryEntry,
  PeerFeedback,
  StructuredFeedback,
  TeacherFeedbackFields,
  TranslationItem,
  VocabItem,
} from '../types';

// Re-export so existing consumers that import StructuredFeedback from
// './feedbackFormatter' keep working. The canonical home is now types.ts
// since the type crosses the persistence boundary (see ARCHITECTURE.md §35).
export type { StructuredFeedback };

/**
 * Format version emitted by renderFeedbackToHTML. Stored on every new
 * feedbackHistory record. Bumped when the rendered output structurally
 * changes — currently 3 (adds peer/translations/chatbot sections). Version 2
 * was field-interleaved diary/vocab/overall; version 1 the pre-Slice-6 flat format.
 */
export const FEEDBACK_FORMAT_VERSION = 3;

/**
 * The student-text fields the renderer pairs comments against. Structurally
 * compatible with both ParsedDiaryEntry (live send-time) and
 * FeedbackEntrySnapshot (persisted record). Defined here as a structural
 * type so the renderer is decoupled from those concrete types.
 */
export type RenderableEntryFields = {
  diaryText?: string;
  vocabItems?: VocabItem[];
  peerFeedback?: PeerFeedback[];
  translations?: TranslationItem[];
  chatbotFeedback?: ChatbotFeedback;
};

export interface BatchFeedbackItem {
  label: string;
  feedback: StructuredFeedback;
  entry: RenderableEntryFields;
}

/**
 * Cleans a raw student name (section-group display name or page title) into a
 * presentation-safe display name for greetings and headers. Strips, in order:
 * leading `*`/`?` status markers, an optional student-ID prefix (digits with a
 * trailing separator), and any leading bare separators (hyphen, en/em dash,
 * colon).
 *
 * Display-only. Never use this for identity or email resolution — that path
 * relies on the raw name combined with the page title.
 */
export const cleanStudentDisplayName = (raw: string): string => {
  let s = (raw || '').trim();
  s = s.replace(/^[*?]+\s*/, '');             // status markers
  s = s.replace(/^\d{6,8}\s*[-–—:]\s*/, '');  // student-ID prefix + separator
  s = s.replace(/^[-–—:\s]+/, '');            // leading bare separators
  return s.trim();
};

/**
 * Derives the first-name token used in greetings. Falls back to "there" when the
 * cleaned name is empty or contains no letter/kana/kanji character, so a greeting
 * never renders as "Hi –," or "Hi 1234570,".
 */
export const deriveGreetingFirstName = (raw: string): string => {
  const display = cleanStudentDisplayName(raw);
  const firstToken = display.split(/\s+/)[0] || '';
  return /\p{L}/u.test(firstToken) ? firstToken : 'there';
};

/**
 * Compiles a student's diary entry and the teacher's feedback into a structured format
 * that can be reviewed, toggled, and edited before sending.
 */
export const compileStructuredFeedback = (
  studentName: string,
  entry: ParsedDiaryEntry,
  teacherFeedback: TeacherFeedbackFields | undefined,
  teacherName: string = "Mr. Carr",
  customSignOff: string = "Keep up the great work!\n\nBest,\n[Teacher Name]"
): StructuredFeedback => {
  const fb = teacherFeedback || {};
  
  // First name for greetings. Robust to ID-prefixed ("1234567 - John Doe"),
  // separator-prefixed ("– Testing Testing"), and status-marked names; falls
  // back to "there" when no usable name token is present.
  const firstName = deriveGreetingFirstName(studentName);
  
  // Zero-Cost Personalization: Template Engine for Greetings
  const greetings = [
    `Hi ${firstName},\n\nThank you for your journal entry this week! Here is some feedback to help you improve.`,
    `Hello ${firstName},\n\nI enjoyed reading your entry. Let's look at some ways to refine your writing.`,
  ];

  if (entry.topics && Array.isArray(entry.topics) && entry.topics.length > 0) {
    const mainTopic = entry.topics[0].trim().toLowerCase();
    greetings.push(`Hi ${firstName},\n\nThanks for writing about ${mainTopic} this week! Here is your feedback:`);
    greetings.push(`Hello ${firstName},\n\nI really enjoyed reading your thoughts on ${mainTopic}. Let's review your entry:`);
  } else if (entry.topics && typeof entry.topics === 'string' && (entry.topics as string).trim() !== '') {
    const mainTopic = (entry.topics as string).split(',')[0].trim().toLowerCase();
    greetings.push(`Hi ${firstName},\n\nThanks for writing about ${mainTopic} this week! Here is your feedback:`);
    greetings.push(`Hello ${firstName},\n\nI really enjoyed reading your thoughts on ${mainTopic}. Let's review your entry:`);
  }

  if (entry.sentiment && typeof entry.sentiment === 'string' && entry.sentiment.trim() !== '') {
    const sentiment = entry.sentiment.toLowerCase();
    greetings.push(`Hi ${firstName},\n\nIt sounds like you had a ${sentiment} week. Here is some feedback on your journal:`);
  }

  // Pick a random greeting
  const selectedGreeting = greetings[Math.floor(Math.random() * greetings.length)];
  
  const closing = customSignOff.replace(/\[Teacher Name\]/g, teacherName);

  // Build a readable entry reference. Prefer date with parenthetical week if both
  // exist, since "April 24, 2020 / 1" reads as a fraction or revision marker
  // rather than a date+week designation.
  const hasDate = !!entry.date && String(entry.date).trim() !== '';
  const hasWeek = !!entry.weekNumber && String(entry.weekNumber).trim() !== '';
  let entryReference: string;
  if (hasDate && hasWeek) entryReference = `${entry.date} (Week ${entry.weekNumber})`;
  else if (hasDate) entryReference = String(entry.date);
  else if (hasWeek) entryReference = `Week ${entry.weekNumber}`;
  else entryReference = 'this page';

  const reviewNotice = `Please note: this feedback reflects the diary entry reviewed up to ${entryReference}. Please avoid revising earlier entries after feedback has been issued.\n\nこのフィードバックは ${entryReference} までに確認した内容に基づいています。フィードバック送信後は、以前の記入内容をできるだけ変更しないでください。`;

  return {
    greeting: selectedGreeting,
    diaryFeedback: fb.diaryText || '',
    includeDiary: !!fb.diaryText && fb.diaryText.trim() !== '',
    vocabFeedback: fb.vocab || '',
    includeVocab: !!fb.vocab && fb.vocab.trim() !== '',
    overallFeedback: fb.overall || '',
    includeOverall: !!fb.overall && fb.overall.trim() !== '',
    peerFeedback: fb.peerFeedback || '',
    includePeer: !!fb.peerFeedback && fb.peerFeedback.trim() !== '',
    translationsFeedback: fb.translations || '',
    includeTranslations: !!fb.translations && fb.translations.trim() !== '',
    chatbotFeedback: fb.chatbot || '',
    includeChatbot: !!fb.chatbot && fb.chatbot.trim() !== '',
    closing: closing,
    reviewNotice,
    studentEmail: '' // Will be populated by Graph API lookup
  };
};

/**
 * Escapes HTML metacharacters so free text (student, teacher, AI, vocab,
 * greeting, sign-off) cannot inject markup or script into the rendered
 * email/Teams body. Every field the renderer interpolates is plain text —
 * none is intended to carry markup — so escaping is unconditionally safe.
 * Ampersand must be replaced first to avoid double-encoding the others.
 */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Converts the structured feedback into HTML for Email/Teams (format v3:
 * field-interleaved blockquote-and-comment across diary, peer feedback,
 * vocabulary, translations, and chatbot exchange).
 *
 * For each included field the renderer pairs a blockquote of the student's
 * text with the teacher's comment directly underneath. This places feedback
 * physically adjacent to the text it addresses (Bitchener & Ferris on the
 * spatial proximity of corrective feedback) and removes the prior format's
 * separation between "what was said" and "what we're responding to."
 *
 * Overall Comments is meta-level and rendered without a quote pair.
 */
export const renderFeedbackToHTML = (
  feedback: StructuredFeedback,
  entry: RenderableEntryFields,
  options: { omitChrome?: boolean; omitReviewNotice?: boolean } = {}
): string => {
  const diaryText = (entry.diaryText || '').trim();
  const vocabItems = entry.vocabItems || [];
  const peerItems = entry.peerFeedback || [];
  const translationItems = entry.translations || [];
  const chatbotData = (entry.chatbotFeedback?.data || '').trim();

  let html = options.omitChrome
    ? ''
    : `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 620px; margin: 0 auto; color: #1e293b;">
      <h2 style="color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 16px;">Weekly Journal Feedback</h2>
      <p style="font-size: 15px; line-height: 1.6; white-space: pre-wrap; margin: 0 0 4px 0;">${escapeHtml(feedback.greeting)}</p>
  `;

  // Prior excerpt: green-tinted card shown when teacher chose "include" mode.
  // Placed before the new feedback so the student sees the continuity signal first.
  if (!options.omitChrome && feedback.priorExcerpt && feedback.priorExcerpt.trim() !== '') {
    html += `
      <div style="margin: 16px 0 20px 0; padding: 12px 16px; background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px;">
        <p style="margin: 0 0 6px 0; color: #166534; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;">Continuing from last feedback</p>
        <p style="margin: 0; color: #166534; font-size: 13px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(feedback.priorExcerpt)}</p>
      </div>
    `;
  }

  // Review notice: amber meta-card placed near the top so the reader knows
  // how to interpret the feedback that follows. Visually distinct from the
  // indigo comment blocks below so it reads as meta-information, not content.
  if (
    !options.omitReviewNotice &&
    feedback.reviewNotice &&
    feedback.reviewNotice.trim() !== ''
  ) {
    html += `
      <div style="margin: 20px 0 28px 0; padding: 14px 16px; background-color: #fff7ed; border: 1px solid #fed7aa; border-radius: 10px;">
        <p style="margin: 0; color: #9a3412; font-size: 13px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(feedback.reviewNotice)}</p>
      </div>
    `;
  }

  // Diary: quote the student's text, then the teacher's comment paired below.
  if (feedback.includeDiary && feedback.diaryFeedback && feedback.diaryFeedback.trim() !== '') {
    html += `
      <div style="margin-top: 28px;">
        <h3 style="color: #334155; font-size: 15px; margin: 0 0 10px 0; font-weight: 600;">Diary Content</h3>
    `;
    if (diaryText !== '') {
      html += `
        <blockquote style="margin: 0; padding: 12px 16px; background-color: #f1f5f9; border-radius: 8px; font-style: italic; color: #475569; font-size: 14px; line-height: 1.65;">
          &ldquo;${escapeHtml(diaryText)}&rdquo;
        </blockquote>
      `;
    }
    html += `
        <div style="margin-top: 8px; padding: 12px 14px; background-color: #eef2ff; border-left: 3px solid #4f46e5; border-radius: 4px;">
          <p style="margin: 0 0 4px 0; color: #4338ca; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;">Feedback</p>
          <p style="margin: 0; color: #1e293b; font-size: 14px; line-height: 1.65; white-space: pre-wrap;">${escapeHtml(feedback.diaryFeedback)}</p>
        </div>
      </div>
    `;
  }

  // Peer Feedback: quote the student's peer comments, then the teacher's comment.
  if (feedback.includePeer && feedback.peerFeedback && feedback.peerFeedback.trim() !== '') {
    html += `
      <div style="margin-top: 28px;">
        <h3 style="color: #334155; font-size: 15px; margin: 0 0 10px 0; font-weight: 600;">Peer Feedback</h3>
    `;
    if (peerItems.length > 0) {
      const items = peerItems
        .map((p) => `<li style="margin-bottom: 2px;"><strong>${escapeHtml(p.contributor)}:</strong> ${escapeHtml(p.feedback)}</li>`)
        .join('');
      html += `
        <blockquote style="margin: 0; padding: 10px 16px; background-color: #f1f5f9; border-radius: 8px; color: #475569; font-size: 14px; line-height: 1.6;">
          <ul style="margin: 0; padding-left: 20px;">${items}</ul>
        </blockquote>
      `;
    }
    html += `
        <div style="margin-top: 8px; padding: 12px 14px; background-color: #eef2ff; border-left: 3px solid #4f46e5; border-radius: 4px;">
          <p style="margin: 0 0 4px 0; color: #4338ca; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;">Feedback</p>
          <p style="margin: 0; color: #1e293b; font-size: 14px; line-height: 1.65; white-space: pre-wrap;">${escapeHtml(feedback.peerFeedback)}</p>
        </div>
      </div>
    `;
  }

  // Vocabulary: quote the vocab list when present, then the comment.
  if (feedback.includeVocab && feedback.vocabFeedback && feedback.vocabFeedback.trim() !== '') {
    html += `
      <div style="margin-top: 28px;">
        <h3 style="color: #334155; font-size: 15px; margin: 0 0 10px 0; font-weight: 600;">Vocabulary</h3>
    `;
    if (vocabItems.length > 0) {
      const items = vocabItems
        .map((v) => `<li style="margin-bottom: 2px;">${escapeHtml(v.wordOrPhrase)}</li>`)
        .join('');
      html += `
        <blockquote style="margin: 0; padding: 10px 16px; background-color: #f1f5f9; border-radius: 8px; color: #475569; font-size: 14px; line-height: 1.6;">
          <ul style="margin: 0; padding-left: 20px;">${items}</ul>
        </blockquote>
      `;
    }
    html += `
        <div style="margin-top: 8px; padding: 12px 14px; background-color: #eef2ff; border-left: 3px solid #4f46e5; border-radius: 4px;">
          <p style="margin: 0 0 4px 0; color: #4338ca; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;">Feedback</p>
          <p style="margin: 0; color: #1e293b; font-size: 14px; line-height: 1.65; white-space: pre-wrap;">${escapeHtml(feedback.vocabFeedback)}</p>
        </div>
      </div>
    `;
  }

  // Translations: quote the student's translation list, then the comment.
  if (feedback.includeTranslations && feedback.translationsFeedback && feedback.translationsFeedback.trim() !== '') {
    html += `
      <div style="margin-top: 28px;">
        <h3 style="color: #334155; font-size: 15px; margin: 0 0 10px 0; font-weight: 600;">Definitions &amp; Examples</h3>
    `;
    if (translationItems.length > 0) {
      const items = translationItems
        .map((t) => `<li style="margin-bottom: 2px;"><strong>${escapeHtml(t.japanese)}</strong> &mdash; ${escapeHtml(t.englishDefinition)}</li>`)
        .join('');
      html += `
        <blockquote style="margin: 0; padding: 10px 16px; background-color: #f1f5f9; border-radius: 8px; color: #475569; font-size: 14px; line-height: 1.6;">
          <ul style="margin: 0; padding-left: 20px;">${items}</ul>
        </blockquote>
      `;
    }
    html += `
        <div style="margin-top: 8px; padding: 12px 14px; background-color: #eef2ff; border-left: 3px solid #4f46e5; border-radius: 4px;">
          <p style="margin: 0 0 4px 0; color: #4338ca; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;">Feedback</p>
          <p style="margin: 0; color: #1e293b; font-size: 14px; line-height: 1.65; white-space: pre-wrap;">${escapeHtml(feedback.translationsFeedback)}</p>
        </div>
      </div>
    `;
  }

  // Chatbot: quote the student's chatbot exchange when present, then the comment.
  if (feedback.includeChatbot && feedback.chatbotFeedback && feedback.chatbotFeedback.trim() !== '') {
    html += `
      <div style="margin-top: 28px;">
        <h3 style="color: #334155; font-size: 15px; margin: 0 0 10px 0; font-weight: 600;">Chatbot Exchange</h3>
    `;
    if (chatbotData !== '') {
      html += `
        <blockquote style="margin: 0; padding: 12px 16px; background-color: #f1f5f9; border-radius: 8px; font-style: italic; color: #475569; font-size: 14px; line-height: 1.65;">
          &ldquo;${escapeHtml(chatbotData)}&rdquo;
        </blockquote>
      `;
    }
    html += `
        <div style="margin-top: 8px; padding: 12px 14px; background-color: #eef2ff; border-left: 3px solid #4f46e5; border-radius: 4px;">
          <p style="margin: 0 0 4px 0; color: #4338ca; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;">Feedback</p>
          <p style="margin: 0; color: #1e293b; font-size: 14px; line-height: 1.65; white-space: pre-wrap;">${escapeHtml(feedback.chatbotFeedback)}</p>
        </div>
      </div>
    `;
  }

  // Overall: meta-level — no quote target, just the comment, visually set
  // apart by a thin divider.
  if (feedback.includeOverall && feedback.overallFeedback && feedback.overallFeedback.trim() !== '') {
    html += `
      <div style="margin-top: 32px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
        <h3 style="color: #0f172a; font-size: 15px; margin: 0 0 10px 0; font-weight: 600;">Overall Comments</h3>
        <p style="margin: 0; color: #1e293b; font-size: 14px; line-height: 1.65; white-space: pre-wrap;">${escapeHtml(feedback.overallFeedback)}</p>
      </div>
    `;
  }

  if (!options.omitChrome) {
    html += `
      <p style="margin-top: 32px; font-size: 13px; color: #64748b; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(feedback.closing)}</p>
    </div>
  `;
  }

  return html;
};

export const renderBatchFeedbackToHTML = (
  items: BatchFeedbackItem[],
  greeting: string,
  closing: string,
  priorExcerpt?: string
): string => {
  const renderedItems = items
    .map((item) => {
      const entryHtml = renderFeedbackToHTML(
        {
          ...item.feedback,
          priorExcerpt: undefined,
        },
        item.entry,
        { omitChrome: true, omitReviewNotice: true }
      );
      return `
        <section style="margin-top: 28px; padding-top: 20px; border-top: 1px solid #cbd5e1;">
          <h3 style="color: #0f172a; font-size: 17px; margin: 0 0 14px 0; font-weight: 700;">${escapeHtml(item.label)}</h3>
          ${entryHtml}
        </section>
      `;
    })
    .join('');

  let html = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 680px; margin: 0 auto; color: #1e293b;">
      <h2 style="color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 16px;">Journal Feedback</h2>
      <p style="font-size: 15px; line-height: 1.6; white-space: pre-wrap; margin: 0 0 4px 0;">${escapeHtml(greeting)}</p>
  `;

  if (priorExcerpt && priorExcerpt.trim() !== '') {
    html += `
      <div style="margin: 16px 0 20px 0; padding: 12px 16px; background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px;">
        <p style="margin: 0 0 6px 0; color: #166534; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;">Continuing from last feedback</p>
        <p style="margin: 0; color: #166534; font-size: 13px; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(priorExcerpt)}</p>
      </div>
    `;
  }

  if (items.length > 1) {
    const entryList = items.map((item) => item.label).join(', ');
    html += `
      <div style="margin: 16px 0 20px 0; padding: 12px 16px; background-color: #f8fafc; border: 1px solid #cbd5e1; border-radius: 10px;">
        <p style="margin: 0 0 6px 0; color: #334155; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;">Feedback packet</p>
        <p style="margin: 0; color: #334155; font-size: 13px; line-height: 1.6;">This message includes feedback for ${escapeHtml(entryList)}. Please avoid revising entries after feedback has been sent.</p>
        <p style="margin: 6px 0 0 0; color: #475569; font-size: 13px; line-height: 1.6;">このメッセージには ${escapeHtml(entryList)} のフィードバックが含まれています。フィードバック送信後は、記入内容をできるだけ変更しないでください。</p>
      </div>
    `;
  }

  html += renderedItems;

  html += `
      <p style="margin-top: 32px; font-size: 13px; color: #64748b; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(closing)}</p>
    </div>
  `;

  return html;
};
