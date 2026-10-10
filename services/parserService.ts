import { ParsedDiaryEntry, ParsedPageContent, PeerFeedback, TemplateVersion, TranslationItem } from '../types';
import { dominantYear, parseEntryDate, parseEntryWeek } from './diaryChronology';

type LabelField =
  | 'date'
  | 'weather'
  | 'weekNumber'
  | 'photoCount'
  | 'diaryText'
  | 'peerFeedback'
  | 'vocabItems'
  | 'translations'
  | 'chatbotFeedback';

type CellData = {
  text: string;
  imageCount: number;
};

type TableRow = CellData[];

const LABEL_PATTERNS: Record<LabelField, RegExp[]> = {
  date: [/^date\b/i],
  weather: [/^weather\b/i],
  weekNumber: [/^week(?:\s*(?:#|number))?\b/i],
  photoCount: [/^photos?\b/i, /^pictures?\b/i],
  diaryText: [/^diary(?:\s*text)?\b/i, /^journal(?:\s*text)?\b/i],
  peerFeedback: [/^(?:comments?\s+and\s+feedback|peer\s+feedback|human\s+feedback)\b/i],
  vocabItems: [/^(?:vocab(?:ulary)?(?:\s+words?)?|key\s+words?)\b/i],
  translations: [/^(?:vocabulary\s+study|translations?|translation\s+study)\b/i],
  chatbotFeedback: [/^(?:chatbot\s+feedback|diary\s+feedback\s+support\s+chatbot)\b/i],
};

const EMPTY_CHATBOT = { present: false, data: '' };

const normalizeText = (value: string): string =>
  value
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const normalizeInlineText = (value: string): string => normalizeText(value).replace(/\s+/g, ' ');

const normalizeLabelToken = (value: string): string => normalizeInlineText(normalizeBracketStyle(value)).toUpperCase();

const normalizeBracketStyle = (value: string): string =>
  value.replace(/［/g, '[').replace(/］/g, ']').replace(/【/g, '[').replace(/】/g, ']');

const LABELED_DIARY_V1_FIELDS: Record<string, LabelField> = {
  '[DATE]': 'date',
  '[WEATHER]': 'weather',
  '[WEEK]': 'weekNumber',
  '[PHOTO]': 'photoCount',
  '[DIARY]': 'diaryText',
  '[HUMAN FEEDBACK]': 'peerFeedback',
  '[KEYWORDS_EN]': 'vocabItems',
  '[KEYWORDS_EN_JP]': 'vocabItems',
  '[KEYWORDS_JP]': 'translations',
  '[ENGLISH_DEFINITIONS]': 'translations',
  '[AI_FEEDBACK]': 'chatbotFeedback',
};

const LABELED_DIARY_V1_REQUIRED_FIELDS = new Set<LabelField>(Object.values(LABELED_DIARY_V1_FIELDS));

const stripLabel = (value: string, patterns: RegExp[]): string => {
  let stripped = value;
  patterns.forEach((pattern) => {
    stripped = stripped.replace(pattern, '').replace(/^[:：\-\s]+/, '');
  });
  return normalizeText(stripped);
};

const createEmptyEntry = (): ParsedDiaryEntry => ({
  id: '',
  date: '',
  weather: '',
  weekNumber: '',
  photoCount: 0,
  diaryText: '',
  peerFeedback: [],
  vocabItems: [],
  vocabCount: 0,
  translations: [],
  translationCount: 0,
  chatbotFeedback: EMPTY_CHATBOT,
});

const extractDate = (value: string): string => {
  const normalized = normalizeText(value);
  const match = normalized.match(
    /\b(?:\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{2,4})?)\b/i
  );
  return match ? match[0] : normalized.split('\n')[0] || '';
};

const countPhotos = (value: string, imageCount = 0): number => {
  const normalized = normalizeText(value);
  const explicit = normalized.match(/\b(\d+)\b/);
  const placeholders = (normalized.match(/\[(?:IMAGE|PHOTO)\]/gi) || []).length;
  return Math.max(explicit ? Number(explicit[1]) : 0, placeholders, imageCount);
};

const parseBracketedFeedback = (value: string): PeerFeedback[] => {
  const normalized = normalizeText(normalizeBracketStyle(value));
  if (!normalized) return [];

  const matches = Array.from(
    normalized.matchAll(/(?:^|\n+)\s*\[([^\]\n]+)\]\s*[:：\-]?\s*([\s\S]*?)(?=(?:\n+\s*\[[^\]\n]+\]\s*[:：\-]?)|$)/g)
  );
  if (matches.length > 0) {
    let unresolvedCount = 0;
    return matches
      .map((match) => {
        const contributor = normalizeInlineText(match[1]).replace(/^[\s:：\-–—]+|[\s:：\-–—]+$/g, '');
        if (contributor) {
          return {
            contributor,
            feedback: normalizeText(match[2]),
          };
        }
        unresolvedCount += 1;
        return {
          contributor: `Unspecified ${unresolvedCount}`,
          feedback: normalizeText(match[2]),
        };
      })
      .filter((item) => item.contributor || item.feedback);
  }

  return normalized
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .map((line, index) => ({ contributor: `Unspecified ${index + 1}`, feedback: line }));
};

const parseVocabularyItems = (value: string): { wordOrPhrase: string }[] => {
  const normalized = normalizeText(value);
  if (!normalized) return [];

  return normalized
    .split(/\n|•|,|;/)
    .map((item) => normalizeText(item.replace(/^[-*]\s*/, '')))
    .filter(Boolean)
    .map((wordOrPhrase) => ({ wordOrPhrase }));
};

const parseTranslations = (value: string): TranslationItem[] => {
  const normalized = normalizeText(value);
  if (!normalized) return [];

  const lines = normalized.split(/\n+/).map((line) => normalizeText(line)).filter(Boolean);
  return lines.map((line) => {
    const parts = line.split(/\s+\|\s+|→|=>|::/).map((part) => normalizeText(part)).filter(Boolean);
    if (parts.length >= 3) {
      return {
        japanese: parts[0],
        englishDefinition: parts[1],
        englishExample: parts.slice(2).join(' | '),
      };
    }
    if (parts.length === 2) {
      return {
        japanese: parts[0],
        englishDefinition: parts[1],
        englishExample: '',
      };
    }
    return {
      japanese: line,
      englishDefinition: '',
      englishExample: '',
    };
  });
};

const parseChatbotFeedback = (value: string) => {
  const normalized = normalizeText(value);
  return normalized ? { present: true, data: normalized } : EMPTY_CHATBOT;
};

const parseWeekNumber = (value: string): string => {
  const normalized = normalizeText(value);
  const match = normalized.match(/\b\d+\b/);
  return match ? match[0] : normalized;
};

const extractCellText = (htmlContent: string): string[] => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, 'text/html');
  return Array.from(doc.querySelectorAll('td, th'))
    .map((cell) => normalizeText((cell.textContent as string) || ''))
    .filter(Boolean);
};

const extractTextBlocks = (htmlContent: string): string[] => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, 'text/html');

  const blocks = Array.from(doc.querySelectorAll('td, th, p, div, li'))
    .map((node) => normalizeText((node.textContent as string) || ''))
    .filter(Boolean);

  return Array.from(new Set(blocks));
};

const extractTableRows = (htmlContent: string): TableRow[][] => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, 'text/html');

  return Array.from(doc.querySelectorAll('table')).map((table) =>
    Array.from(table.querySelectorAll('tr')).map((row) =>
      Array.from(row.querySelectorAll('td, th')).map((cell) => ({
        text: normalizeText((cell.textContent as string) || ''),
        imageCount: cell.querySelectorAll('img').length,
      }))
    )
  );
};

const mapCellsToEntry = (cells: string[]): ParsedDiaryEntry | null => {
  if (cells.length < 9) return null;

  const entry = createEmptyEntry();
  entry.date = extractDate(cells[0]);
  entry.weather = cells[1];
  entry.weekNumber = parseWeekNumber(cells[2]);
  entry.photoCount = countPhotos(cells[3]);
  entry.diaryText = normalizeText(cells[4]);
  entry.peerFeedback = parseBracketedFeedback(cells[5]);
  entry.vocabItems = parseVocabularyItems(cells[6]);
  entry.vocabCount = entry.vocabItems.length;
  entry.translations = parseTranslations(cells[7]);
  entry.translationCount = entry.translations.length;
  entry.chatbotFeedback = parseChatbotFeedback(cells[8]);

  return isMeaningfulEntry(entry) ? entry : null;
};

const isMeaningfulEntry = (entry: ParsedDiaryEntry): boolean =>
  Boolean(
    entry.date ||
      entry.weekNumber ||
      entry.diaryText ||
      entry.peerFeedback.length ||
      entry.vocabItems.length ||
      entry.translations.length ||
      entry.chatbotFeedback.present
  );

const rowText = (row: TableRow): string =>
  normalizeInlineText(
    row
      .map((cell) => cell.text)
      .filter(Boolean)
      .join(' ')
  );

const isEntryStartRow = (row: TableRow): boolean => /\[ENTRY START\]/i.test(rowText(row));

const isEntryEndRow = (row: TableRow): boolean => /\[ENTRY END\]/i.test(rowText(row));

const isSemesterStartRow = (row: TableRow): boolean => /\[SEMESTER_START\]/i.test(rowText(row));

const extractEntryIdFromRow = (row: TableRow): string => {
  const match = rowText(row).match(/\[ENTRY_ID\]\s*([A-Za-z0-9_-]+)/i);
  return match ? match[1] : '';
};

const assignLabeledValue = (entry: ParsedDiaryEntry, field: LabelField, value: string) => {
  const normalized = normalizeText(value);
  if (!normalized && field !== 'photoCount') return;

  switch (field) {
    case 'date':
      if (!entry.date) entry.date = extractDate(normalized);
      break;
    case 'weather':
      if (!entry.weather) entry.weather = normalized;
      break;
    case 'weekNumber':
      if (!entry.weekNumber) entry.weekNumber = parseWeekNumber(normalized);
      break;
    case 'photoCount':
      entry.photoCount = Math.max(entry.photoCount, countPhotos(normalized));
      break;
    case 'diaryText':
      entry.diaryText = normalizeText([entry.diaryText, normalized].filter(Boolean).join('\n\n'));
      break;
    case 'peerFeedback':
      entry.peerFeedback = parseBracketedFeedback(normalized);
      break;
    case 'vocabItems':
      entry.vocabItems = parseVocabularyItems(normalized);
      entry.vocabCount = entry.vocabItems.length;
      break;
    case 'translations':
      entry.translations = parseTranslations(normalized);
      entry.translationCount = entry.translations.length;
      break;
    case 'chatbotFeedback':
      entry.chatbotFeedback = parseChatbotFeedback(normalized);
      break;
  }
};

const assignCellValue = (entry: ParsedDiaryEntry, field: LabelField, cell: CellData) => {
  const normalized = normalizeText(cell.text);
  if (!normalized && field !== 'photoCount' && cell.imageCount === 0) return;

  switch (field) {
    case 'date':
      if (!entry.date) entry.date = extractDate(normalized);
      break;
    case 'weather':
      if (!entry.weather) entry.weather = normalized;
      break;
    case 'weekNumber':
      if (!entry.weekNumber) entry.weekNumber = parseWeekNumber(normalized);
      break;
    case 'photoCount':
      entry.photoCount = Math.max(entry.photoCount, countPhotos(normalized, cell.imageCount));
      break;
    case 'diaryText':
      entry.diaryText = normalizeText([entry.diaryText, normalized].filter(Boolean).join('\n\n'));
      break;
    case 'peerFeedback':
      entry.peerFeedback = parseBracketedFeedback(normalized);
      break;
    case 'vocabItems':
      entry.vocabItems = parseVocabularyItems(normalized);
      entry.vocabCount = entry.vocabItems.length;
      break;
    case 'translations':
      entry.translations = parseTranslations(normalized);
      entry.translationCount = entry.translations.length;
      break;
    case 'chatbotFeedback':
      entry.chatbotFeedback = parseChatbotFeedback(normalized);
      break;
  }
};

const parseLabelBlocks = (blocks: string[]): ParsedDiaryEntry | null => {
  const entry = createEmptyEntry();

  for (const block of blocks) {
    const matchedField = (Object.entries(LABEL_PATTERNS) as Array<[LabelField, RegExp[]]>).find(([, patterns]) =>
      patterns.some((pattern) => pattern.test(block))
    );

    if (!matchedField) continue;
    const [field, patterns] = matchedField;
    const value = stripLabel(block, patterns);
    assignLabeledValue(entry, field, value);
  }

  return isMeaningfulEntry(entry) ? entry : null;
};

type LabeledDiaryV1EntryResult =
  | { ok: true; entry: ParsedDiaryEntry }
  | { ok: false; reason: 'missing_required_labels' | 'empty_entry_block' };

const parseLabeledDiaryV1EntryRows = (rows: TableRow[], explicitEntryId: string, fallbackIndex: number): LabeledDiaryV1EntryResult => {
  const contentRows = rows.filter((row) => row.some((cell) => cell.text || cell.imageCount > 0));
  if (contentRows.length < 2) return { ok: false, reason: 'empty_entry_block' };

  // If every cell in every content row is a known label token, this is an unfilled
  // template placeholder — treat it as empty rather than a malformed entry.
  const allLabelRows = contentRows.every((row) =>
    row.every((cell) => !cell.text || !!LABELED_DIARY_V1_FIELDS[normalizeLabelToken(cell.text)])
  );
  if (allLabelRows) return { ok: false, reason: 'empty_entry_block' };

  // Detect cells where a label token and its value were typed into the same cell,
  // e.g. "[DATE]April 19" or "[DATE] April 23" instead of a separate value row.
  const isMergedLabelCell = (cell: CellData): boolean => {
    const norm = normalizeLabelToken(cell.text);
    const close = norm.indexOf(']');
    if (close <= 0) return false;
    return !!LABELED_DIARY_V1_FIELDS[norm.slice(0, close + 1)] && norm.length > close + 1;
  };

  // Expand rows that have merged label+value cells into a label row + value row pair.
  // Only split rows where every non-empty cell is either a pure label or a merged label+value.
  const expandedRows: TableRow[] = [];
  for (const row of rows) {
    const hasMerged = row.some(isMergedLabelCell);
    const allLabelOrMerged =
      hasMerged &&
      row.every(
        (cell) => !cell.text || !!LABELED_DIARY_V1_FIELDS[normalizeLabelToken(cell.text)] || isMergedLabelCell(cell)
      );
    if (allLabelOrMerged) {
      expandedRows.push(
        row.map((cell) => {
          const close = normalizeBracketStyle(cell.text).indexOf(']');
          return { text: close >= 0 ? cell.text.slice(0, close + 1).trim() : '', imageCount: 0 };
        }),
        row.map((cell) => {
          const close = normalizeBracketStyle(cell.text).indexOf(']');
          return { text: close >= 0 ? cell.text.slice(close + 1).trim() : cell.text, imageCount: cell.imageCount };
        }),
      );
    } else {
      expandedRows.push(row);
    }
  }

  const entry = createEmptyEntry();
  entry.id = explicitEntryId || `entry_${fallbackIndex + 1}`;
  const matchedFields = new Set<LabelField>();

  // Label-aware pairing on unfiltered rows: identify each label row and pair it with
  // the immediately following row (which may be empty). This avoids the alignment errors
  // caused by empty value rows being filtered out before pairing.
  let rowIndex = 0;
  while (rowIndex < expandedRows.length) {
    const row = expandedRows[rowIndex];
    const isLabelRow =
      row.some((cell) => !!LABELED_DIARY_V1_FIELDS[normalizeLabelToken(cell.text)]) &&
      row.every((cell) => !cell.text || !!LABELED_DIARY_V1_FIELDS[normalizeLabelToken(cell.text)]);
    if (isLabelRow) {
      const labelRow = row;
      const valueRow = rowIndex + 1 < expandedRows.length ? expandedRows[rowIndex + 1] : [];
      const pairCount = Math.min(labelRow.length, valueRow.length);
      for (let cellIndex = 0; cellIndex < pairCount; cellIndex += 1) {
        const field = LABELED_DIARY_V1_FIELDS[normalizeLabelToken(labelRow[cellIndex].text)];
        if (!field) continue;
        matchedFields.add(field);
        assignCellValue(entry, field, valueRow[cellIndex]);
      }
      rowIndex += 2;
    } else {
      rowIndex += 1;
    }
  }

  // Allow one missing required label (e.g. student omitted a single label like [WEATHER]).
  if (matchedFields.size < LABELED_DIARY_V1_REQUIRED_FIELDS.size - 1) {
    return { ok: false, reason: 'missing_required_labels' };
  }

  return { ok: true, entry };
};

const parseLabeledDiaryV1Table = (rows: TableRow[]): ParsedPageContent | null => {
  const entries: ParsedPageContent = [];
  let currentRows: TableRow[] = [];
  let currentEntryId = '';
  let sawExplicitEntryBoundaries = false;
  let seenSemesterStart = false;

  const pushCurrentEntry = () => {
    if (currentRows.length === 0) return;
    const parsed = parseLabeledDiaryV1EntryRows(currentRows, currentEntryId, entries.length);
    if ('entry' in parsed) {
      entries.push(parsed.entry);
    }
    // Partial/incomplete entries (missing_required_labels) are silently skipped so
    // that mid-semester pages with only some complete entries still parse correctly.
    currentRows = [];
    currentEntryId = '';
  };

  rows.forEach((row) => {
    if (isSemesterStartRow(row)) {
      // [SEMESTER_START] marks the true beginning of the template; begin accumulating
      // rows even if [ENTRY START] is absent for Entry 1 (e.g. student 1234571).
      seenSemesterStart = true;
      return;
    }

    if (isEntryStartRow(row)) {
      sawExplicitEntryBoundaries = true;
      pushCurrentEntry();
      currentEntryId = extractEntryIdFromRow(row);
      return;
    }

    if (isEntryEndRow(row)) {
      pushCurrentEntry();
      return;
    }

    if (seenSemesterStart || currentEntryId || currentRows.length > 0) {
      currentRows.push(row);
    }
  });

  pushCurrentEntry();

  if (sawExplicitEntryBoundaries) {
    return entries.length > 0 ? entries : null;
  }

  const fallbackEntry = parseLabeledDiaryV1EntryRows(rows, '', 0);
  return fallbackEntry.ok ? [fallbackEntry.entry] : null;
};

const parseLabeledDiaryV1HTML = (htmlContent: string): ParsedPageContent | null => {
  const tables = extractTableRows(htmlContent);
  // Use flatMap so that non-diary tables (nav, header, layout wrappers) that return
  // null are coalesced to [] and ignored, rather than aborting the whole parse.
  const parsed = tables.flatMap((rows) => parseLabeledDiaryV1Table(rows) ?? []);
  return parsed.length > 0 ? parsed : null;
};

const parseGenericLabeledDiaryHTML = (htmlContent: string): ParsedPageContent | null => {
  const labelBlocks = extractTextBlocks(htmlContent);
  const labelFirst = parseLabelBlocks(labelBlocks);
  if (labelFirst) {
    labelFirst.id = labelFirst.id || 'entry_1';
    return [labelFirst];
  }

  const cells = parseJournalTable(htmlContent);
  if (cells) {
    const positionFallback = mapCellsToEntry(cells);
    if (positionFallback) {
      positionFallback.id = positionFallback.id || 'entry_1';
      return [positionFallback];
    }
  }

  return null;
};

// Term-aware date↔week consistency check across a page's entries.
//
// Week numbers reset between terms, so a week number that *drops* relative to the
// previous entry marks a new term (expected) rather than an error. Within a single
// term (non-decreasing weeks), the date should not move backward; when it does, the
// entry's date or week was likely mis-parsed. This is an advisory parse-time signal
// (surfaced via parseWarnings / Data Health) — it never reorders or drops entries.
export const annotateSequenceWarnings = (entries: ParsedPageContent): ParsedPageContent => {
  const fallbackYear = dominantYear(entries.map((entry) => entry.date));

  let prevWeek = Number.NaN;
  let prevTime = Number.NaN;

  return entries.map((entry) => {
    const week = parseEntryWeek(entry.weekNumber);
    const time = parseEntryDate(entry.date, fallbackYear);
    const finiteWeek = Number.isFinite(week);
    const finiteTime = Number.isFinite(time);
    const newTerm = finiteWeek && Number.isFinite(prevWeek) && week < prevWeek;

    const extra: string[] = [];
    if (!newTerm && finiteTime && Number.isFinite(prevTime) && time < prevTime) {
      extra.push(
        `Date "${entry.date}" (week ${entry.weekNumber || '?'}) is earlier than the previous entry in the same term — check date/week parse.`
      );
    }

    if (finiteWeek) prevWeek = week;
    if (newTerm) {
      prevTime = finiteTime ? time : Number.NaN; // restart the term's date baseline
    } else if (finiteTime) {
      prevTime = time;
    }

    return extra.length
      ? { ...entry, parseWarnings: [...(entry.parseWarnings ?? []), ...extra] }
      : entry;
  });
};

export const validateParsedEntry = (entry: ParsedDiaryEntry): string[] => {
  const warnings: string[] = [];

  if (!entry.id || entry.id.trim() === '') {
    warnings.push('Entry ID missing — save conflict risk');
  }

  if (!entry.date || entry.date.trim() === '') {
    warnings.push('Date missing');
  } else {
    const d = new Date(entry.date);
    if (isNaN(d.getTime())) {
      warnings.push(`Date not parseable: "${entry.date}"`);
    } else {
      const year = d.getFullYear();
      if (year < 2018 || year > 2030) {
        warnings.push(`Date year ${year} outside expected range (2018–2030)`);
      }
    }
  }

  if (!entry.weekNumber || entry.weekNumber.trim() === '') {
    warnings.push('Week number missing');
  } else {
    const w = parseInt(entry.weekNumber, 10);
    if (isNaN(w) || w < 1 || w > 52) {
      warnings.push(`Week number not valid: "${entry.weekNumber}"`);
    }
  }

  if (!entry.diaryText || entry.diaryText.trim() === '') {
    warnings.push('Diary text empty');
  } else if (entry.diaryText.trim().length < 30) {
    warnings.push('Diary text suspiciously short (< 30 chars)');
  }

  if (entry.vocabCount !== entry.vocabItems.length) {
    warnings.push(`Vocab count mismatch: reported ${entry.vocabCount}, found ${entry.vocabItems.length}`);
  }

  if (entry.translationCount !== entry.translations.length) {
    warnings.push(`Translation count mismatch: reported ${entry.translationCount}, found ${entry.translations.length}`);
  }

  const anonFeedback = entry.peerFeedback.filter((f) => !f.contributor || f.contributor.trim() === '');
  if (anonFeedback.length > 0) {
    warnings.push(`${anonFeedback.length} peer feedback item(s) missing contributor name`);
  }

  if (entry.rawText && entry.rawText.trim().length > 50) {
    warnings.push('Unclassified content captured in rawText — review before marking ready');
  }

  return warnings;
};

export const parseJournalTable = (htmlContent: string): string[] | null => {
  const cells = extractCellText(htmlContent);
  return cells.length >= 9 ? cells.slice(0, 9) : null;
};

export const parseLabeledDiaryHTML = (
  htmlContent: string,
  templateVersion: TemplateVersion = 'labeled-diary-v1'
): ParsedPageContent | null => {
  const parsed =
    templateVersion === 'labeled-diary-v1'
      ? parseLabeledDiaryV1HTML(htmlContent)
      : parseGenericLabeledDiaryHTML(htmlContent);

  return parsed ? annotateSequenceWarnings(parsed) : null;
};
