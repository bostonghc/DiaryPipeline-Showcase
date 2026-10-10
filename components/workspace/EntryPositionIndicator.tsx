import React from 'react';
import {
  type EntryWorkflowUiState,
  getEntryWorkflowLabel,
} from '../../services/feedbackWorkflowService';
import type { ParsedDiaryEntry } from '../../types';

interface EntryPositionIndicatorProps {
  currentIndex: number;
  totalEntries: number;
  entry: ParsedDiaryEntry;
  workflowUiState: EntryWorkflowUiState;
}

const WORKFLOW_COLOR: Record<EntryWorkflowUiState, string> = {
  ready: 'text-emerald-600',
  unsaved: 'text-amber-600',
  draft: 'text-slate-400',
};

export const EntryPositionIndicator: React.FC<EntryPositionIndicatorProps> = ({
  currentIndex,
  totalEntries,
  entry,
  workflowUiState,
}) => {
  const position = `${currentIndex + 1} / ${totalEntries}`;
  const dateLabel = entry.date || entry.weekNumber || null;
  const workflowLabel = getEntryWorkflowLabel(workflowUiState);
  const workflowColor = WORKFLOW_COLOR[workflowUiState];

  return (
    <div className="flex items-center gap-1 text-[11px] font-medium text-slate-500 min-w-0 shrink">
      {/* Very narrow: just position */}
      <span className="font-bold text-slate-600 tabular-nums shrink-0">{position}</span>

      {/* sm+: add date/week */}
      {dateLabel && (
        <>
          <span className="text-slate-300 shrink-0 hidden sm:inline">·</span>
          <span className="truncate hidden sm:inline">{dateLabel}</span>
        </>
      )}

      {/* Desktop: add workflow state */}
      <span className="text-slate-300 shrink-0 hidden md:inline">·</span>
      <span className={`font-bold shrink-0 hidden md:inline ${workflowColor}`}>
        {workflowLabel}
      </span>
    </div>
  );
};
