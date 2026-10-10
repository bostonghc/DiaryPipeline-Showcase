import React from 'react';
import {
  getEntryWorkflowLabel,
  type EntryWorkflowUiState,
} from '../../services/feedbackWorkflowService';

interface WorkflowBadgeProps {
  state: EntryWorkflowUiState;
  className?: string;
}

const STATE_CLASSES: Record<EntryWorkflowUiState, string> = {
  ready: 'bg-emerald-100 text-emerald-700',
  unsaved: 'bg-amber-100 text-amber-700',
  draft: 'bg-slate-100 text-slate-500',
};

export const WorkflowBadge: React.FC<WorkflowBadgeProps> = ({ state, className = '' }) => (
  <span
    className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md ${STATE_CLASSES[state]} ${className}`}
  >
    {getEntryWorkflowLabel(state)}
  </span>
);
