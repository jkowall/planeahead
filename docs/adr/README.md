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

| ADR                                | Title                                                  | Status   |
| ---------------------------------- | ------------------------------------------------------ | -------- |
| [0000](0000-template.md)           | Template                                               | n/a      |
| [0001](0001-expo.md)               | Expo SDK 57, CNG, three variants, pnpm isolated        | Accepted |
| [0002](0002-neon-not-d1.md)        | Neon Postgres 18 through Hyperdrive, not Cloudflare D1 | Accepted |
| [0003](0003-flight-key.md)         | Flight identity: the canonical flight key              | Accepted |
| [0004](0004-hono-rpc.md)           | Hono with an exported RPC type as the API framework    | Accepted |
| [0005](0005-identifiers.md)        | App identifiers, links, the install and analytics ids  | Accepted |
| [0006](0006-uuidv7.md)             | UUIDv7 primary keys generated in `@planeahead/shared`  | Accepted |
| [0007](0007-do-postgres-free.md)   | Durable Objects never open Postgres                    | Accepted |
| [0008](0008-expo-widgets.md)       | Native surfaces: expo-widgets, watch shells, smoke     | Accepted |
| [0009](0009-postgres-js-driver.md) | postgres.js as the single Postgres driver              | Accepted |
| [0010](0010-provider-identity.md)  | Provider identity: operator resolution and merge path  | Accepted |
| [0011](0011-alarm-idempotency.md)  | Alarm idempotency: attempt row, retry ladder, outbox   | Accepted |
| [0012](0012-sync-cursor.md)        | The sync cursor: an xid8 watermark over two tables     | Accepted |

0003 (flight key) and 0006 (uuidv7) were written in increment 2; 0002, 0007 and 0009 in
increment 3; 0004 in increment 4; 0010 (provider identity) in increment 6, which also amended 0003;
0011 (alarm idempotency) in increment 7, which also amended 0007 with its third reason; 0012 (sync
cursor) in increment 8; 0001 (Expo) and 0005 (identifiers) in increment 9; 0008 (expo-widgets,
the watchOS shells, the Android stubs and the native smoke, with the increment's spike
results) in increment 11, which the Phase 0 plan had reserved its number for, amended by the
increment's review round (the content-state bounds, the Android autolinking exclusion, the watch
icon, the extension's Release settings and the token lifecycle gate on the Phase 1 sender).
Increment 13 (the store pipeline) amended 0001 (the pinned EAS images, the held Sentry upload,
`APPLE_TEAM_ID`), 0005 (the stores' own statements that the identifiers are permanent) and 0008
(the extensions' privacy manifests and versions, the smoke's store checks and device archive).
