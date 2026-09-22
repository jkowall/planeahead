/**
 * Picks the sender for this deployment. Resend when `RESEND_API_KEY` is set (every deployed
 * environment, and the Workers suite against its fake endpoint through `RESEND_API_URL`),
 * otherwise the logging no-op so `wrangler dev` without a key still answers sign-in requests.
 * `CloudflareEmailSender` is deliberately absent from the choice (see its file).
 */

import type { Env } from '../env';
import type { Logger } from '../observability/log';
import { NoopSender } from './noop';
import { ResendSender } from './resend';
import type { MailSender } from './sender';

export { CloudflareEmailSender } from './cloudflare-email';
export { NoopSender } from './noop';
export { RESEND_MAX_RETRY_AFTER_SECONDS, ResendSender } from './resend';
export {
  MAIL_FROM,
  MAGIC_LINK_TOKEN_PREFIX_LENGTH,
  buildMagicLinkEmail,
  type MagicLinkEmail,
  type MailMessage,
  type MailSendResult,
  type MailSender,
} from './sender';

export function selectMailSender(env: Env, log: Logger): MailSender {
  const apiKey = env.RESEND_API_KEY;
  if (apiKey !== undefined && apiKey !== '') {
    return new ResendSender({
      apiKey,
      log,
      ...(env.RESEND_API_URL === undefined ? {} : { url: env.RESEND_API_URL }),
    });
  }
  return new NoopSender(log);
}
