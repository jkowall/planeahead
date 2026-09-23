/**
 * The sliding session is extended by `GET /api/auth/get-session` only (the `/v1` middleware reads
 * with `disableRefresh`), so the app calls `authClient.getSession()` on launch and on every
 * transition to the foreground, at most once an hour (ruling P7).
 */

import { renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import {
  createSessionRefresher,
  SESSION_REFRESH_INTERVAL_MS,
  useSessionRefresh,
} from '../src/lib/session-refresh';

type Listener = (status: AppStateStatus) => void;

function captureAppState() {
  const listeners: Listener[] = [];
  const remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    listeners.push(listener);
    return { remove };
  });
  return {
    remove,
    emit(status: AppStateStatus) {
      for (const listener of listeners) {
        listener(status);
      }
    },
  };
}

async function flush() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('the session refresh', () => {
  it('calls getSession on launch and again on a foreground an hour later', async () => {
    let clock = 1_000_000;
    const getSession = jest.fn(() => Promise.resolve({ data: null }));
    const refresher = createSessionRefresher(getSession, () => clock);
    const appState = captureAppState();

    const hook = await renderHook(() => {
      useSessionRefresh(refresher);
    });
    expect(getSession).toHaveBeenCalledTimes(1);

    // Back to the foreground within the hour: throttled.
    appState.emit('background');
    clock += 10 * 60 * 1000;
    appState.emit('active');
    await flush();
    expect(getSession).toHaveBeenCalledTimes(1);

    // An hour after the last refresh: called.
    appState.emit('background');
    clock += SESSION_REFRESH_INTERVAL_MS;
    appState.emit('active');
    await flush();
    expect(getSession).toHaveBeenCalledTimes(2);

    // And throttled again right after.
    appState.emit('inactive');
    appState.emit('active');
    await flush();
    expect(getSession).toHaveBeenCalledTimes(2);

    await hook.unmount();
    expect(appState.remove).toHaveBeenCalled();
  });

  it('does not treat an active-to-active event as a foreground', async () => {
    let clock = 0;
    const getSession = jest.fn(() => Promise.resolve({ data: null }));
    const refresher = createSessionRefresher(getSession, () => clock);
    const appState = captureAppState();
    await renderHook(() => {
      useSessionRefresh(refresher);
    });
    appState.emit('active');
    await flush();
    expect(getSession).toHaveBeenCalledTimes(1);
    // Already active: a repeated `active` (iOS sends them) is not a return from the background.
    clock += 2 * SESSION_REFRESH_INTERVAL_MS;
    appState.emit('active');
    await flush();
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('retries on the next foreground when the refresh failed (offline)', async () => {
    let clock = 0;
    const getSession = jest
      .fn<Promise<unknown>, []>()
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValue({ data: null });
    const refresher = createSessionRefresher(getSession, () => clock);
    await expect(refresher.refresh('launch')).resolves.toBe(true);
    clock += 60_000;
    await expect(refresher.refresh('foreground')).resolves.toBe(true);
    expect(getSession).toHaveBeenCalledTimes(2);
  });
});
