// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RosterFilterInput, RosterNoMatches, RosterUnavailableToggle } from './RosterFilter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn();

const render = (element: React.ReactElement) => act(async () => root.render(element));
const input = () => container.querySelector<HTMLInputElement>('input[aria-label="Filter classes"]')!;
const type = (text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text);
  input().dispatchEvent(new Event('input', { bubbles: true }));
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  onChange.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('RosterFilterInput', () => {
  const props = { onChange, shownCount: 2, totalCount: 9, hiddenSelectedCount: 0 };

  it('reports what is typed', async () => {
    await render(<RosterFilterInput {...props} value="" />);
    await type('read');
    expect(onChange).toHaveBeenCalledWith('read');
  });

  it('shows no status line or clear button until something is typed', async () => {
    await render(<RosterFilterInput {...props} value="" />);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[aria-label="Clear filter"]')).toBeNull();
  });

  it('shows how many classes match and clears from the button', async () => {
    await render(<RosterFilterInput {...props} value="read" />);
    expect(container.querySelector('[role="status"]')!.textContent).toBe('2 of 9 shown');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Clear filter"]')!.click());
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('clears on Escape only when there is text', async () => {
    await render(<RosterFilterInput {...props} value="read" />);
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onChange).toHaveBeenCalledWith('');
    onChange.mockReset();
    await render(<RosterFilterInput {...props} value="" />);
    await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([[1, '1 selected class is hidden by the filter'], [3, '3 selected classes are hidden by the filter']])(
    'warns when %i selected classes are hidden', async (count, text) => {
      await render(<RosterFilterInput {...props} value="read" hiddenSelectedCount={count} />);
      expect(container.querySelector('[role="status"]')!.textContent).toContain(text);
    });
});

describe('RosterUnavailableToggle', () => {
  const button = () => container.querySelector('button')!;

  it('says how many notebooks it would add and toggles', async () => {
    const onToggle = vi.fn();
    await render(<RosterUnavailableToggle on={false} count={3} onToggle={onToggle} />);
    expect(button().textContent).toBe('Show unavailable (3)');
    expect(button().title).toContain('3 notebooks');
    expect(button().getAttribute('aria-pressed')).toBe('false');
    await act(async () => button().click());
    expect(onToggle).toHaveBeenCalled();
  });

  it('is greyed with the reason when there is nothing to add', async () => {
    await render(<RosterUnavailableToggle on={false} count={0} onToggle={vi.fn()} />);
    expect(button().disabled).toBe(true);
    expect(button().title).toBe('Every notebook found is already listed.');
  });

  it('offers to hide them again once on, even though the count reads zero', async () => {
    const onToggle = vi.fn();
    await render(<RosterUnavailableToggle on count={0} onToggle={onToggle} />);
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe('Hide unavailable');
    expect(button().getAttribute('aria-pressed')).toBe('true');
    await act(async () => button().click());
    expect(onToggle).toHaveBeenCalled();
  });

  it('uses the singular for one notebook', async () => {
    await render(<RosterUnavailableToggle on={false} count={1} onToggle={vi.fn()} />);
    expect(button().title).toContain('1 notebook you cannot open');
  });
});

describe('RosterNoMatches', () => {
  it('names the filter and offers to clear it', async () => {
    const onClear = vi.fn();
    await render(<RosterNoMatches query=" zzz " onClear={onClear} />);
    expect(container.textContent).toContain('No classes match “zzz”.');
    await act(async () => container.querySelector('button')!.click());
    expect(onClear).toHaveBeenCalled();
  });
});
