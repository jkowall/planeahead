/**
 * FlightTracker schema, migration 3 (increment 15, notification policy). Append only.
 *
 * `flight.policy_state`: the notification policy's persisted `PolicyState` (JSON, versioned by
 * its own `v`; `packages/shared/src/notification-policy.ts`). A column on the one flight row
 * rather than a table of its own because the alarm already rewrites that row with every snapshot
 * it stores: the state rides on the same UPDATE and costs no row written (rows written are the
 * budgeted per-flight cost, ADR 0011). The tracker seeds it with `initialPolicyState` at
 * creation, and again from the stored snapshot whenever it reads NULL (a tracker created before
 * this migration) or a layout this build cannot read. The `notify_intent` outbox rows the policy
 * produces are guarded by the existing `notif_dedupe` table (migration 001).
 */

export const FLIGHT_TRACKER_MIGRATION_003: readonly string[] = [
  'ALTER TABLE flight ADD COLUMN policy_state TEXT',
];
