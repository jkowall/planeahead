/**
 * Resend over plain `fetch` (`POST https://api.resend.com/emails`, Bearer key). No SDK: the one
 * call this Worker makes does not justify a dependency, and an injected `fetch` is the whole
 * test seam.
 *
 * Error handling follows Resend's documented codes (docs/increments/05-auth.facts.md section 5):
 *
 *   - 403 `validation_error` (unverified domain, sending before verification) and the two quota
 *     429s (`daily_quota_exceeded`, `monthly_quota_exceeded`) are configuration failures: logged
 *     at error level, returned as `configuration`, never retried, because a retry cannot verify
 *     a domain or raise a quota;
 *   - 429 `rate_limit_exceeded` is retried ONCE after `retry-after` seconds (capped, so a
 *     malicious or broken header cannot park a request), then reported as `rate_limited`;
 *   - 401 is a configuration failure (a missing or wrong key);
 *   - everything else, including a thrown fetch, is `transport`.
 *
 * The response body is never logged: on success it is only an id, on failure it can quote the
 * request, which carries the recipient address.
 */

import { type Logger } from '../observability/log';
import { MAIL_FROM, type MailMessage, type MailSendResult, type MailSender } from './sender';

export const RESEND_DEFAULT_URL = 'https://api.resend.com/emails';
/** The longest `retry-after` honoured, in seconds. */
export const RESEND_MAX_RETRY_AFTER_SECONDS = 5;

export interface ResendSenderOptions {
  readonly apiKey: string;
  readonly log: Logger;
  readonly from?: string;
  readonly url?: string;
  readonly fetch?: typeof fetch;
  /** Test seam for the retry pause. */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface ResendErrorBody {
  readonly name?: string;
  readonly message?: string;
}

async function readErrorName(response: Response): Promise<string | null> {
  try {
    const body = await response.json<ResendErrorBody>();
    return typeof body.name === 'string' ? body.name : null;
  } catch {
    return null;
  }
}

function retryAfterSeconds(response: Response): number {
  const header = response.headers.get('retry-after');
  const parsed = header === null ? Number.NaN : Number.parseInt(header, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 1;
  }
  return Math.min(parsed, RESEND_MAX_RETRY_AFTER_SECONDS);
}

export class ResendSender implements MailSender {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly url: string;
  private readonly from: string;

  constructor(private readonly options: ResendSenderOptions) {
    // A bare `fetch` reference stored on the instance and called as a method runs with `this`
    // bound to the sender, which workerd rejects as an illegal invocation. Wrap it instead.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.url = options.url ?? RESEND_DEFAULT_URL;
    this.from = options.from ?? MAIL_FROM;
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const first = await this.attempt(message);
    if (first.kind !== 'retry') {
      return first.result;
    }
    await this.sleep(first.afterSeconds * 1000);
    const second = await this.attempt(message);
    if (second.kind === 'retry') {
      this.options.log.warn('mail_rate_limited', { provider: 'resend', retried: true });
      return { ok: false, reason: 'rate_limited' };
    }
    return second.result;
  }

  private async attempt(
    message: MailMessage,
  ): Promise<{ kind: 'done'; result: MailSendResult } | { kind: 'retry'; afterSeconds: number }> {
    const log = this.options.log;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      'content-type': 'application/json',
    };
    if (message.idempotencyKey !== undefined) {
      headers['idempotency-key'] = message.idempotencyKey;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });
    } catch (error) {
      log.error('mail_transport_failed', {
        provider: 'resend',
        error_message: error instanceof Error ? error.message : String(error),
      });
      return { kind: 'done', result: { ok: false, reason: 'transport' } };
    }

    if (response.ok) {
      let id: string | null = null;
      try {
        const body = await response.json<{ id?: unknown }>();
        id = typeof body.id === 'string' ? body.id : null;
      } catch {
        id = null;
      }
      log.info('mail_sent', { provider: 'resend', has_id: id !== null });
      return { kind: 'done', result: { ok: true, id } };
    }

    const name = await readErrorName(response);
    if (response.status === 429 && name === 'rate_limit_exceeded') {
      return { kind: 'retry', afterSeconds: retryAfterSeconds(response) };
    }
    if (
      response.status === 403 ||
      response.status === 401 ||
      (response.status === 429 &&
        (name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded'))
    ) {
      // Someone has to act: verify the domain, replace the key, or raise the quota. Loud, and
      // not retried, because none of those change on a retry.
      log.error('mail_configuration_error', {
        provider: 'resend',
        status: response.status,
        error_name: name ?? 'unknown',
      });
      return { kind: 'done', result: { ok: false, reason: 'configuration' } };
    }
    log.error('mail_send_failed', {
      provider: 'resend',
      status: response.status,
      error_name: name ?? 'unknown',
    });
    return { kind: 'done', result: { ok: false, reason: 'transport' } };
  }
}
