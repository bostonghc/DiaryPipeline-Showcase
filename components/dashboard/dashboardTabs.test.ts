import { describe, expect, it } from 'vitest';
import { MICROSOFT_SIGNED_OUT_REASON } from '../../services/sentFeedbackAccess';
import { buildDashboardTabs, resolveActiveTab } from './dashboardTabs';

const sentReview = (access: Parameters<typeof buildDashboardTabs>[0]) =>
  buildDashboardTabs(access).find((tab) => tab.id === 'sent-review');

describe('dashboard tabs', () => {
  it('leaves out the sent-feedback tab for people who can never use it', () => {
    expect(sentReview('not-permitted')).toBeUndefined();
  });

  it('keeps the tab visible but unavailable, with the reason, when the Microsoft session ended', () => {
    expect(sentReview('signed-out')).toMatchObject({
      label: 'Sent Feedback Review',
      unavailableReason: MICROSOFT_SIGNED_OUT_REASON,
    });
  });

  it('offers the tab normally while it is ready or verifying', () => {
    expect(sentReview('ready')?.unavailableReason).toBeUndefined();
    expect(sentReview('verifying')?.unavailableReason).toBeUndefined();
  });

  it('keeps the other tabs in a fixed order whatever the access', () => {
    const ids = (access: Parameters<typeof buildDashboardTabs>[0]) =>
      buildDashboardTabs(access).map((tab) => tab.id).filter((id) => id !== 'sent-review');
    expect(ids('signed-out')).toEqual(ids('ready'));
    expect(ids('not-permitted')).toEqual(ids('ready'));
  });
});

describe('active dashboard tab', () => {
  it('stays on an unavailable tab so its explanation is shown, rather than jumping elsewhere', () => {
    expect(resolveActiveTab('sent-review', buildDashboardTabs('signed-out'))).toBe('sent-review');
  });

  it('returns to the Review Queue only when the tab is gone altogether', () => {
    expect(resolveActiveTab('sent-review', buildDashboardTabs('not-permitted'))).toBe('review-queue');
  });

  it('leaves any tab that is still listed alone', () => {
    expect(resolveActiveTab('data-health', buildDashboardTabs('not-permitted'))).toBe('data-health');
  });
});
