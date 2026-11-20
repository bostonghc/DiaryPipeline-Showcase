import { MICROSOFT_SIGNED_OUT_REASON, type SentFeedbackReviewAccess } from '../../services/sentFeedbackAccess';

export type DashboardTab =
  | 'review-queue'
  | 'data-health'
  | 'teacher-practice'
  | 'student-trajectories'
  | 'class-patterns'
  | 'peer-feedback'
  | 'sent-review';

export interface DashboardTabSpec {
  id: DashboardTab;
  label: string;
  /** Planned but not built yet; not selectable. */
  disabled?: boolean;
  /**
   * Temporarily unavailable for a reason the person can fix. The tab stays
   * visible and greyed, with this as its tooltip, and still opens so the pane
   * can explain and offer the fix. Hide a tab only when it is never available
   * to this person (ARCHITECTURE §22).
   */
  unavailableReason?: string;
}

export const buildDashboardTabs = (sentFeedbackReview: SentFeedbackReviewAccess): DashboardTabSpec[] => [
  { id: 'review-queue', label: 'Review Queue' },
  { id: 'data-health', label: 'Data Health' },
  { id: 'teacher-practice', label: 'Teacher Practice' },
  { id: 'student-trajectories', label: 'Student Trajectories' },
  { id: 'class-patterns', label: 'Class Patterns' },
  { id: 'peer-feedback', label: 'Peer & Intern Feedback' },
  ...(sentFeedbackReview === 'not-permitted'
    ? []
    : [{
        id: 'sent-review' as const,
        label: 'Sent Feedback Review',
        ...(sentFeedbackReview === 'signed-out' ? { unavailableReason: MICROSOFT_SIGNED_OUT_REASON } : {}),
      }]),
];

/** A tab that is no longer listed at all (never one that is merely unavailable) falls back to the first. */
export const resolveActiveTab = (active: DashboardTab, tabs: DashboardTabSpec[]): DashboardTab =>
  tabs.some((tab) => tab.id === active) ? active : 'review-queue';
