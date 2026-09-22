/**
 * The per-ADDRESS ceiling on magic-link mail, shared by the gate (which reads it) and the
 * sender (which bumps it). It counts mail that actually left the Worker, never requests: a
 * stranger's requests are refused by the owner budget and the requester brake without ever
 * touching it, so no number of requests with zero mail can lock an address out.
 *
 * Subjects are keyed by a CANONICAL mailbox, not the literal address: `victim+a@` and
 * `victim+b@` are one inbox, and so are `vic.tim@gmail.com` and `victim@googlemail.com`. Better
 * Auth still receives the literal address the caller sent.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { type Db, usageCounters } from '@planeahead/db';
import { sha256Hex } from '../crypto/hash';

/** The address ceiling: one inbox, every requester combined, mail actually sent. */
export const MAGIC_LINK_ADDRESS_HOUR_CAP = 10;
export const MAGIC_LINK_ADDRESS_DAY_CAP = 30;
export const MAGIC_LINK_COUNTER = 'magic_links';
export const MAGIC_LINK_SCOPE = 'email';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface MagicLinkWindows {
  readonly hourStart: string;
  readonly dayStart: string;
}

export function windowsAt(nowMs: number): MagicLinkWindows {
  return {
    hourStart: new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS).toISOString(),
    dayStart: new Date(Math.floor(nowMs / DAY_MS) * DAY_MS).toISOString(),
  };
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The inbox an address delivers to, as far as it can be known without the provider: lower
 * case, a `+tag` dropped from the local part for every domain (a conservative
 * over-approximation: two people cannot share a local part on one domain, so folding tags can
 * only merge one person's aliases), and for Gmail the dots dropped and googlemail folded.
 */
export function canonicalMailbox(email: string): string {
  const lower = normaliseEmail(email);
  const at = lower.lastIndexOf('@');
  if (at <= 0) {
    return lower;
  }
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) {
    local = local.slice(0, plus);
  }
  if (domain === 'googlemail.com') {
    domain = 'gmail.com';
  }
  if (domain === 'gmail.com') {
    local = local.replaceAll('.', '');
  }
  return `${local}@${domain}`;
}

export interface CounterSubjects {
  readonly scope: string;
  readonly hour: string;
  readonly day: string;
}

/** The two rows the ceiling lives in for one inbox. */
export async function addressCeilingSubjects(email: string): Promise<CounterSubjects> {
  const address = await sha256Hex(canonicalMailbox(email));
  return { scope: MAGIC_LINK_SCOPE, hour: `${address}:hour`, day: `${address}:day` };
}

export interface CeilingReading {
  readonly hour: number;
  readonly day: number;
  readonly reached: boolean;
}

/** Reads the ceiling without touching it. Missing rows read as zero. */
export async function readAddressCeiling(db: Db, email: string): Promise<CeilingReading> {
  const subjects = await addressCeilingSubjects(email);
  const rows = await db
    .select({ subject: usageCounters.subject, count: usageCounters.count })
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.scope, subjects.scope),
        eq(usageCounters.counter, MAGIC_LINK_COUNTER),
        inArray(usageCounters.subject, [subjects.hour, subjects.day]),
      ),
    );
  const countOf = (subject: string): number =>
    rows.find((row) => row.subject === subject)?.count ?? 0;
  const hour = countOf(subjects.hour);
  const day = countOf(subjects.day);
  return {
    hour,
    day,
    reached: hour >= MAGIC_LINK_ADDRESS_HOUR_CAP || day >= MAGIC_LINK_ADDRESS_DAY_CAP,
  };
}

/** Bumps the ceiling by one for a mail that was accepted by the provider. */
export async function recordMagicLinkSent(db: Db, email: string, nowMs: number): Promise<void> {
  const subjects = await addressCeilingSubjects(email);
  const { hourStart, dayStart } = windowsAt(nowMs);
  await db
    .insert(usageCounters)
    .values([
      {
        scope: subjects.scope,
        subject: subjects.hour,
        counter: MAGIC_LINK_COUNTER,
        windowStart: hourStart,
        count: 1,
      },
      {
        scope: subjects.scope,
        subject: subjects.day,
        counter: MAGIC_LINK_COUNTER,
        windowStart: dayStart,
        count: 1,
      },
    ])
    .onConflictDoUpdate({
      target: [
        usageCounters.scope,
        usageCounters.subject,
        usageCounters.counter,
        usageCounters.windowStart,
      ],
      set: { count: sql`${usageCounters.count} + 1` },
    });
}
