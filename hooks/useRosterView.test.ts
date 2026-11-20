// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EducationClass } from '../types';
import { useRosterView } from './useRosterView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cls = (displayName: string, extra: Partial<EducationClass> = {}): EducationClass => ({
  id: displayName, displayName, description: '', accessStatus: 'accessible', rosterStatus: 'discovered', ...extra,
});

// Stable identities: the hook memoizes on its inputs.
const classes = [
  cls('Reading 3', { rosterStatus: 'saved' }), cls('Writing 1', { rosterStatus: 'saved' }),
  cls('Seminar'), cls('Locked', { accessStatus: 'inaccessible' }),
];
let selected: ReadonlySet<string> = new Set();
let view: ReturnType<typeof useRosterView>;
const Probe = () => {
  view = useRosterView(classes, selected);
  return null;
};

describe('useRosterView', () => {
  let root: Root;
  const mount = () => act(async () => root.render(createElement(Probe)));
  const shown = () => view.visibleClasses.map(item => item.displayName);

  beforeEach(() => {
    root = createRoot(document.createElement('div'));
    selected = new Set();
  });
  afterEach(() => act(() => root.unmount()));

  it('starts unfiltered, saved first, with inaccessible classes hidden', async () => {
    await mount();
    expect(shown()).toEqual(['Reading 3', 'Writing 1', 'Seminar']);
    expect(view.filtering).toBe(false);
    expect(view.hiddenSelectedCount).toBe(0);
    expect(view.savedCount).toBe(2);
    expect(view.discoveredCount).toBe(2);
  });

  it('filters as the query changes and clears back to the full list', async () => {
    await mount();
    await act(async () => view.setQuery('writ'));
    expect(shown()).toEqual(['Writing 1']);
    expect(view.filtering).toBe(true);
    expect(view.totalCount).toBe(3);
    await act(async () => view.setQuery(''));
    expect(shown()).toEqual(['Reading 3', 'Writing 1', 'Seminar']);
  });

  it('counts selected classes the filter is hiding, but not ones it keeps', async () => {
    selected = new Set(['Reading 3', 'Seminar']);
    await mount();
    expect(view.hiddenSelectedCount).toBe(0);
    await act(async () => view.setQuery('seminar'));
    expect(view.hiddenSelectedCount).toBe(1);
  });

  it('shows unavailable classes when the toggle is on, and the filter applies to them', async () => {
    await mount();
    expect(view.showUnavailable).toBe(false);
    await act(async () => view.toggleShowUnavailable());
    expect(view.showUnavailable).toBe(true);
    expect(shown()).toContain('Locked');
    await act(async () => view.setQuery('lock'));
    expect(shown()).toEqual(['Locked']);
  });

  it('counts the notebooks the toggle would add, and stops counting once it is on', async () => {
    await mount();
    expect(view.unavailableCount).toBe(1);
    await act(async () => view.setQuery('seminar')); // the filter does not change it
    expect(view.unavailableCount).toBe(1);
    await act(async () => view.toggleShowUnavailable());
    expect(view.unavailableCount).toBe(0);
  });

  it('never changes the selection, whether filtering or toggling', async () => {
    selected = new Set(['Reading 3']);
    await mount();
    await act(async () => view.setQuery('zzz'));
    await act(async () => view.toggleShowUnavailable());
    expect([...selected]).toEqual(['Reading 3']);
    expect(view.hiddenSelectedCount).toBe(1);
  });

  it('labels the groups only when both are in view', async () => {
    await mount();
    expect(view.headings).toEqual(['Your roster', null, 'Other notebooks']);
    await act(async () => view.setQuery('read'));
    expect(view.headings).toEqual([null]);
  });
});
