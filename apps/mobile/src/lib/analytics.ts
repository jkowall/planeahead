/**
 * First-party analytics: `POST /v1/events` with the install-scoped analytics id (ADR 0005).
 *
 * The request carries NO session cookie and NO `X-Install-Id`: the analytics id is never joined
 * to an account on our side. The App Privacy label still says Device ID, Linked, because the
 * label shows a data type in one section and the OTHER per-install id, the install id, is
 * registered under the account (ADR 0005). No ATT prompt: first-party analytics to our own
 * endpoint is not tracking. Events are queued in memory and flushed in batches; the queue is
 * bounded and nothing is persisted, so a lost batch is lost.
 *
 * `POST /v1/events` is still the API's 501 stub; the orchestrator assigned the endpoint to
 * increment 12 (fix-round ruling S6). Until then a 501 turns the client off for the rest of the
 * process instead of retrying into it.
 */

export interface AnalyticsEvent {
  readonly name: string;
  readonly at: string;
  readonly props?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AnalyticsDeps {
  readonly baseUrl: string;
  readonly analyticsId: () => string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /** Flush as soon as this many events are queued. */
  readonly batchSize?: number;
}

export interface Analytics {
  track(name: string, props?: AnalyticsEvent['props']): void;
  flush(): Promise<void>;
  readonly queued: number;
}

const MAX_QUEUE = 100;

export function createAnalytics(deps: AnalyticsDeps): Analytics {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const batchSize = deps.batchSize ?? 20;
  let queue: AnalyticsEvent[] = [];
  let disabled = false;
  let flushing: Promise<void> | null = null;

  const send = async (): Promise<void> => {
    if (disabled || queue.length === 0) {
      return;
    }
    const batch = queue;
    queue = [];
    try {
      const response = await doFetch(`${deps.baseUrl}/v1/events`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analyticsId: deps.analyticsId(), events: batch }),
      });
      if (response.status === 501) {
        disabled = true;
      }
    } catch {
      // Offline: keep the newest events for the next flush, within the bound.
      queue = [...batch, ...queue].slice(-MAX_QUEUE);
    }
  };

  const analytics: Analytics = {
    track(name, props) {
      if (disabled) {
        return;
      }
      queue.push({ name, at: now().toISOString(), ...(props === undefined ? {} : { props }) });
      if (queue.length > MAX_QUEUE) {
        queue = queue.slice(-MAX_QUEUE);
      }
      if (queue.length >= batchSize) {
        void analytics.flush();
      }
    },
    flush() {
      flushing ??= send().finally(() => {
        flushing = null;
      });
      return flushing;
    },
    get queued() {
      return queue.length;
    },
  };
  return analytics;
}
