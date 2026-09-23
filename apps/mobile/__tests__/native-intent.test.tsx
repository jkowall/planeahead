/**
 * src/app/+native-intent.tsx and src/lib/delivered-url.ts: every URL the router delivers, the
 * launch URL and each later one, is recorded with its time and handed back unchanged, and a
 * mounted screen sees the new delivery (increment 9 re-review, auth-and-store-3).
 */

import { act, renderHook } from '@testing-library/react-native';
import { redirectSystemPath } from '../src/app/+native-intent';
import {
  lastDeliveredUrl,
  recordDeliveredUrl,
  resetDeliveredUrls,
  useDeliveredUrl,
} from '../src/lib/delivered-url';

const LAUNCH = 'planeahead://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081';
const LINK = 'https://api.planeahead.app/auth/magic-link?token=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf';

beforeEach(() => {
  resetDeliveredUrls();
});

describe('redirectSystemPath', () => {
  it('records the launch URL and every later one, with the time, and rewrites nothing', () => {
    const before = Date.now();
    expect(redirectSystemPath({ path: LAUNCH, initial: true })).toBe(LAUNCH);
    expect(lastDeliveredUrl()).toMatchObject({ url: LAUNCH, initial: true });
    expect(lastDeliveredUrl()?.at).toBeGreaterThanOrEqual(before);

    expect(redirectSystemPath({ path: LINK, initial: false })).toBe(LINK);
    expect(lastDeliveredUrl()).toMatchObject({ url: LINK, initial: false });
  });

  it('keeps a second delivery of the same URL apart from the first by its time', () => {
    const first = recordDeliveredUrl(LINK, true, 1_000);
    const second = recordDeliveredUrl(LINK, false, 2_000);
    expect(first).not.toBe(second);
    expect(second.at).toBe(2_000);
    expect(lastDeliveredUrl()).toBe(second);
  });
});

describe('useDeliveredUrl', () => {
  it('starts from the last delivery and re-renders on the next one', async () => {
    recordDeliveredUrl(LAUNCH, true);
    const { result } = await renderHook(() => useDeliveredUrl());
    expect(result.current).toMatchObject({ url: LAUNCH, initial: true });
    await act(() => {
      redirectSystemPath({ path: LINK, initial: false });
    });
    expect(result.current).toMatchObject({ url: LINK, initial: false });
  });
});
