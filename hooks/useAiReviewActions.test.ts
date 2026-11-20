import { describe, expect, it, vi } from 'vitest';
import { dispatchAiReviewAction, type AiReviewActionDeps } from './useAiReviewActions';

const deps = (over: Partial<AiReviewActionDeps> = {}): AiReviewActionDeps => ({
  recoverMicrosoft: vi.fn(async () => {}),
  recoverGoogle: vi.fn(async () => {}),
  retryBinding: vi.fn(async () => {}),
  canSaveDraft: () => true,
  ...over,
});

describe('dispatchAiReviewAction', () => {
  it('routes each sign-in and binding action to its handler', async () => {
    const d = deps(); const save = vi.fn(async () => {});
    await dispatchAiReviewAction(d, 'sign_in_microsoft', save);
    await dispatchAiReviewAction(d, 'sign_in_google', save);
    await dispatchAiReviewAction(d, 'retry_binding', save);
    expect(d.recoverMicrosoft).toHaveBeenCalledTimes(1);
    expect(d.recoverGoogle).toHaveBeenCalledTimes(1);
    expect(d.retryBinding).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('saves the draft when allowed', async () => {
    const save = vi.fn(async () => {});
    await dispatchAiReviewAction(deps(), 'save_draft', save);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('refuses to save without a Google user or save handler', async () => {
    const save = vi.fn(async () => {});
    await expect(dispatchAiReviewAction(deps({ canSaveDraft: () => false }), 'save_draft', save))
      .rejects.toThrow('Sign in with Google before saving your draft.');
    expect(save).not.toHaveBeenCalled();
  });

  it('propagates handler rejections', async () => {
    const d = deps({ recoverMicrosoft: vi.fn(async () => { throw new Error('cancelled'); }) });
    await expect(dispatchAiReviewAction(d, 'sign_in_microsoft', vi.fn())).rejects.toThrow('cancelled');
  });
});
