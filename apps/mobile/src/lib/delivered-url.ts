/**
 * The URLs the OS delivered to the app, as expo-router saw them: the one the app launched with and
 * every one that arrived while it ran. `src/app/+native-intent.tsx` records them from
 * `redirectSystemPath`, which the router calls for the launch URL (`initial: true`) and, from
 * React Native's `url` event, for every later one, in both cases before it navigates.
 *
 * Why not `Linking.getLinkingURL()` (or `useLinkingURL()`, whose first value it is): on iOS that
 * is `ExpoLinkingRegistry.shared.initialURL`, which a custom-scheme open overwrites, a universal
 * link sets only while it is nil, and nothing clears (expo-linking 57.0.10,
 * ios/LinkingAppDelegateSubscriber.swift). After the development client's launch URL, a Google
 * sign-in redirect or a first magic link, every later universal link read as that older URL, so a
 * link the user had just requested went to the confirm screen with a message that was false
 * (increment 9 re-review, auth-and-store-3). Android updates the value on every intent and was
 * never affected; the router's hook sees every delivery on both platforms.
 *
 * Only the last delivery is kept, with the time it arrived: the screen a link opened needs that
 * one, and a second delivery of the same URL (the link tapped again) is a new decision for it.
 */

import { useSyncExternalStore } from 'react';

export interface DeliveredUrl {
  readonly url: string;
  /** `Date.now()` when the router saw it. */
  readonly at: number;
  /** True for the URL the app launched with. */
  readonly initial: boolean;
}

let last: DeliveredUrl | null = null;
const listeners = new Set<() => void>();

export function recordDeliveredUrl(
  url: string,
  initial: boolean,
  now: number = Date.now(),
): DeliveredUrl {
  const delivered: DeliveredUrl = Object.freeze({ url, at: now, initial });
  last = delivered;
  for (const listener of [...listeners]) {
    listener();
  }
  return delivered;
}

export function lastDeliveredUrl(): DeliveredUrl | null {
  return last;
}

export function subscribeToDeliveredUrl(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The last delivered URL, re-rendering the caller when a new one arrives. */
export function useDeliveredUrl(): DeliveredUrl | null {
  return useSyncExternalStore(subscribeToDeliveredUrl, lastDeliveredUrl, lastDeliveredUrl);
}

/** Tests only: forget every delivery. */
export function resetDeliveredUrls(): void {
  last = null;
}
