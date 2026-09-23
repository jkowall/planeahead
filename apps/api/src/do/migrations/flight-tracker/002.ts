/**
 * FlightTracker schema, migration 2 (increment 7, final re-review round). Append only.
 *
 * `outbox.dead_letter_count` and `outbox.last_dead_lettered_at_ms`: how many times the persist
 * queue dead-lettered the row, and when it last did. The dead-letter consumer reports a
 * dead-lettering (`confirmPersisted` with `deadLettered: true`) and never confirms: a message
 * dead-letters after five consumer retries spanning about a minute, which a transient Postgres or
 * Hyperdrive outage exceeds as easily as a poison row does, and a confirmed row is deleted. The
 * flush re-sends a stamped row after `deadLetterResendSpacingMs` of its count (one hour, doubling
 * to a 24 hour cap) measured from the later of its last dead-lettering and its last send; a row
 * never dead-lettered keeps the `OUTBOX_RESEND_GRACE_MS` rule (ADR 0011 item 5).
 */

export const FLIGHT_TRACKER_MIGRATION_002: readonly string[] = [
  'ALTER TABLE outbox ADD COLUMN dead_letter_count INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE outbox ADD COLUMN last_dead_lettered_at_ms INTEGER',
];
