/**
 * The sender for environments with no mail provider: `wrangler dev` without a Resend key, and
 * tests that want to inspect what would have been sent. It keeps every message in memory and
 * logs one line per send WITHOUT the body or the link: a magic-link token in a log line is a
 * sign-in for whoever reads the logs.
 */

import type { Logger } from '../observability/log';
import type { MailMessage, MailSendResult, MailSender } from './sender';

export class NoopSender implements MailSender {
  readonly sent: MailMessage[] = [];

  constructor(private readonly log: Logger) {}

  send(message: MailMessage): Promise<MailSendResult> {
    this.sent.push(message);
    this.log.warn('mail_noop', {
      provider: 'noop',
      subject: message.subject,
      recipient_domain: message.to.split('@')[1] ?? 'unknown',
    });
    return Promise.resolve({ ok: true, id: null });
  }
}
