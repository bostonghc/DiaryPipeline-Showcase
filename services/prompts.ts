import { AnalysisTemplate, JournalEntry } from '../types';

// ── Diary page parsing ────────────────────────────────────────────────────────
//
// Used by geminiService.parseDiaryHTML (and any future provider adapter).
// The response *schema* (Type.ARRAY etc.) is Gemini-specific and lives in
// geminiService.ts; a future adapters layer would translate DIARY_ENTRY_FIELDS
// into each provider's schema format.

// Pass 1 — assumes structured 3×3 table layout (majority of pages).
export const DIARY_PARSE_TABLE_SYSTEM_INSTRUCTION = `You are an expert data extraction assistant. Your job is to parse messy, absolute-positioned HTML from an exported OneNote Class Notebook page and extract the content into a strict JSON structure.
The student filled out 3x3 tables representing diary entries. There may be MULTIPLE diary entries on a single page.
The fields for EACH entry are, from top to bottom, left to right:
1. Date
2. Weather
3. Week# (top)
4. Photos (extract count of [IMAGE] placeholders)
5. Diary text (English only)
6. Comments and feedback (middle) - Extract names of group members and their feedback.
7. Vocab words (words or phrases)
8. Vocabulary Study (bottom-middle) - Extract Japanese translations, English definitions, and English example sentences provided by the student for their chosen vocabulary.
9. Feedback from Diary Feedback support chatbot

Extract the data accurately for ALL diary entries found. If a field is empty, provide empty strings or empty arrays as appropriate. Generate a unique 'id' for each entry based on its date and week.
Capture any content that does not fit the above fields in the rawText field rather than discarding it.`;

// Pass 2 — layout-agnostic semantic extraction for legacy free-flow pages.
// Only triggered when Pass 1 fails the quality threshold on a legacy-ai page.
export const DIARY_PARSE_SEMANTIC_SYSTEM_INSTRUCTION = `You are an expert data extraction assistant. Your job is to extract diary entry content from an exported OneNote student page where the layout may be free-flowing paragraphs rather than a structured table.

The page contains one or more diary entries. Identify entry boundaries using ALL available signals — no single signal is required:
- Date lines in any format, including mixed Japanese punctuation (e.g. "May, 17", "June、7", "2020,May,17") — helpful but students sometimes omit dates
- Content pattern shifts: an English narrative paragraph followed by vocabulary items, then peer comments, signals one complete entry
- Photo or image presence (often accompanies a new entry)
- Multiple blank lines between sections

For each entry, extract these fields by their content characteristics — NOT by position:
- date: a date string in any format; leave empty if genuinely absent
- weather: a weather description if present; often absent in older pages
- weekNumber: a week number if present; often absent in older pages
- photoCount: count of [IMAGE] placeholders within this entry
- diaryText: the main English narrative paragraph(s) the student wrote about their experience
- peerFeedback: comments from group members — typically short sentences with the contributor name in parentheses, e.g. "That's beautiful!(natsumi)" or labeled under a "Comments" heading
- vocabItems: vocabulary words or phrases — typically formatted as "word…Japanese" or in a numbered list
- translations: full vocabulary study items with Japanese translation, English definition, and English example sentence — only if all three components are present for an item
- chatbotFeedback: AI or chatbot feedback if present
- rawText: any content found on the page that cannot be confidently assigned to any field above — capture here rather than discarding

Extract ALL diary entries found. If a field is not present for an entry, return empty string or empty array. Generate a unique id for each entry based on its date or sequence position.`;

export const diaryParseUserPrompt = (cleanedHtml: string): string =>
  `Parse this HTML into the requested JSON format (an array of entries):\n\n${cleanedHtml}`;

// ── Entry analysis (holistic / emotional / academic templates) ────────────────

export const ENTRY_ANALYSIS_SYSTEM_INSTRUCTION = `You are an expert educational consultant and child psychologist.
  Your goal is to help teachers quickly understand the "vibe" and progress of their students
  through a 3x3 reflective grid. Be concise, empathetic, and professional.
  Highlight "Action Items" for the teacher if necessary.
  Do not mention cell numbers in the final output unless critical for context.`;

export const entryAnalysisUserPrompt = (template: AnalysisTemplate, entry: JournalEntry): string => {
  const content = entry.cells.map((c, i) => `Cell ${i + 1}: ${c}`).join('\n');
  switch (template) {
    case 'emotional':
      return `Analyze the emotional wellbeing and sentiment of student ${entry.studentName} based on these 9 journal cells. Look for signs of burnout, excitement, or frustration. Identify if they need a wellness check-in. Content:\n${content}`;
    case 'academic':
      return `Analyze the academic progress and conceptual understanding of student ${entry.studentName} based on these 9 journal cells. Identify specific subjects or tasks they are struggling with or excelling in. Content:\n${content}`;
    case 'holistic':
    default:
      return `Provide a comprehensive summary of ${entry.studentName}'s journal entry (3x3 grid). Balance social-emotional insights with academic achievements and identified blockers. Format with clear sections. Content:\n${content}`;
  }
};

// ── Per-field feedback instruction defaults ───────────────────────────────────
//
// These are the factory defaults shown in Settings. Teachers can override them
// at runtime; the overrides are stored in localStorage and held in React state
// in App.tsx. Only the defaults live here.

export const DEFAULT_FIELD_FEEDBACK_INSTRUCTIONS: Record<string, string> = {
  diaryText: "Identify 2-3 of the most impactful corrections in English grammar, spelling, word choice, or naturalness. Quote the specific text being corrected and show the corrected form directly (e.g., 'change \"I go yesterday\" to \"I went yesterday\"'). Where the student demonstrates a concrete strength, name it specifically with evidence.",
  peerFeedback: "Evaluate whether the peer feedback this student wrote (or received) is specific and constructive vs. superficial. Quote one example. If superficial, suggest one concrete improvement; if strong, name what makes it effective.",
  vocab: "Comment on the student's vocabulary choices for this entry. If any word or phrase shows strong contextual judgment, name it. If a word is used awkwardly or has a more natural alternative, quote it and suggest the improvement directly.",
  translations: "Check the definitions and example sentences for accuracy, nuance, and natural English phrasing. Quote any item that needs correction and provide the corrected version directly. Note one item that demonstrates strong word-choice judgment if present.",
  overall: "Write 2-3 sentences of overall, student-facing feedback for this diary entry. Acknowledge one concrete strength, then offer one forward-looking suggestion the student can act on next time. Keep the tone encouraging and specific — avoid generic praise.",
};
