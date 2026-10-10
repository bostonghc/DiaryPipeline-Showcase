// Lightweight, in-memory Firestore read meter for diagnostics / bug hunting.
//
// Counting is a single integer add per read operation — there is no measurable
// runtime cost and, deliberately, no React state on the read path (so a burst of
// reads never triggers re-renders). The UI reads the totals on a low-frequency
// poll only while the debug panel is open. Reads are attributed by a short label
// so the exported log can answer "what cost reads".
//
// A "read" here mirrors Firestore billing: a query counts the number of documents
// it returned; a single-document get counts as 1 (even when the document is absent).

let total = 0;
const byLabel: Record<string, number> = {};
let sessionStart = Date.now();

export const recordRead = (label: string, count: number): void => {
  if (!Number.isFinite(count) || count <= 0) return;
  total += count;
  byLabel[label] = (byLabel[label] || 0) + count;
};

export type ReadTotals = {
  total: number;
  byLabel: Record<string, number>;
  startedAt: number;
  sinceMs: number;
};

export const getReadTotals = (): ReadTotals => ({
  total,
  byLabel: { ...byLabel },
  startedAt: sessionStart,
  sinceMs: Date.now() - sessionStart,
});

export const resetReadMeter = (): void => {
  total = 0;
  for (const key of Object.keys(byLabel)) delete byLabel[key];
  sessionStart = Date.now();
};

// A compact multi-line summary for inclusion in an exported debug log.
export const formatReadSummary = (): string => {
  const lines = Object.entries(byLabel)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `  ${count.toLocaleString()}  ${label}`);
  const minutes = Math.max(1, Math.round((Date.now() - sessionStart) / 60000));
  return [
    `Firestore reads counted: ${total.toLocaleString()}`,
    `Window: since ${new Date(sessionStart).toLocaleString()} (~${minutes} min)`,
    ...lines,
  ].join('\n');
};
