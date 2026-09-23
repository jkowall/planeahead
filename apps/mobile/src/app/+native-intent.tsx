/**
 * expo-router's native-intent hook: a file the router loads from the app directory, never a route.
 *
 * `redirectSystemPath` runs for the URL the app launched with (`initial: true`) and, before the
 * router navigates on it, for every URL delivered while the app runs. It records the URL for the
 * screens that need to know how they were opened (src/lib/delivered-url.ts: the magic-link
 * screen verifies a link without asking only when it arrived as a universal link on this build's
 * host) and returns it unchanged. No path is rewritten here.
 */

import { recordDeliveredUrl } from '../lib/delivered-url';

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  recordDeliveredUrl(path, initial);
  return path;
}
