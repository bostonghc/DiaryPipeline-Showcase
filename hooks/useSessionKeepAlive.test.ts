// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEPALIVE_INTERVAL_MS, KEEPALIVE_PATH } from '../services/sessionKeepAlive';
import { useSessionKeepAlive } from './useSessionKeepAlive';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MINUTE = 60 * 1000;

interface ProbeProps {
  signedIn: boolean;
  onSessionEnded: () => void;
}
const Probe = (props: ProbeProps) => {
  useSessionKeepAlive(props);
  return null;
};

// The page is real (react-dom in jsdom, real events, real timers' ordering); only
// the network is replaced, because there is no server here to ping.
describe('useSessionKeepAlive', () => {
  const fetchMock = vi.fn();
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ status: 204 });
    vi.stubGlobal('fetch', fetchMock);
    root = createRoot(document.createElement('div'));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const render = (props: ProbeProps) =>
    act(async () => {
      root.render(createElement(Probe, props));
    });
  const wait = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const interact = (target: EventTarget, type: string) =>
    act(async () => {
      target.dispatchEvent(new Event(type, { bubbles: type !== 'scroll' }));
    });

  it('pings with the session cookie on each tick while the person keeps using the page', async () => {
    await render({ signedIn: true, onSessionEnded: vi.fn() });

    for (let tick = 0; tick < 4; tick += 1) {
      await interact(window, 'pointerdown');
      await wait(KEEPALIVE_INTERVAL_MS);
    }

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenCalledWith(KEEPALIVE_PATH, { method: 'POST', credentials: 'same-origin' });
  });

  it('stops pinging once the person has been inactive for the whole window', async () => {
    await render({ signedIn: true, onSessionEnded: vi.fn() });

    await wait(60 * MINUTE);

    // Opening the page counted as use, so one ping is due before the window ends.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts pointer movement as being present, for someone presenting without clicking', async () => {
    await render({ signedIn: true, onSessionEnded: vi.fn() });

    await wait(9 * MINUTE);
    await interact(window, 'pointermove');
    await wait(6 * MINUTE);

    // Ticks at 5, 10 and 15 minutes; without the movement the 10 and 15 would be skipped.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('notices scrolling inside a nested pane, which does not bubble to the window', async () => {
    await render({ signedIn: true, onSessionEnded: vi.fn() });
    const pane = document.createElement('div');
    document.body.appendChild(pane);

    await wait(9 * MINUTE);
    await interact(pane, 'scroll');
    await wait(6 * MINUTE);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    pane.remove();
  });

  it('does nothing while there is no Microsoft sign-in', async () => {
    await render({ signedIn: false, onSessionEnded: vi.fn() });

    await interact(window, 'pointerdown');
    await wait(30 * MINUTE);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops the moment the person signs out, even straight after being active', async () => {
    const onSessionEnded = vi.fn();
    await render({ signedIn: true, onSessionEnded });
    await interact(window, 'pointerdown');
    await wait(KEEPALIVE_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await interact(window, 'pointerdown');
    await render({ signedIn: false, onSessionEnded });
    await wait(30 * MINUTE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops when the page is closed', async () => {
    await render({ signedIn: true, onSessionEnded: vi.fn() });
    await interact(window, 'pointerdown');
    await wait(KEEPALIVE_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await interact(window, 'pointerdown');
    await act(async () => root.unmount());
    await wait(30 * MINUTE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tells the app the sign-in ended when the server answers 401', async () => {
    fetchMock.mockResolvedValue({ status: 401 });
    const onSessionEnded = vi.fn();
    await render({ signedIn: true, onSessionEnded });

    await wait(KEEPALIVE_INTERVAL_MS);

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('does not report a sign-out for a server error or a dropped connection, and tries again', async () => {
    fetchMock.mockResolvedValueOnce({ status: 503 }).mockRejectedValueOnce(new TypeError('network down'));
    const onSessionEnded = vi.fn();
    await render({ signedIn: true, onSessionEnded });

    await wait(KEEPALIVE_INTERVAL_MS);
    await interact(window, 'pointerdown');
    await wait(KEEPALIVE_INTERVAL_MS);
    await interact(window, 'pointerdown');
    await wait(KEEPALIVE_INTERVAL_MS);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onSessionEnded).not.toHaveBeenCalled();
  });
});
