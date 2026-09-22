/**
 * Operational alerts: the few events that must page a person rather than wait in a log (increment
 * 6: a provider's kill switch tripping). Each one is logged at error level AND sent to Sentry as
 * a `fatal` message, so it reaches whoever watches either.
 *
 * Call it where a Sentry client exists: the Worker's `fetch`, `queue` and `scheduled` handlers,
 * all wrapped by `withSentry` in src/index.ts. A Durable Object RPC has no client, which is why
 * the ProviderBudget object sends its alert through the `persist` queue instead of calling this.
 */

import { captureMessage } from '@sentry/cloudflare';
import type { Logger } from './log';

export type OpsAlertEvent = 'provider_kill_switch_tripped';

/** The Sentry call, injectable so a test can observe it. */
export type CaptureMessage = (
  message: string,
  context: { level: 'fatal'; tags: Record<string, string>; extra: Record<string, unknown> },
) => unknown;

export function raiseOpsAlert(
  event: OpsAlertEvent,
  fields: Readonly<Record<string, unknown>>,
  log: Logger,
  capture: CaptureMessage = captureMessage,
): void {
  log.error(event, fields);
  const tags: Record<string, string> = { ops_alert: event };
  for (const key of ['provider', 'reason', 'utcDate']) {
    const value = fields[key];
    if (typeof value === 'string') {
      tags[key] = value;
    }
  }
  try {
    capture(event, { level: 'fatal', tags, extra: { ...fields } });
  } catch (error) {
    log.warn('ops_alert_capture_failed', {
      event,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}
