# Architecture decision records

One file per decision, MADR style, numbered in the order the decision was taken. Copy
[0000-template.md](0000-template.md), give it the next free number, and never renumber or rewrite
history: a decision that turns out wrong gets a new ADR that supersedes the old one, and the old
one moves to status `Superseded by NNNN`.

Statuses: `Proposed`, `Accepted`, `Rejected`, `Deprecated`, `Superseded by NNNN`.

A decision belongs here when reversing it would cost more than a day, when it constrains later
increments, or when a reviewer would otherwise ask "why not the obvious alternative". Everything
else belongs in a code comment.

## Index

| ADR                      | Title    | Status |
| ------------------------ | -------- | ------ |
| [0000](0000-template.md) | Template | n/a    |

The Phase 0 plan lists the ADRs due in later increments: 0001 Expo, 0002 Neon not D1, 0003 flight
key, 0004 Hono RPC, 0005 identifiers, 0006 uuidv7, 0007 Durable Objects never open Postgres
(every DO write goes through the persist queue), 0008 expo-widgets. Their rationale is already written up in
[docs/plans/phase0-plan.md](../plans/phase0-plan.md) section 3; each increment lifts the relevant
row into its own ADR.
