/**
 * Cloudflare Email Sending, as an implementation of `MailSender` and nothing more.
 *
 * NOT WIRED. The service is Beta, Workers Paid only, requires the domain on Cloudflare DNS,
 * publishes no starting daily quota ("a conservative daily quota" that scales), and bounces
 * through `cf-bounce.<domain>`, which would need its own Sign in with Apple email-source
 * registration. Resend is the Phase 0 provider. This file exists so that switching is a
 * binding plus one line in `selectMailSender`, not a rewrite, and so the binding's shape is
 * typed here rather than guessed later. `wrangler.jsonc` declares no `send_email` binding.
 */

import type { Logger } from '../observability/log';
import { MAIL_FROM, type MailMessage, type MailSendResult, type MailSender } from './sender';

/** The subset of the Email Sending binding this sender needs. */
export interface CloudflareEmailBinding {
  send(message: {
    readonly from: string;
    readonly to: string;
    readonly subject: string;
    readonly text?: string;
    readonly html?: string;
  }): Promise<unknown>;
}

export class CloudflareEmailSender implements MailSender {
  constructor(
    private readonly binding: CloudflareEmailBinding,
    private readonly log: Logger,
    private readonly from: string = MAIL_FROM,
  ) {}

  async send(message: MailMessage): Promise<MailSendResult> {
    try {
      await this.binding.send({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      this.log.info('mail_sent', { provider: 'cloudflare_email', has_id: false });
      return { ok: true, id: null };
    } catch (error) {
      this.log.error('mail_send_failed', {
        provider: 'cloudflare_email',
        error_message: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, reason: 'transport' };
    }
  }
}
