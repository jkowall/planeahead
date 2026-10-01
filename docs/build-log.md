# Build log

One row per increment. Tokens and wall-clock are filled in by the orchestrator after the
increment is reviewed.

| Increment                                           | Model                                                                     | Tokens                                                                                                                                                                                                                                                                                                                                                                                  | Wall-clock                                                                                                                                                                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Repo skeleton                                    | Opus 5 build, Fable 5.1 read                                              | build agent: not recorded (workflow failed at the session usage limit before its review stage; agent transcript 557 KB)                                                                                                                                                                                                                                                                 | ~1 h build, ~75 min close-out (of which ~15 min was a GitHub push stalled by the VPN route)                                                                                                                                                    | pnpm 12 + Turborepo 2.11 workspace, strict TS 6.0, ESLint 9 flat + Prettier 3, Vitest 4.1 in shared/db/api, local `planeahead/no-module-scope-drizzle` rule with a RuleTester unit test, Renovate, CODEOWNERS, ADR template, CI (typecheck, lint, test, toolchain guard). No Cloudflare or Expo dependency. Orchestrator close-out: regenerated the lockfile (the builder's install was interrupted and left a truncated file), `prettier --write` on 5 files the builder never formatted, `.gitignore` exceptions for `.env.example` and `.dev.vars.example`, ADR index wording for 0007. Verified: `pnpm install --frozen-lockfile`, `turbo run typecheck lint test --force` (11/11), `prettier --check`, toolchain guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2. Shared contracts                                 | Fable 5.1 build and fixes, Opus 5 review panel                            | Fable ~970k output (build 714k incl. two stalled restarts, fix rounds 160k + 94k); Opus ~620k (two reviewers 365k, twelve skeptics 139k, two re-reviews 115k)                                                                                                                                                                                                                           | ~4.5 h from launch to final commit, of which ~1 h was API and GitHub stalls on the VPN                                                                                                                                                         | `packages/shared`: uuidv7, flight key (ADR 0003), Zod 4 boundary schemas, provider interfaces, cost table, cadence engine with the SLO table and a simulation that derives every constant, RPC and sync envelopes, Live Activity state, secret patterns; `docs/architecture.md` generated from code with a drift test; ADR 0003 and 0006. Review: 15 findings (10 API design, 5 correctness), every blocker and major sent to two Opus skeptics (spec lens refuted 4 as deliberate spec choices, reproduction lens confirmed all real defects), 17 items fixed, re-review found 3 regressions in the fixes (fixed in round 2, re-verified by execution), orchestrator closed the 20-minute pre-boarding hole the honest report exposed. Derived constants: A2 74 polls / 122 PE / $0.61 list (plan wrote 72 / 120 / $0.60 under a round() slot rule), A1 84, literal 181, B 5; AeroDataBox 2 / 24 / 40 units at 3 / 14 / 30 days (plan wrote 4 / 26 / 42). 387 tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 3. Database schema                                  | Fable 5.1 build and fix, Opus 5 review panel                              | Fable ~900k (build 448k, fix 455k); Opus ~2.1M (two reviewers 577k, fourteen skeptics ~1.3M, re-review 232k); orchestrator close-out on top                                                                                                                                                                                                                                             | ~1 h 55 min workflow plus ~50 min close-out                                                                                                                                                                                                    | `packages/db`: 70 tables in 9 schema files (the plan's 61 undercounted the spec's normative list), migration 0000 plus a generated set_updated_at migration with no-op WHEN guards, embedded PostgreSQL 18.4 harness (initdb 3.2 s cold, 0.6 s warm; skipped when TEST_DATABASE_URL is set, which is how CI's postgres:18 service container is used), withDb and createNodeDb, a URL-only migrator with pooler and version guards, seed loaders with a Content-Length and SHA-256 manifest and IANA-checked timezone overrides (739 accepted, 5 rejected and listed), schema-review.md, ADR 0002, 0007, 0009. Review: 19 findings, 7 serious ones sent to two skeptics each (spec lens refuted 4 as deliberate choices, reproduction lens confirmed every physical defect), 22 items fixed, re-review confirmed each by execution and left 4 nits, all applied in the close-out along with two forward-looking columns increments 6 and 7 need. 166 tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 4. API Worker bootstrap                             | Opus 5 build and first fix, Fable 5.1 escalation fix, Opus 5 review panel | Opus ~2.6M (build 732k, two reviewers 469k, sixteen skeptics ~1.3M, fix 568k, two re-reviews 403k); Fable 238k (escalation fix); orchestrator close-out                                                                                                                                                                                                                                 | ~3 h 20 min workflow plus ~30 min close-out                                                                                                                                                                                                    | `apps/api`: chained Hono app with `AppType`, six-stage middleware chain registered from a slot list the test observes, `/health` with the generated migration hash and compiled-in DO schema versions, five Durable Object shells over a `_sql_schema_migrations` runner (PRAGMA user_version is unavailable in DO SQLite), `wrangler.jsonc` with `exports` plus per-environment bindings and distinct ratelimit namespace ids, queue consumers that ack per message with a guarded 200-point Analytics Engine budget, cron handlers, Sentry with request-id tagging and scrubbing on both the error and transaction paths, staging deploy workflow, wrangler dry-run and toolchain pair guard in CI, ADR 0004. Spikes: `exports` works under wrangler dev and the Vitest pool; a test-scheduled alarm fires on its own wall clock (the afterEach drain is mandatory); the rate-limit binding enforces in the pool. Review: 23 findings, 8 serious ones sent to skeptics (spec lens refuted 3, reproduction lens confirmed 7), Opus fixed 22; the re-review found the idempotency scope still wrong and a vacuous migration-hash check, so the escalation rule sent the second round to Fable (anonymous idempotency now scoped by a client-owned `X-Install-Id`, the ordering guard made real, the chain constant derived from registration); the final re-review left one minor and two nits, applied in the close-out. 129 api tests, 693 total.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5. Auth, envelope encryption, mail, devices         | Fable 5.1 build and both fix rounds, Opus 5 review panel                  | Fable ~1.85M (a first build attempt of 510k stopped at the usage limit and was continued, continuation build ~500k est., fix rounds 561k and 273k); Opus ~2.4M (two reviewers and sixteen skeptics ~1.9M est., the interrupted run wrote no summary; two re-reviews 532k); orchestrator close-out                                                                                       | ~6 h across two days (one usage-limit stop, one deliberate stop to inject rulings before the fix)                                                                                                                                              | Better Auth 1.7.5 (`better-auth/minimal`, 104 KiB gzip smaller) built per request and fail closed (rate limiting on, secret asserted, `cf-connecting-ip`), five-key schema subset, UUIDv7 ids, Expo server plugin; native Apple and Google sign-in as plugin endpoints under `/sign-in/*` (no provider tokens handed to Better Auth, Apple refresh token envelope-encrypted, code exchange bound to the identity token's subject, nonce required, Google `azp` and `email_verified` enforced, used-token replay guard in KV); idempotent anonymous merge with a row lock and status marker, bound to the magic-link requester; envelope encryption (AES-KW wrapped per-user DEK, AES-256-GCM with cell AAD); Resend sender with a digest idempotency key; non-consuming magic-link landing page plus a consume route; a two-key magic-link gate (owner budget, per-inbox ceiling counting sent mail, NAT-scale requester brake, canonical mailbox); devices and me routes; the embedded Postgres 18 harness wired into the Workers pool. Review: 21 findings (2 blockers: cap bypass via keyed requests, login-CSRF merge); 8 serious ones confirmed by reproduction skeptics; 14 orchestrator rulings injected before the fix; two fix rounds and two re-reviews; the last three findings applied in the close-out. 292 api tests, 865 total.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6. Provider layer                                   | Opus 5 build and fix, Opus 5 review panel, Fable 5.1 close-out            | Opus ~2.5M (build, two reviewers and twelve skeptics ~1.62M as the resumed run's counter reported them; a first fix attempt ~550k est., stopped to inject rulings; fix 269k; re-review 77k); orchestrator close-out                                                                                                                                                                     | ~4 h workflow across the day (one deliberate stop at the fix boundary to inject rulings I1 to I7; the resumed fix and re-review 52 min) plus ~1 h close-out                                                                                    | Shared amendments first (nine alert events, the 18 AeroAPI event codes, `flight_by_canonical` and airport arrivals/departures prices, `operatorSource` and the marketing designator on `FlightStatus`, the weekly end-anchored pre-48h cadence with 1 / 2 / 4 AeroDataBox calls at 3 / 14 / 30 days and the inside-48h counts unchanged, `deriveStatus`, `disambiguateRevisedTime`, `resolveOperator`, `parseAdbDateTime` and the Analytics Engine point shape as table-tested pure functions); both OpenAPI snapshots vendored with SHA-256 pinned in tests and every fixture checked against its schema; the AeroDataBox adapter (X-Api-Key, 204 never parsed, 451 terminal, 429 / 503 / HTML as `rate_limited` at zero cost with the reservation released, `.utc` times only, `dateLocalRole=Departure`, operator resolution, FIDS, the free health check, webhook parsing behind `ADB_ALERTS_ENABLED`); the mocked AeroAPI adapter (bracketed first fetch then `fa_flight_id` with `max_pages=1`, diversions as two items, the account endpoint PUT before the first alert plus a mandatory per-alert `target_url`, 201 Location id, deliveries merged onto the last snapshot, every non-200 billed); router with the T-48h gate defined as "the bracket contains the flight"; cost logger with the Durable Object outbox path and the direct `withDb` path; budget guards, the pure token bucket and a real ProviderBudget object (ledger, cap, rate, kill switch persisted in CONFIG KV, 70 / 90 / 100 ladder, background KV copy, 00:05 UTC alarm that finalises and `deleteAll()`s, read-only closed day); webhook receivers on 256-bit path tokens (404 on a wrong one, enqueue only, exempt from the IP limiter, token redacted from Sentry); ADR 0010, the ADR 0003 amendment, threat model 3.1. Review: 23 findings (1 blocker: the AeroAPI bracket at exactly T-48h excluded the flight and would have returned the previous day's instance; 5 majors), 6 serious ones confirmed by twelve skeptic verdicts (0 refuted), seven rulings injected before the fix, Opus applied all 24 items; the re-review found nothing serious (one minor, two nits: the DST-gap conversion fixed and the recovery-timing comment corrected in the close-out, the bucket split kept with the reasoning recorded in `token-bucket.ts`). 509 api tests, 1232 total.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7. FlightTracker and DesignatorResolver             | Fable 5.1 build and fix, Opus 5 review panel, Fable 5.1 close-out         | Fable ~1.0M est. (build, three fix rounds of about 550k, 150k and 120k; the cumulative counter rose 1.61M over the increment, of which the build, both review lenses, sixteen skeptics and the first fix and re-review were 1.21M); Opus ~0.6M est. (two reviewers, sixteen skeptics, three re-reviews of 72k and 66k for the last two); orchestrator close-out                         | ~7 h across the night (build 70 min; review and verify 40 min; fix rounds of about 2 h, 55 min and 35 min with three re-reviews; two deliberate stops to inject rulings and one accidental restart caught within a minute) plus ~1 h close-out | Spikes first (`setAlarm` inside `transactionSync` rolls back with the transaction, and inside a scheduler-invoked handler a rolled-back `setAlarm` leaves the running alarm's stale time visible; a 200 ms alarm fires on its own wall clock under the pool; a rejected `waitUntil` promise inside `alarm()` neither fails the invocation nor triggers a retry, while a bare floating rejection fails the vitest run; foreign keys are ON). FlightTracker on the migrations-table runner: the five-step idempotent alarm (one `transactionSync` before any I/O holding the attempts row, the per-flight budget debit, the outbox intent and an un-awaited `setAlarm`; retry decisions from the committed schedule; the `retryCount >= 5` backstop that never overwrites the grid; the fetch behind an in-flight handle that `subscribe`, `forceRefresh`, `ingestProviderEvent` and the alarm itself join, with a 30 s `AbortSignal.timeout`; the apply transaction with `reconcileFlightKey`, a monotonic version and outbox rows; byte-chunked flushes; rows deleted only on the persist consumer's `confirmPersisted` RPC; the debounced KV snapshot with a load-bearing pending flag; the finish path with a per-lifetime R2 archive and a +22 h alarm that deletes only once every row is confirmed); the DesignatorResolver (50 concurrent resolves, one call; `seed` hands the fetched status to the tracker so the first alarm never repeats it; a flight that is over is answered without creating a tracker; 24 h expiry that never discards unsent rows); the persist consumer (validated `PersistMessageV1` union, monotonic `flight_instances` upsert with the new `do_lifetime_epoch_ms` column from migration 0002, idempotent events and provider calls, one Analytics Engine point per inserted call, per-shard `budget_daily` rows); one dead-letter handler with R2 archive and retries; the reconcile cron and queue (overdue and NULL `next_refresh_at` rows, stale in-flight cutoff); ADR 0011, ADR 0007 amended. Measured: 74 provider calls per A2 lifecycle flight; 1,200 rows written per flight including the schema DDL (13 per unchanged alarm, 16.2 average) against a 1,600 budget; largest outbox message 1,635 bytes. Review: 24 findings (8 blockers: refresh paths never finished a flight, a final-slot retry landed in `skip_io` and abandoned the tracker, both `deleteAll` paths could discard unsent outbox rows, a re-seed after `deleteAll` collided on `flight_events` and overwrote the archive; 5 majors), 8 sent to skeptics (14 of 16 verdicts real; the two spec-lens refutations were overruled by rulings), eighteen rulings injected at the fix boundary, Fable applied all 24 findings and every ruling; the re-review found two majors (the resolver still seeded a second lifetime for a diverted or uncovered past flight; vitest exiting 0 on failures) and three minors, answered by six second-round rulings and a second Fable round; the final re-review found that one of those rulings (the dead-letter handler confirming persist messages) lost tracker rows on a transient outage, reversed in a third Fable round under rulings N1 to N5; the third re-review found no blocker or major (a latch-ordering flake in one test, about 0.5 percent under load, and a garbled ADR paragraph, both applied in the close-out). 593 api tests, 1343 total.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 8. Flight routes, sync feed, caps, account deletion | Opus 5 build and fix, Opus 5 review panel, Fable 5.1 close-out            | Opus ~1.35M est. (build, two reviewers and sixteen skeptics, first fix and re-review ~1.12M as the resumed run's counter reported them; second re-review 79k; third-round fix 74k and re-review 77k); Fable ~52k (the second-round fix); orchestrator close-out                                                                                                                         | ~5 h (build 80 min; reviews and verify 50 min; fix rounds of 40 min, 6 min and 30 min with three re-reviews of about 30 min each; two deliberate stops to inject rulings) plus ~45 min close-out                                               | The user-facing flight API on the increment 7 objects: search (KV, then `flight_designators`, then the resolver), subscribe with caps and idempotency, list, detail, unsubscribe and a coalesced refresh with an 8 s deadline (504 with the last known state, the object keeps working); a second idempotency instance under `/v1` (IETF semantics: replay with `Idempotent-Replayed`, 409 in flight, 422 payload mismatch, 4xx persisted, a 60 s in-flight lease); free-tier caps as single `INSERT ... ON CONFLICT DO UPDATE ... WHERE count < cap` statements in `usage_counters` (20 concurrent subscribes admit exactly 5), `live_tracked` charged where a flight enters its 48 h window and released where it leaves; the xid8 sync feed over `user_sync_changes` and the new `flight_sync_changes` (written by the persist consumer in its upsert transaction), `EXPLAIN` showing the `(user_id, xid, seq)` index driving the row-value comparison, a real late-commit test, an opaque cursor bound to the user hash and a database epoch, an exact 410 horizon from a stored purge horizon, a no-cursor snapshot page; the anonymous-merge consumer (change rows for everything the merge touches, tracker subscriber lists re-pointed); synchronous account deletion (read, unsubscribe, best-effort Apple revoke, one short ordered transaction with a documented per-table fate, late subscribes undone, 401 `account_deleted` for other devices with the cookie cache disabled under `/v1`); the envelope on every validator and `HTTPException`; typed `AppType` responses and a pre-compiled client whose declaration a consumer without Workers globals can type-check; `secrets.required` per environment; migration 0003; ADR 0012. Review: 22 findings (2 blockers: the merge wrote no change rows and the cursor was not bound to a user; 10 majors), 8 sent to skeptics (15 of 16 verdicts real; the one spec-lens refutation overruled by a ruling), fourteen rulings injected at the fix boundary, Opus applied all 22 findings and every ruling; the re-review found the subscribe compensation still racing a retry that joined the same provider fetch (major) plus a deletion window and a flaky test, answered by four second-round rulings and a Fable round; the final re-review found two minors those fixes introduced (a lock-order inversion in deletion step 4, a deleted-user orphan after a timed-out subscribe), closed in a third Opus round under rulings R1 to R3; the third re-review found no blocker or major: one minor (in natural timing the deadlock aborted the writer, not the deletion, so the retry rarely ran) applied in the close-out with the reviewer's validated lock-timeout variant, and one pre-existing nit handed to increment 12. 687 api tests, 1452 total.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 9. Mobile scaffold                                  | Opus 5 build and fix, Opus 5 review panel, Fable 5.1 close-out            | Opus ~1.55M est. (build, two reviewers and fourteen skeptics, first fix and re-review ~1.29M as the resumed run's counter reported them; second re-review 83k; the tokens of the first stopped fix attempt not counted); Fable ~128k (the second-round fix); orchestrator close-out                                                                                                     | ~6 h (build 75 min with the native compiles; reviews and verify 45 min; fix rounds of 55 min and 35 min with two re-reviews of about 40 min each; two deliberate stops to inject rulings) plus ~1 h close-out                                  | `apps/mobile` as a real Expo SDK 57 app in the pnpm 12 isolated workspace, spikes first: `expo prebuild`, the iPhone 17 Pro simulator compile and the Android `assembleDebug` all pass under `nodeLinker: isolated` with no hoisting (three resolution problems fixed in place: peers auto-installed outside the SDK 57 manifest, build phases requiring packages from `apps/mobile`, a missing config plugin), the Hono client's async `headers` is evaluated per request, and an Android FCM token read needs `google-services.json`. Expo Router `(auth)` and `(app)` groups with the universal-link route; the Better Auth Expo client over SecureStore with anonymous first launch, in-app magic-link verification bound to this install's own request, native Apple (sha256 nonce, `identityToken` body, no credential-state call on Simulator) and native Google (configure before every sign-in, the Android ladder); the `/v1` client from the pre-compiled declaration; the expo-sqlite store (snapshot denormalised onto `flight_subscriptions`, `sync_state`, `outbox`), Drizzle migrations inlined by Babel so Metro stays `getSentryExpoConfig`, page apply in one immediate transaction with the cursor, reset on any 410 completed by the snapshot page, a FIFO outbox that re-keys on 422, a live-query hook driven by a store signal; settings over `expo-sqlite/kv-store`; Sentry with `sendDefaultPii` false, no replay, native network breadcrumbs off and URL, query, fragment, Referer and body scrubbing proven by a mutation-checked test; analytics on an install-scoped id; the well-known AASA and assetlinks routes on the API (the only API change); `eas.json` profiles, `mobile-preview.yml` guarded on `EXPO_TOKEN`, the `test-mobile` CI job; ADR 0001 and ADR 0005. Device: the development build launches on the iPhone 17 Pro simulator, migrates the real store and reaches the sign-in screen; no API is reachable (staging has no DNS, `wrangler dev` needs a Neon branch), so the auth flows are Jest-proven with mocked transports and the on-device acceptance is pending with the exact commands in `apps/mobile/README.md`; the Pixel AVD waits for the owner to accept its adb prompt. Review: 17 findings (1 blocker: native iOS Sentry breadcrumbs carried the raw magic-link query string past the JS scrubbers; 6 majors: PR updates published under a runtime version no build had, MapLibre autolinking location permissions, a coalescer that only merged same-task events, auto-verify unbound from the install's own request and reachable through the custom scheme, a 410 wiping the store before the snapshot arrived, strict page validation that would stall old clients), 7 sent to skeptics (12 of 14 verdicts real; the two spec-lens refutations overruled by rulings), nine rulings injected at the fix boundary, Opus applied all 17; the re-review found one residual major (a file variable the update cannot read still entered the runtime version) and two minors (iOS keeps only the first URL a process received, a no-cursor pull deleted optimistic rows), answered by four second-round rulings and a Fable round; the final re-review found no blocker or major: one minor (a kept optimistic row could sit next to the server's row for the same flight) and one nit (no runtime-version check in the preview workflow), both applied in the close-out. 216 mobile Jest tests, 1693 total.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 10. Home, add flight, detail                        | Opus 5 build and fix, Opus 5 review panel, Fable 5.1 close-out            | Opus ~0.76M (input plus output tokens as the agent transcripts record them, cache reads excluded, a different basis from the earlier rows' run counters: build 288k, two reviewers 139k, ten skeptics 50k, fix 192k, re-review 88k, second-round fix 91k and re-review 69k; the harness usage counter reported 497k for the second round alone); no Fable agent; orchestrator close-out | ~3 h 10 min (build 62 min; reviews and skeptics 23 min; fix 58 min and re-review 16 min; second round 31 min; one deliberate stop to inject rulings) plus ~45 min close-out                                                                    | The three screens of the runnable milestone on the increment 9 scaffold: the next-flight home (next flight by scheduled departure skipping arrived, cancelled and finished flights; a status pill from `FLIGHT_STATUS_VALUES`, gate and terminal, a one-minute countdown owned by the component; the rest of the list; an empty state), the add-flight modal (shared `parseDesignator` and `IsoDateSchema` validation; the optimistic row and its `POST /v1/flights` written in one commit with a client uuidv7 id the server receives; 201 writes the server row and snapshot at once; 200 `created: false` swaps the optimistic row for the server's id through the new outbox `onSent` hook; 403 shows the cap from the payload; 404 names the tried dates; 422 re-keys), the detail screen (the timeline from the snapshot on the row: out, off, on and in with scheduled, estimated and actual times, gates, terminals, baggage, aircraft, provider attribution; a direct per-flight refresh once per gesture with the 8 s deadline UX, both 504 codes applying the last known flight, 410 marking the flight finished locally, a snapshot never rolled back; unsubscribe as a tombstone plus a queued DELETE), units and time-format toggles queued as preference patches, light and dark theme tokens with a WCAG AA contrast test, a pure `format.ts`. The home pull-to-refresh syncs only, to spare the per-flight daily refresh budget. Measured: one re-render per applied 200-row page through the real apply path and the store signal; one provider call and one `provider_calls` row for two accounts subscribing to the same flight through the real Worker, DesignatorResolver, FlightTracker and persist consumer (`flights.two-accounts.test.ts`); one refresh call per gesture. Device: the seeded home rendered on the iPhone 17 Pro simulator and on the Pixel AVD in light and dark, and again from the persisted store with no API reachable; every step that needs an API is pending in `docs/increments/10-verification.md`. Review: two Opus 5 lenses (offline data flow and outbox correctness; screens and contract correctness) raised 17 findings (1 blocker, 5 majors), 10 of 10 skeptic verdicts real, all 17 applied by Opus under seven rulings; the re-review found no blocker or major, two minors and three nits closed in a second Opus round (rulings Y1 to Y6); the second re-review found one nit (the outbox gate read `isConnected` while the reconnect drain reads `isInternetReachable`, so a validated Android network on an unclassified transport could stall queued writes), fixed in the close-out. 521 mobile Jest tests, 1999 total.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 11. Native surface shells and nightly smoke         | Opus 5 build and fix, Opus 5 review panel, Fable 5.1 close-out            | Opus ~0.73M (input plus output tokens as the agent transcripts record them, cache reads excluded: build 287k, two reviewers 165k, four skeptics 21k, fix 175k, re-review 79k; the harness usage counter reported 718k for the resumed run); no Fable agent; orchestrator close-out                                                                                                      | ~2 h 20 min (build 64 min with the spikes and both native compiles; reviews 18 min and skeptics 3 min; fix 35 min and re-review 19 min; one deliberate stop to inject rulings) plus ~45 min close-out                                          | Compiling shells for every native surface Phase 1 and 2 will fill, spikes first and all three resolved: expo-widgets 57.0.20's widget bundle resolves under the pnpm 12 isolated linker with no workaround (expo/expo#49752 did not reproduce; its bundle scripts reach two devDependencies only through pnpm's hidden hoist, which ADR 0008 records as a fragility); `@bacons/apple-targets` 5.0.0 coexists with expo-widgets in one prebuild on Xcode 27 (four targets, the watch app and complication built for watchOS and embedded under `Watch/`, the app alive after launch, the same project whichever plugin is listed first; passed in 20 minutes of the two-hour box, so the watch shells ship); Expo SDK 57 builds against compileSdk and targetSdk 36, where `setRequestPromotedOngoing` and `POST_PROMOTED_NOTIFICATIONS` do not exist yet (API 36.1), so the ongoing-notification stub calls androidx.core 1.17.0's compat builder behind an SDK_INT check and is never invoked. One placeholder widget and the flight Live Activity layout (created with `createLiveActivity`, not in `widgets[]`; a test evaluates the compiled `'widget'` strings in a vm holding only the widget runtime's globals); the push-to-start token posted to `POST /v1/devices` under the new kind `apns_live_activity_push_to_start` (migration 0004 widens the check constraint, `DB_SCHEMA_VERSION` 5, one route test; the only API change) and per-activity tokens logged as the activity id only; `LiveActivityContentStateV1` gains optional designator, IATA codes and destination gate and terminal with the worst case measured with the double encoding; the Android ongoing-notification stub and a Compose for Wear OS module with one Tile added by `withWearApp.ts` with pinned versions. Key finding: a plain `withEntitlementsPlist` listed last still loses to expo-widgets' literal `development`, because config-plugins runs the last-listed mod first; `withApsEnvironment` registers a base mod that runs the rest of the chain first and writes `aps-environment` on the way out, proven per EAS profile by `entitlements.test.ts` (it fails against the plain version). Nightly `native-smoke.yml` (an Xcode 26.6 gate leg and an Xcode 27 leg with `continue-on-error`, Android on ubuntu with JDK 17 and an API 36 emulator), every step in `scripts/native-smoke.sh`; all steps passed on this machine including both launch gates. Observed on the Simulator: a push-to-start token is issued within 25 s. Unverified: the Xcode 26.6 leg, the workflow on GitHub runners, device-signed archives, the watch shells on a watchOS runtime, the app's own registration end to end (no API reachable). Review: two Opus 5 lenses (build-system correctness; contracts and safety of the shells) raised 11 findings (2 majors: the runtime fingerprint ignored the watch and Wear sources, the embedded watch app had no icon; 7 minors, 2 nits), 4 of 4 skeptic verdicts real, twelve rulings injected at the fix boundary, all 11 applied by Opus in one round; the re-review found no blocker or major, two nits (the Android permission allowlist ignored the `uses-permission-sdk-23` form; stale fingerprint hashes in the verification doc), both applied in the close-out. 604 mobile Jest tests, 2108 total.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 12. Docs, admin, crons, production deploy           | Opus 5 build and fix, Opus 5 review panel, Fable 5.1 close-out            | Opus ~0.95M (input plus output tokens as the agent transcripts record them, cache reads excluded: build 418k, two reviewers 201k, four skeptics 18k, fix 183k, re-review 79k, second re-review 54k; the harness usage counter reported 514k for the last resumed run alone); Fable ~107k (the escalation round); orchestrator close-out                                                 | ~3 h 10 min (build 82 min; reviews 22 min and skeptics 1 min; fix 33 min and re-review 15 min; Fable round 21 min and re-review 11 min; two deliberate stops to inject rulings) plus ~45 min close-out                                         | Phase 0's last increment: every promise made in prose becomes a document, a cron or a deploy path. The daily cron only plans: one message per housekeeping step to a new `planeahead-housekeeping` queue with its DLQ in all three environments (idempotency keys; the sync purge by xid under ONE horizon, the smallest xid among rows younger than 30 days across both change tables, never above `pg_snapshot_xmin`, never backwards, both deletes and the `sync_horizon` row in one transaction under `FOR UPDATE`, proven against the late-commit inversion and the real route's 410; `provider_calls` older than 90 days only for days with a rollup row; retention; `usage_counters` repair with the drift logged per user; tracker subscriber reconciliation through the FlightTracker's one new RPC `listSubscribers` with grace windows in both directions and the merged anonymous users deleted after their grace; DLQ replay; session tombstones; KEK re-wrap) plus two Analytics Engine rollup messages (`SUM(_sample_interval)` per provider per day, `budget_daily` excluded from every sum); each message has a 30 s wall budget with continuations and writes one `audit_log` row with counts. The admin page behind Cloudflare Access (RS256 against the team's JWKS through an injected fetch with a cache; any failure an empty 403; server-rendered, strict CSP): provider calls per flight and per provider per day, Durable Object schema versions, the watermark lag, queue depths through the Cloudflare API when a token exists, horizon and epoch, the last housekeeping rows. `deploy-production.yml` verifies on a `v*` tag and deploys only from a manual run whose confirmation names the tag, migrating against the Neon direct endpoint before a plain `wrangler deploy --env production` and smoking `/health` for this build's migration hash and Durable Object versions through a shared script that staging now uses too. The static Google Play deletion page, `POST /v1/events` matching the increment 9 client (per-event validation, `202 {accepted, dropped}`), `APPLE_BUNDLE_IDS` as a list with the token's own `aud` as client id, the resolver stamping every attempt record of a search with the resolved key, 23503 on a user foreign key mapped to `401 account_deleted` through the real idempotency lease, the cookie cache re-enabled for reads with KV session tombstones written by the deletion itself and back-filled nightly. Documents: the first-deploy runbook as a ticked checklist with exact commands, architecture, cost estimate from the shared constants, the threat model with the KEK rotation runbook, open decisions, schema review final. Nothing was deployed: both wrangler dry runs, the Workers suite on embedded Postgres and the workflow checks are the proof; the owner tasks are in `docs/increments/12-verification.md`. Review: two Opus 5 lenses (operations and data correctness; docs and deploy correctness) raised 16 findings (2 majors: the provider-call purge gate trusted a rollup whose null sums had been coerced to 0, the runbook lacked the Sign in with Apple key and App ID grouping the multi-bundle exchange depends on; 8 minors, 6 nits), 3 of 4 skeptic verdicts real with the spec-lens refutation of the purge gate overruled, eighteen rulings injected at the fix boundary, all 16 applied by Opus; the re-review found one major the fix introduced (the operator deletion form could never succeed from a browser: no-referrer pages send a null Origin) plus two minors and a nit, closed by a Fable escalation round under rulings AB1 to AB5 (same-origin referrer policy on those pages, a fresh-session guard on the search route, migration 0006 recording the ledger count beside the rollup sums); the second re-review found one nit (a stale migration hash in the verification record), fixed in the close-out. 603 mobile Jest tests, 2199 total. |

## Maintenance after Phase 0

- **The native-smoke workflow (2026-09-30).** Every scheduled run from 2026-09-24 to 2026-09-29
  failed. The Android leg compiled all four ABIs in debug and release on a hosted Ubuntu runner
  and filled its disk: the runner's annotation reads "No space left on device", and a runner that
  dies that way uploads no job log, so the failing step showed nothing. Measured on this machine,
  all four ABIs write 18.1 GB of build output against 5.8 GB for `x86_64`. The leg now builds
  `x86_64` only (the emulator's ABI; EAS builds compile every store ABI, ADR 0001), frees the
  preinstalled toolchains it never uses first, and checks the free space before the build (25 GB
  on the runner) and before the emulator step (10 GB). The Xcode 26.6 gate leg passed every
  night. The Xcode 27 leg fails at selection because no `macos-26` image carries Xcode 27 yet
  (`continue-on-error`, so it never failed the run); the selection now runs before the checkout.
  The same week the account ran out of Actions minutes: 616 Linux and 136 macOS minutes in
  September, about $12.13 at list price against the $12 that GitHub Free's 2,000 included minutes
  are worth, and GitHub then refused every job (a manual run on 2026-09-30 was "not started" for
  billing), so the schedule moved from nightly to weekly until a budget covers macOS minutes
  (runbook step 15). A manual run can pick one platform (`platforms`), with one concurrency group
  per choice. An Opus review found no blocker or major; its eight minors and nits (tests that
  matched the script's text instead of running it, a floor below what the job writes after the
  check, a one-platform run cancelling the other's, stale wording) are applied, and nine script
  mutants are now caught by the tools tests. Opus 5.5 fix and review; no Fable.
- **A date-dependent mobile test (2026-09-30).** `offline-flow.test.ts` recorded a replacement at
  the fixtures' fixed clock (2026-09-23T14:00Z) and read it through `readFlightFollowing`, which
  checks its age against the real clock, so it failed on `main` from 2026-09-24T14:00Z (increment
  12's merge CI ran before that). The test now pins the clock.
- **An Expo check that moved with Expo's releases (2026-10-01).** The first CI run after the
  Actions quota reset failed `test-mobile` on every PR at "SDK packages match the Expo SDK 57
  manifest": online, `expo install --check` compares against Expo's newest patch list for the
  SDK, and Expo had published patches for nine packages (expo 57.0.26 against the installed
  57.0.24, expo-widgets 57.0.22 against ADR 0008's exact 57.0.20, and seven more). The step now
  runs with `EXPO_OFFLINE`, which compares against the installed `expo`'s own manifest, the
  same rule the toolchain guard applies; a planted expo-constants 56.0.3 still fails it.
  Taking Expo's patch releases stays a deliberate change, made and smoke-tested before a store
  build.

## Measurements and decisions (increment 12 review fixes)

- **The review round.** 16 findings from two Opus lenses (2 majors: the provider-call purge gate
  accepted a rollup whose sums the SQL API client had coerced to 0, so a null sum from Analytics
  Engine deleted the only exact copy of a day's ledger; the runbook never had the owner create the
  Sign in with Apple key or group the preview and development App IDs under the primary, which
  the multi-bundle code exchange depends on; 8 minors and 6 nits), 3 of 4 skeptic verdicts real
  (the spec-lens skeptic refuted the purge gate on the spec's one-precondition wording, overruled
  by ruling AA13 because the ledger has no other copy), eighteen rulings (AA1 to AA18) injected at
  the fix boundary settling the builder's open questions and every finding: the rollup never
  coerces and the purge needs a plausible rollup (more than zero and within 20 percent of the
  day's row count); the tombstone lookup runs for any request that resolved through the cacheable
  path, whatever the cache cookie is called (a chunked `session_data.0` had bypassed it); the sync
  purge gets BRIN indexes on `xid` and `created_at` (migration 0005) and advances the horizon in
  bounded steps with continuations, because the unpaged seq scan would pass the runbook's 10 s
  `statement_timeout` at scale; the DLQ replay covers only origins that keep no other copy, since
  a tracker re-sends its own dead-lettered rows and a body-borne replay count restarted with every
  re-send; the KEK re-wrap proves the new wrap before writing it and updates conditionally;
  `GET /v1/flights/search` reads the session row because it takes caps and can spend a provider
  call; staging fails closed without its database secret; the runbook gains the Apple key and
  grouping steps, the AeroDataBox Growth subscription, the support inbox before the Play
  registration and the test to update with the GitHub Pro gate; the admin page gains the one
  operator deletion action; the documents get the schema open items, the DO-list test, the
  measured row counts and the reserved webhooks. The re-review confirmed every fix by probe (the five rollup cases, the chunked cookie, 600k rows purged in 36 index-scan steps with the final horizon equal to the one-pass value, the tracker archive kept) and found one major it introduced: the operator deletion form could never succeed from a browser, because the admin pages are sent with Referrer-Policy no-referrer and a form POST from such a page carries Origin null, which the same-origin check refuses (captured live in Chromium); two minors (the search bypass matched the raw percent-encoded path, so /v1/flights/%73earch still ran from the cookie cache; step 3's approval of a day lived only in the continuation cursor, so a retry after a partial delete stranded the rest of that day) and one nit (the duration row's arithmetic). The Fable escalation round applied them under rulings AB1 to AB5: the lookup and result pages carry Referrer-Policy same-origin with the Origin check unchanged; a requireFreshSession middleware on the search route re-reads the session row whatever spelling reached it, and the auth middleware compares Hono's decoded path; migration 0006 records the ledger count next to the rollup sums so the plausibility verdict cannot change after a partial delete; the figures recomputed from their own inputs. The second re-review confirmed all four by probe (the rendered pages' policy and the Origin refusals; four spellings of the search path answering 401 with no provider call; the exact retry reproduction ending with zero rows left) and found one nit, a stale migration hash in the verification record, corrected in the close-out.

- **Crons only plan (ruling W1).** The reconcile cron from increment 7 is unchanged (empty diff)
  and now covered through `scheduled()`; the daily cron's only work is one `sendBatch`. The
  housekeeping consumer runs one message at a time with a 30 s wall budget, `max_retries` 3 and
  a DLQ; the steps are independent and order-insensitive (the ruling's order documents them).
- **The sync purge is exact by construction (ruling W2 step 2, ADR 0012 item 6).** A purge by age
  would remove a row a cursor has not passed (a transaction with a low xid inserting its change
  row late); purging below the smallest young xid keeps every such row, and the route answers
  410 exactly when a cursor's xid is below the recorded horizon. Paged by horizon steps after the
  review (see above).
- **A ninth step, `kek_rewrap` (builder's deviation, accepted with ruling AA1).** The threat
  model's KEK rotation runbook needs an executable re-wrap path; the step is a no-op while one
  KEK is configured, proves the new wrap before writing it and updates conditionally on the
  version it read. Ciphertexts never change.
- **Session tombstones (ruling W2 step 8, AA3).** Written by the deletion itself right after its
  commit (a nightly writer alone could never close a 300 s cache window), checked for any request
  that resolved from the cacheable path; the residual (a session revoked without a deletion reads
  for up to 300 s; KV propagation of about 60 s) is in the threat model.
- **The typed confirmation is the production gate (ruling W6, AA6).** Without GitHub Pro an
  environment with required reviewers blocks nothing on a private repository, so a `v*` tag only
  verifies and a manual run must type `deploy <tag>`; the runbook says which condition to relax
  once the plan changes, and names the test case that asserts it.
- **Events keyed by `analyticsId` (ruling W9, AA7).** The shape the increment 9 client already
  sends; a client-chosen id cannot key a rate limit, so `EVENTS_RL` is per client IP.
- **`APPLE_BUNDLE_IDS` (ruling W10).** The primary id keeps working unchanged; the exchange names
  the bundle id that received the code, which needs the preview and dev App IDs grouped under the
  primary with one Sign in with Apple key (runbook step 12 after the review).

## Deviations (increment 12)

- **The build commit carries the Opus trailer** (the harness attribution instruction took
  precedence for the builder); the fix and close-out commits carry the Fable trailer.
- **The retention step deletes more than ruling W2 lists** (`flight_events` over 90 days, expired
  sessions, day-window `usage_counters` over 30 days, sync-entity tombstones over 30 days):
  schema-review assigns those retentions and each table has a writer.
- **The W4 mapping matches Drizzle's `*_user_id_users_id_fk` names** as well as `*_user_id_fkey`;
  this schema's constraints use the Drizzle naming.
- **`routes/not-implemented.ts` is gone**: `/v1/events` was its last stub; the two reserved
  webhooks still answer 501 from their own module.
- **The Analytics Engine rollup rides the housekeeping queue** as `ae_rollup` messages for
  yesterday and the day before, with `CF_ACCOUNT_ID` and an optional `CF_API_TOKEN`
  (`OPTIONAL_SECRET_NAMES`); without them the rollup is skipped and the provider-call purge keeps
  its rows by design.
- **The admin page has one write action** (operator-run account deletions, ruling AA9), a
  departure from ruling W5's read-only page, because the public deletion page promises an email
  path and a hand-written SQL delete would skip the tracker unsubscribes, the Apple revocation and
  the tombstones.
- **Unverified (nothing deployed):** Cloudflare Access against real tokens; the Analytics Engine
  SQL API response shape and `SUM(_sample_interval)` on sampled data; the Queues metrics fields
  and the token scopes; the deploy token's Hyperdrive permission and `wrangler-action@v4` with an
  empty `secrets` input; `deploy-production.yml` has never run; the watermark lag on Neon without
  `pg_read_all_stats`; KV propagation; one Sign in with Apple key across grouped App IDs; cron and
  consumer CPU on real volumes; the cost estimate's list prices; whether `/account/delete` meets
  Google Play review.

## Measurements and decisions (increment 11 review fixes)

- **The review round.** 11 findings from two Opus lenses (2 majors from the build-system lens:
  the runtime fingerprint ignored the watch shells' Swift and plist sources and the Wear module,
  so a native change there would not have moved the runtime version; the embedded watch app had no
  icon asset catalog, which App Store Connect rejects at upload; 7 minors and 2 nits), 4 of 4
  skeptic verdicts real, twelve rulings (Z1 to Z12) injected at the fix boundary, all 11 findings
  applied by Opus in one round: `fingerprint.config.js` hashes `targets` and `wear` (and ignores the
  icon catalog apple-targets generates on every prebuild, which a builder has and `eas update`
  never does); the watch target takes the variant's icon and `ios-archive` asserts
  `CFBundleIconName` and `Assets.car`; a new post-order `withExpoWidgetsBuild` plugin sets the
  widget extension's Release configuration to `-O` with `ENABLE_DEBUG_DYLIB=NO` (expo-widgets
  generates `-Onone` with a debug dylib; `ios-archive` fails on any `*.debug.dylib` or
  `__preview.dylib`) and, while `PLANEAHEAD_ANDROID_WIDGETS` is unset, writes
  `expoAutolinking.exclude = ['expo-widgets']` into `settings.gradle`, which removes Glance
  1.2.0-rc01, WorkManager 2.7.1 and the `FOREGROUND_SERVICE` permission from every Android build
  (`android-archive` compares `aapt2 dump permissions` with a 26-entry allowlist through a
  testable classifier); the Android nightly also builds the release APK, whose embedded bundle the
  launch gate runs, failing on a dead process, a `FATAL EXCEPTION` naming the app or an
  `E/ReactNativeJS` line (proven on the Pixel AVD: alive after 45 s, `Running "main"`);
  `LiveActivityContentStateV1` bounds its free text (gate 16, terminal 32, baggage claim 32, key
  32, instants 30) and gains optional destination gate and terminal, with the worst case built
  from the maxima with a control character (7 bytes double-encoded) at 1,659 of 4,096 bytes and
  `encodeContentState` stripping unknown keys and throwing at the limit; `registerDevice` returns
  whether the token was registered, and a refused push-to-start token logs a skipped event with
  the reason and a Sentry warning; the token lifecycle on sign-out and rotation, and the listener
  that attaches only to activities alive at mount, are recorded as gates on the Phase 1 sender in
  ADR 0008 with "one per installation" reworded to what the table stores. The re-review confirmed every fix in a scratch clone (Xcode 27 prebuild, build, archive and launch; both Android APKs, the 26-permission allowlist, the release launch gate with a planted module-scope throw as the negative control; the fingerprint relation re-proven) and found no blocker or major: two nits, the permission allowlist ignoring the `uses-permission-sdk-23` form and the verification doc's fingerprint hashes taken before the fixer's last edits under `targets/`, both applied in the close-out.

- **`aps-environment` is written by a post-order base mod (ruling V3, spike evidence).** Three
  writers touch the key: `ios.entitlements` (merged when the file is read), `expo-notifications`
  and expo-widgets' unconditional literal `development`. `@expo/config-plugins` 57.0.9 runs a
  `withMod` action before `nextMod`, so the last-listed plugin runs FIRST and a plain
  `withEntitlementsPlist` was measured to lose (`expo config --type introspect`, production
  profile: `development`). `withApsEnvironment` registers a base mod that awaits the rest of the
  chain and then writes `APNS_ENVIRONMENT` from the EAS profile; it must stay listed last.
- **The watch shells ship (ruling V6).** The coexistence spike passed in about 20 minutes on
  Xcode 27: one prebuild, four targets, both watch products built for watchOS (minos 11.0) when
  `xcodebuild` is given `-destination` only; `-sdk iphonesimulator` silently builds the watch
  targets for the iOS simulator, so a workflow test forbids it. The 26.6 gate leg stays
  unverified until the nightly runs.
- **Android widgets stay behind a flag; the hand-written Glance widget is dropped (ruling V2).**
  With `PLANEAHEAD_ANDROID_WIDGETS=1` expo-widgets writes the receiver and resources and
  `assembleDebug` passes (the first cold D8 run needed more than the template's 2 GB heap; the
  nightly passes 4 GB). expo-widgets' Android module is autolinked whatever the flag says, which
  the review round settled (see above).
- **API 36 lacks the Live Updates calls (spike 3).** `Notification.Builder#setRequestPromotedOngoing`
  and `POST_PROMOTED_NOTIFICATIONS` first appear in API 36.1; the stub uses androidx.core 1.17.0's
  `NotificationCompat` version behind `SDK_INT >= BAKLAVA` and declares no permission. Wear Compose
  is pinned to 1.6.2 because 1.7.0 needs compileSdk 37 and AGP 9.1.
- **Content state (ruling V4).** Optional designator and IATA codes were added to the existing
  `LiveActivityContentStateV1` (increment 2) rather than a new schema; progress stays
  `progressPercent` as in `FlightStatus`. The 8-hour active limit versus long-haul flights is an
  open Phase 1 decision in ADR 0008.
- **Push-to-start on the Simulator (ruling V5).** A listener added on the native module through
  the Metro debugger received a token within 25 s on the iOS 26.5 runtime, so Phase 1 can test the
  push-to-start loop without a device. The app's own listener posts through the increment 9
  devices module (direct call, `X-Install-Id`, the APNs environment from the build's signing).

## Pinned versions (increment 11)

- `expo-widgets` 57.0.20 exact (catalog; the toolchain guard asserts the exact pin and a single
  copy); `@expo/ui` ~57.0.19 (the SDK 57 manifest range; resolved 57.0.19).
- `@bacons/apple-targets` 5.0.0 exact (pulls `@expo/prebuild-config` 55.0.22, a second
  `@expo/config-plugins` 55.0.11 and `@bacons/xcode` 1.0.0-alpha.32).
- Android: androidx.core 1.17.0 (the stub; Gradle resolves the highest version in the app graph),
  Wear Compose material3 and foundation 1.6.2, Compose ui and foundation-layout 1.9.0,
  activity-compose 1.11.0, wear tiles 1.6.2, protolayout 1.4.2, concurrent-futures 1.3.0,
  listenablefuture 1.0; the Compose compiler plugin follows `rootProject.ext.kotlinVersion`
  (2.1.20). compileSdk and targetSdk 36, minSdk 24, build-tools 36.0.0, NDK 27.1.12297006,
  AGP 8.12.0, Gradle 9.3.1.
- DB: migration `0004_push_to_start_token_kind`, `DB_SCHEMA_VERSION` 5, `drizzle-kit check` clean.

## Deviations (increment 11)

- **The build commits carry the Opus trailer** (the harness attribution instruction took
  precedence for the builder); the fix and close-out commits carry the Fable trailer.
- **Two small hand-written SwiftUI files** ship in `targets/watch` and `targets/watch-widget`: a
  watchOS app target and a WidgetKit complication cannot compile without an `@main` App and
  Widget, and apple-targets generates only the Info.plist. Nothing else outside what expo-widgets
  requires.
- **The widget extension's bundle id is explicit** (`<bundle id>.widgets`, not the plugin's
  `.ExpoWidgetsTarget` fallback), because it is permanent once a build ships (ADR 0005).
- **`entitlements.test.ts` evaluates the plugin chain with `expo config --type introspect`** per
  EAS profile rather than a real prebuild in Jest; `scripts/native-smoke.sh` asserts the generated
  `.entitlements` files with PlistBuddy.
- **The nightly iOS legs build the production variant in Release** (`ONLY_ACTIVE_ARCH=YES`), so
  the app's JS runs at launch and a JS fatal fails the gate; both iOS legs run on `macos-26`, and
  the Xcode 27 leg selects `/Applications/Xcode_27*.app` when the image has one.
- **The new kind was added beside increment 3's unused `apns_live_activity_start`** (ruling V5
  says add); retiring the old kind is an open decision. `src/lib/devices.ts` sends
  `pushEnvironment` for every APNs kind, and one line in the `(app)` layout mounts the token hook.
- **Files beyond the spec's list:** `widgets/index.ts`, `scripts/native-smoke.sh`,
  `tools/workflows/native-smoke.test.js`, the widgets, live-activity-tokens and wear-plugin tests
  with their fixtures, plus turbo, eslint, gitignore, prettierignore and house-style updates.
- **Unverified:** the Xcode 26.6 leg (not installed here); `native-smoke.yml` on GitHub (runner
  images, Xcode 27 availability, KVM, the API 36 x86_64 emulator action, the all-ABI Android
  build); device-signed archives and EAS provisioning of the extension and watch targets; the
  watch app on a watchOS runtime; the app's own push-to-start registration end to end; a visual
  check of the Live Activity layout; the Glance widget and the Wear APK on their emulators; the
  Android Live Updates promotion.

## Measurements and decisions (increment 10 review fixes)

- **The review round.** 17 findings from two Opus lenses (1 blocker: cancelling a pending add that
  the server answered `created: false` re-pointed the queued DELETE at the account's existing
  subscription and deleted it; 5 majors: the pending placeholder key had silenced the increment 9
  snapshot dedupe, a 410 with no flight payload never marked the row finished, the iOS number pad
  could not type a hyphenated date, the card showed whichever designator first searched the
  flight, a landed inbound stayed the next flight ahead of a sooner connection), 10 of 10 skeptic
  verdicts real, seven rulings injected at the fix boundary, all 17 findings applied by Opus:
  `reconcileSent` branches on `created`; pending rows are matched to live rows by origin-local
  date plus any shared designator (typed, operating, marketing or codeshare, IATA or ICAO) and
  marked superseded; a 410 stamps `finished_at` by subscription id; the date field inserts hyphens
  as digits are typed and eight digits validate; a local-only `added_as` column (migration
  `0003_local_intent`) shows the designator the user typed with "Operated as" when it differs, and
  the duplicate check compares flight keys only; a landed flight leaves the next-flight slot
  30 minutes after its best arrival or when another flight departs sooner; local intent survives
  every pull (queued DELETEs re-apply their tombstone, `finished_at`, `added_as` and `superseded`
  carry across a replace); an add whose POST never left the phone is cancelled without a network
  call (the outbox stamps `last_attempt_at` before sending); the detail screen follows an id
  replacement; 401 `account_deleted` on refresh wipes the store; screen readers get the full card;
  the empty state only when the store is empty; day shifts on the timeline; generic copy for
  unknown refusal codes; input-border and rail tokens at 3:1; non-finite countdowns render nothing. The re-review found
  no blocker or major: two minors (the add sheet's immediate drain stamped an offline add so it
  could no longer be cancelled; codeshare rows printed the operating designator in lower case)
  and three nits, closed in a second Opus round under rulings Y1 to Y6 (the outbox never stamps
  or sends while the phone knows it is offline; `findTracked` matches every spelling a card can
  show; an ICAO spelling is never labelled as operated by itself; replacement entries are bounded
  and cleared on sign-out).

- **Every write goes through the outbox (ruling T2).** The add sheet writes the optimistic row and
  its POST in one commit under a client uuidv7 id that the server receives as `subscriptionId`; the
  outbox gained `onSent`, `onRefused` and `onHookError` so a refusal removes its optimistic row in
  the same transaction that settles the item, and a `created: false` answer swaps the row for the
  server's id. Preference toggles queue `PATCH /v1/me/preferences` with the pending patches laid
  over the server's values until they drain.
- **The timeline comes from the snapshot (ruling T4).** The sync feed's `flights[]` carries
  `FlightStatus` snapshots and no event rows in Phase 0, so the timeline is derived from the
  snapshot's times, gates, terminals, baggage, aircraft and provider attribution; the spec's
  `timeline_summary` wording is superseded and noted for increment 12's docs.
- **Refresh budget (ruling T3 and the builder's judgement).** The per-flight provider refresh
  lives on the detail screen only, once per gesture with the 8 s deadline UX; the home
  pull-to-refresh performs a sync pull, because every refresh call is charged to that flight's
  daily budget even when the tracker coalesces it.
- **Rows a queued DELETE names keep their tombstone (ruling X3).** A pull that succeeds while the
  DELETE waits in backoff no longer resurrects the row.
- **Provider-call acceptance in the Workers suite (ruling T1).** With no API reachable, the
  two-accounts assertion runs against the real Worker chain and the fake gateway; the device
  steps are written as the exact commands the owner runs.
- **A local store migration `0002_finished_at`** records a 410 `flight_archived` locally (the feed
  carries no tracker phase); the store-version bump makes the first pull after the update a
  snapshot.
- **A development-only seeded home route** (`src/app/dev/seeded-home.tsx`) and a launch-argument
  redirect exist so the screens can be rendered on a simulator without an API; both are inert
  outside `__DEV__` and the development variant, and a test proves it (ruling X2).

## Deviations (increment 10)

- **Both 504 codes are handled** (`refresh_timeout`, which the increment 8 route actually answers
  with the flight, and `upstream_timeout` from the ruling's wording).
- **The optimistic row carries a placeholder key** (`pending:<DESIGNATOR>:<DATE>`) and shows as
  "Adding" until the server resolves the designator; a flight the store already tracks is not
  queued twice.
- **`FlightView` answers are parsed with a local zod schema** (no shared type was added; the
  answers are network data and are parsed, never cast).
- **The build commit carries the Opus trailer** (the harness attribution instruction took
  precedence for the builder); the fix and close-out commits carry the Fable trailer.
- **Unverified:** every device step that needs an API (adding tomorrow's AA100 with times within
  5 s, the `provider_calls` row on staging, the second account, the network-cut relaunch, one
  refresh request per pull, the 504 UX); the add sheet, the detail screen and the settings
  toggles on a device (only the home screen was rendered); the refresh `AbortController` on
  Hermes; the home list's wall-clock cost with hundreds of rows.
- **Carried to increment 12:** the resolver's `user_search` provider-call record with a NULL flight
  key (stamped after resolution).
- **Simulator housekeeping:** the builder installed the dev build on the owner's booted iPhone 17
  Pro simulator and left its "Open in PlaneAhead Dev?" dialog on screen (tap Cancel); the dedicated
  simulator it created was deleted in the close-out.

## Measurements and decisions (increment 9 review fixes)

- **Spike results.** (1) The isolated linker holds: `expo prebuild` (about 50 s cold, 20 s warm,
  132 pods), the iOS simulator compile (about 2 min incremental) and the Android `assembleDebug`
  (5 min 33 s cold, then under 2 min) pass with the full dependency set and no hoisting. The rule
  that came out of the three failures: every native package a build compiles, and every package
  a build phase or config plugin requires from `apps/mobile`, is a direct dependency pinned to
  Expo's manifest version, and every native library carries its config plugin. (2) hono 4.13.8
  awaits the client's `headers()` inside every call, so a refreshed cookie reaches the next `/v1`
  request without a custom fetch. (3) `expo-notifications` 57 reads the FCM token through
  Firebase Messaging, which needs `google-services.json`; `app.config.ts` takes it as an EAS file
  variable per variant and `push.ts` reports `unavailable` until it exists.
- **Sentry privacy (ruling S9.1, the blocker).** sentry-cocoa records a breadcrumb for every
  NSURLSession task with the raw query in `http.query`, and native crash and app-hang events never
  pass through the JS `beforeSend`, so a magic-link token could reach Sentry unscrubbed.
  `enableNetworkBreadcrumbs` is off (the JS fetch breadcrumbs, which `beforeBreadcrumb` scrubs,
  remain), `http.query`, `http.fragment` and `query` are dropped keys, `scrubUrl` cuts at `#` as
  well as `?`, `request.data` is dropped, and the privacy test carries a native-shaped breadcrumb,
  a fragment-only URL and a request body (the two mutants that had survived).
- **Coalescing through a store signal (ruling S9.2).** On device every `sqlite3_update_hook` call
  is its own task and RN's scheduler drains microtasks after each, so the spec's trailing
  microtask merged nothing. A tiny event bus bumps a per-table version after every committed sync
  apply, reset and outbox write, and the live-query hook re-queries on that signal; the test
  delivers events as separate macrotasks.
- **Magic-link auto-verify (rulings S4, S9.3, U2).** A link is verified without a confirm step
  only when it arrives as an https universal link whose host is in the variant's own list and this
  install requested a link in the last 15 minutes; the delivered URL comes from a
  `+native-intent` holder that records every URL the process receives, because on iOS
  `getLinkingURL` keeps only the first; a custom-scheme delivery (Expo Router maps
  `planeahead://auth/magic-link` to the same route) goes to the confirm step, and a verified email
  that differs from the requested one signs out and restores the anonymous cookie. The threat
  model's section 1.5 now states what is built.
- **410 handling (rulings S9.4, U3).** A 410 (and a 400 `invalid_cursor`) clears only the cursor
  and marks a reset pending; the no-cursor snapshot page then deletes the synced rows and applies
  the snapshot and cursor in one immediate transaction, so a failed re-pull on flaky wifi no
  longer leaves an empty store; rows named by a queued subscribe mutation in the outbox survive
  the replace (the outbox records the entity id it mutates), so increment 10's optimistic rows
  cannot vanish while their POST is still queued; the eager wipe happens only when the session
  user differs from the store's owner.
- **Forward compatibility (ruling S9.5).** The envelope shell is parsed strictly and each change
  and flight element individually; unknown elements are skipped and reported, and a store schema
  version in `sync_state` forces a snapshot after an app update so skipped rows are recovered.
- **Universal-link ownership (ruling S2).** Each host is claimed by exactly one variant so routing
  on a phone with several variants stays deterministic: production and preview claim
  `api.planeahead.app`, development claims `api-staging.planeahead.app`; Apple sign-in against
  staging belongs to the development variant (the API accepts one `APPLE_BUNDLE_ID` per
  environment until increment 12 makes it a list).
- **EAS Update inputs (rulings S8, U1).** The `fingerprint` runtime version hashes the resolved
  config, `extra` and plugin props included, so `mobile-preview.yml` publishes with exactly the
  config inputs the build had (`--environment preview`, the job env held equal to the profile's
  by a test) and targets its branch explicitly; a committed `fingerprint.config.js` ignores the
  Google services file, which a file variable supplies to the builder but `eas update` cannot
  read, and every other fingerprinted variable must be Plain text or Sensitive, never Secret; the APNs environment derives from the
  EAS profile's distribution (ad hoc and App Store signed apps register with production APNs),
  which increment 11's wording is amended to match.
- **MapLibre is a dependency only (rulings S1, S8).** Autolinking it pulled location permissions
  and a `requestWhenInUseAuthorization` call into a Phase 0 app that never uses location;
  `react-native.config.js` disables its platforms and its config plugin is out until the maps
  increment.
- **Session refresh ownership (ruling S9.7).** Better Auth's own focus refetch is off
  (`refetchOnWindowFocus: false`); the hourly refresher is the one owner of `get-session` on
  launch and foreground, recorded in ADR 0001.
- **Pins corrected against the facts sheet:** `test-renderer ~1.2.0` (1.3.0 needs React 19.3);
  `jest 29.7.0`; the toolchain guard now holds every `apps/mobile` dependency present in
  `expo/bundledNativeModules.json` to its range, the exact pins (`react-native-nitro-google-signin`
  2.3.0, `react-native-nitro-modules` 0.37.1, `@maplibre/maplibre-react-native` 11.4.0,
  `@sentry/react-native ~7.11.0`) and runs `expo install --check`; Renovate never auto-merges the
  exact native pins.

## Pinned versions (increment 9)

Every Expo package at SDK 57's `bundledNativeModules.json` version (`expo ~57.0.24`,
`react-native 0.86.3`, `react 19.2.3`, `expo-router ~57.0.22`, `expo-sqlite ~57.0.3`,
`expo-build-properties ~57.0.21`, `expo-notifications ~57.0.20`, `expo-dev-client ~57.0.19`,
`expo-updates ~57.0.23` and the rest), `@better-auth/expo 1.7.5` exact, `react-native-nitro-google-signin
2.3.0` exact with `react-native-nitro-modules 0.37.1`, `@sentry/react-native ~7.11.0` (Expo's own
pin), `@tanstack/react-query ~5.103`, `zustand ~5.0`, `@maplibre/maplibre-react-native 11.4.0` exact
(dependency only, not linked), `jest 29.7.0` with `jest-expo ~57.0.5` and
`@react-native/jest-preset 0.86.3`, `@testing-library/react-native ~14.0` with `test-renderer ~1.2.0`,
TypeScript `~6.0.3` as policy. `pnpm-workspace.yaml` gains `hoistPattern ['*', '!@types/jsdom']`.

## Deviations (increment 9)

- **The universal-link prefix is `/auth/magic-link*`**, not the spec's `/api/auth/magic-link/*`:
  increment 5's ruling G3 moved the emailed link to the non-consuming landing page.
- **The well-known routes are mounted from `apps/api/src/index.ts` outside `AppType`** (four lines
  beyond the spec's single-file allowance) and answer 404 until `APPLE_TEAM_ID` is set, so Apple's
  and Google's crawlers never cache an empty association.
- **Jest runs the plain `jest-expo` preset as one project**; code that touches expo-sqlite is
  written against a `SqliteLike` interface, and the test fake is Node's built-in `node:sqlite`
  with the app's own migrations applied (a real engine, zero dependencies).
- **`magicLink.verify({ query: { token } })`** is the Better Auth client's inferred shape for the
  GET verify route; on iOS Google sign-in uses `presentExplicitSignIn` (the nitro library's
  `signIn` restores a cached token without this attempt's nonce); the Apple credential-state
  check runs on launch on real devices only.
- **`X-Install-Id` goes on every `/v1` request**, Sentry automatic performance tracing is off,
  `platforms` is iOS and Android only, `typedRoutes` is off, `GOOGLE_SERVICES_JSON` is an
  optional EAS file variable, and the local package scripts run the development variant.
- **The settings screen ships appearance, account and notifications**; the units and time-format
  toggles arrive with the screens that use them in increment 10.
- **The outbox drains in strict FIFO order by insertion** (an item in backoff blocks everything
  behind it; a subscribe and its unsubscribe must never reorder).
- **Local native builds compiled `arm64-v8a` only**; the Android Gradle Plugin installed
  build-tools 36.0.0, CMake 3.22.1 and NDK 27.1 into the SDK on first build.
- **The build commits carry the Opus trailer** (the harness attribution instruction took
  precedence for the builder); the fix and close-out commits carry the Fable trailer.
- **Unverified:** everything past the sign-in screen on device (anonymous sign-in, the universal
  link and merge, native Apple and Google, settings across an offline relaunch: all Jest-proven);
  the FCM rejection without `google-services.json` (from source, not observed); the AASA and
  assetlinks files against Apple's CDN and Android's verifier; `eas build` and `eas update`; the
  new CI jobs on GitHub; Sentry's native upload phases; Release-configuration native builds;
  MapLibre's Swift package resolution on runners; the encoded session cookie against SecureStore's
  1800-byte chunking; expo-sqlite change-event delivery inside a `*Sync` call on device.
- **Owner tasks surfaced:** App IDs with Sign in with Apple and Associated Domains plus the three
  App Groups, the Team ID, the `.p8` key and id; `APPLE_TEAM_ID` on the API per environment; Google
  OAuth client ids (web, iOS, Android per variant) and the API's `GOOGLE_CLIENT_ID_*` secrets; a
  Firebase project with each variant's `google-services.json`; Google Play as an Organization and
  the signing fingerprints for `ANDROID_SHA256_FINGERPRINTS`; a Sentry project (`SENTRY_DSN`,
  `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`); an Expo account on the Starter plan
  (`eas init`, `EAS_PROJECT_ID`, a robot token as `EXPO_TOKEN`); accept the adb prompt on the
  Pixel AVD; deploy staging or give `apps/api/.dev.vars` a Neon branch, then run the device
  acceptance steps in `apps/mobile/README.md`.
- **Carried to increment 12:** `POST /v1/events` (the analytics client turns itself off on the
  501), a list of Apple bundle ids per environment.

## Measurements and decisions (increment 8 review fixes)

- **The sync cursor is bound to its principal and its timeline (rulings O12, O9).** The cursor is
  `base64url("<xid8>:<seq>:<epoch>:<hash8>")`: `hash8` is the first 8 bytes of SHA-256 over the
  user id (no secret: forging another user's binding still only pages the session user's rows),
  `epoch` comes from the one-row `sync_epoch` table that the restore runbook bumps after any
  point-in-time restore (a restored cluster reuses xids). A mismatch answers 410, which the client
  handles by resetting and pulling the snapshot, so a device that upgrades from anonymous to an
  existing account receives that account's older rows. The retention horizon is exact by
  construction: the increment 12 purge deletes `where xid < H` from both change tables in one
  transaction and records H in `sync_horizon`; 410 is answered exactly when `cursor.xid < H`. The
  first build's "oldest retained row" heuristic could skip a change after a seq-ordered purge,
  because a row's xid is fixed at the transaction's first write and its seq at the change-row
  insert; both ADR 0012 and schema-review section 6 were corrected before increment 12 builds the
  purge. `EXPLAIN` on embedded Postgres 18.4 shows the `(user_id, xid, seq)` index driving the
  row-value comparison; the expanded `OR` form was not needed.
- **The anonymous merge is a sync event (ruling O2).** `mergeUsers` writes `user_sync_changes`
  rows under the new user for every moved or restored subscription, every tombstoned loser and
  every singleton change, in its own transaction, and a `merge` consumer re-points the tracker
  subscriber lists with the existing subscribe and unsubscribe RPCs (idempotent). Without this
  the account's other device never received the merged flights.
- **`live_tracked` follows the flight (ruling O3).** The persist consumer takes the slot for each
  unflagged subscription on the first row that puts a flight inside its 48 h window (a refused
  take leaves the subscription untracked live, recorded as a sync change) and releases the slots
  when the row turns terminal; the increment 12 nightly reconciliation is a repair, not the path.
- **Deleted accounts cannot act through the cookie cache (ruling O5).** Every `/v1` request
  resolves its session with Better Auth's cookie cache disabled (one indexed session read; the
  increment 12 alternative, a KV tombstone per deleted session hash, is in the threat model), so a
  second device's GET answers 401 `account_deleted` and search can no longer write a
  `usage_counters` row or create a tracker under a deleted user id.
- **Subscribe consistency (rulings O13, Q1).** The first fix made the late compensation after a
  lost 8 s race conditional on a point-in-time read, and the re-review showed the timed-out call
  and the retry can join the same in-flight provider fetch and resume together, so the read still
  raced the retry's transaction. Ruled away: after a lost race the route answers 504 and schedules
  no unsubscribe, because a stray tracker subscriber costs nothing in Phase 0 (the shared tracker
  polls regardless, Postgres filters the list, the increment 12 reconciliation repairs it) while a
  wrong unsubscribe loses a real subscription. One monotonic late check remains (ruling R2): a call
  that lands `subscribed` after the account was deleted is unsubscribed, because a deleted user
  never comes back and no retry can have recorded that row. The transaction-failure compensation
  stays (it runs inside the first request while the in-flight lease blocks a same-key retry); the
  `already` paths re-send the idempotent tracker subscribe; the increment 12 spec gains the
  tracker-subscriber reconciliation pass that removes any remaining stray; a 23505 on either unique constraint re-reads the
  live row and answers 200 `already` instead of 500.
- **Deletion closes its races (rulings O14, Q2, R1).** Step 4 first locks the users row `FOR
UPDATE` (a subscribe that already inserted is waited for and then seen; a later one fails its
  foreign key and is compensated by its own route), then deletes subscriptions `RETURNING id`, and
  a step 5 unsubscribes any id step 1 did not see. That lock inverts the order against same-user
  writers that lock a leaf row and then append a change row, so step 4 runs under a bounded retry
  on deadlock and serialization failures rather than root-first locks in every writer; the magic-link `usage_counters` rows keyed by the
  email hash die with the account; schema-review section 7 records the per-table fate and the
  change rows step 4 must add once trips have writers.
- **Contract fixes (rulings O4, O10, O11).** Search and add-by-number answer 404
  `flight_not_found` (distinct from the unknown-route 404) with `triedDates` and an empty
  `suggestions`; every `/v1` handler returns typed responses and `test/unit/app-type.test.ts`
  asserts the inferred bodies; `src/client.ts` follows the Hono guide pattern with the `./client`
  export pointing at the emitted declaration and a consumer type-check with `types: []`; malformed
  JSON and other `HTTPException`s become the envelope; refresh on a terminal subscription answers
  410 `flight_archived` and shares one flight shape with detail and the 504; the `/v1` idempotency
  instance passes through unscoped so `requireScope` answers 401; `wrangler.jsonc` declares
  `secrets.required` per environment, kept in sync with `WORKER_SECRET_NAMES` by a test.
- **Owner setup surfaced by this increment:** `wrangler secret put DELETED_SUBJECT_HMAC_KEY` and
  `IP_SALT_SECRET` in staging and production; `idle_in_transaction_session_timeout` and
  `statement_timeout` on the app role; Hyperdrive query caching must stay disabled (a
  correctness requirement of the no-cursor snapshot page); bump `sync_epoch` after any restore.

## Pinned versions (increment 8)

No new runtime dependencies. New shared constants module `limits.ts`: 5 active subscriptions,
2 concurrently live-tracked, 20 new instances per day, 10 anonymous tracker creations per day
per salted IP, 10 refreshes per flight per day, sync page 200, sync retention 30 days,
idempotency TTL 24 h.

## Deviations (increment 8)

- **Migration 0003 goes beyond the spec's list:** `user_sync_changes.row`, the sync horizon and
  epoch rows, `flight_subscriptions.live_tracked`, the new `usage_counters` counter names in the
  check constraint, `deleted_subjects.provider_subject_hash` and `expires_at` with plain indexes
  and a format check. Nothing has been applied anywhere; earlier migrations are untouched.
- **The idempotency middleware is split:** the `/v1` instance resolves the scope and store and a
  route-level gate after the validator does the reservation (the hash is over the validated
  body); `POST /v1/devices` and `PATCH /v1/me/preferences` carry optional gates; the header and
  code names changed to `Idempotent-Replayed` and `idempotency_payload_mismatch` in both slots.
- **A reservation in flight is stored as `response_status` 0 with a 60 s lease** taken over by one
  atomic `UPDATE`, because the columns are `NOT NULL` and a crashed request must not block its key
  for 24 h.
- **`account_deleted` is detected through keyed hashes of the deleted account's session tokens**
  (`deleted_subjects`, kind `session:`, 31 days), because a session cookie carries no user id once
  the session row has cascaded away.
- **The subscribe and search routes insert the five key columns of a `flight_instances` registry
  row when it is missing** (the persist consumer's row may not exist yet; the consumer still writes
  every tracked column).
- **Search requires a session (anonymous sessions accepted)** and the creation caps apply wherever
  a tracker is created; the live window is read from `getState` (48 h before scheduled departure
  until arrived, cancelled or finished).
- **`GET /v1/sync` without a cursor returns the current state as one page** (live subscriptions,
  preferences, their flights) with cursor `(watermark, 0)`; paging arrives when trips and logbook
  entries get writers.
- **The refresh route charges the Postgres sub-budget on every call**, coalesced ones included (K6's
  order: budget, then the tracker); the tracker's own cap counts only real provider calls.
- **Three tests use `createApp()` with injected hooks** rather than `exports.default.fetch()` (the
  409 in-flight test, the transaction-failure compensation, the slow-tracker deadline), because
  holding a request open or failing a transaction on purpose needs injection.
- **`SyncEnvelopeV1` was redefined in place** (no client has shipped); `SyncCursor.seq` is a string
  and the plaintext cursor helpers are gone.
- **The build commit carries the Opus trailer** (the harness attribution instruction took
  precedence for the builder); the fix and close-out commits carry the Fable trailer.
- **Unverified:** a Neon read replica's xmin lag (the route is pinned to the primary and checks
  `transaction_read_only` on every pull); whether a long read-only transaction holds back
  `pg_snapshot_xmin`; the `EXPLAIN` result on Neon at production row counts; whether a Durable
  Object RPC keeps running in production after the Worker answered 504 (proven only in the pool);
  Apple's real `/auth/revoke` errors; the rate-limit binding's per-colo behaviour in production.
- **Carried forward:** per-plan limits (Phase 1); `account_deletion_requests` is not written on the
  synchronous path; increment 9 resets the store on any 410 and increment 10 reads `triedDates`
  from the 404 rather than a suggestion; increment 12 owns the xid-ordered purge, the nightly
  `live_tracked` reconciliation and the KV session tombstone.

## Measurements and decisions (increment 7 review fixes)

- **Spike results (workerd 1.20260918.1 under the Vitest pool).** (1) `setAlarm` inside
  `transactionSync` followed by a throw leaves `getAlarm()` at its previous value; the committed
  control is visible afterwards. (1b, added in review) inside a scheduler-invoked handler a
  rolled-back `setAlarm` leaves the RUNNING alarm's past time visible and it is not re-fired
  after a normal return, so inside `alarm()` a transaction that set an alarm must never be
  swallowed (rethrow, or `deleteAlarm()` / `setAlarm` afterwards); ADR 0011 records it. (2) an
  alarm 200 ms out fires on its own wall clock under the pool, so every Durable Object test
  cancels pending alarms in `afterEach` and keeps its flights in the 2100s. (3) a rejected
  `waitUntil` promise inside `alarm()` neither fails the invocation nor triggers a retry; a bare
  floating rejection reaches the isolate's `unhandledrejection` and fails the vitest run, so tests
  that expect an RPC to throw call the instance through `runInDurableObject`. (4) foreign keys
  are enforced: child rows are deleted first; `deleteAll()` needs no ordering.
- **Retry decisions come from the committed schedule (rulings L13, L16).** The first build judged
  a retry's freshness by the age of the LAST attempt, so a slot whose step 1 rolled back could be
  skipped and its alarm consumed, and a final-slot retry landed in `skip_io` with no finish and no
  alarm (both reproduced under the real local scheduler). A retry now reads
  `next_refresh_at_ms`: in the future or NULL means step 1 committed (re-assert the alarm, or run
  the finish path when the plan has no next slot); at or before now means it rolled back (poll).
  The `retryCount >= 5` backstop arms now + 30 s without overwriting the grid slot, and the ladder
  applies to the finish and cleanup alarms too. `flight-tracker.scheduler.test.ts` drives these
  with `setAlarm` a few hundred milliseconds out plus a one-shot injected transaction failure,
  because `runDurableObjectAlarm` never delivers a platform retry.
- **Every refresh path finishes a flight (L12).** Only `alarm()` acted on the apply outcome's
  finish; a `forceRefresh` (user, reconcile) or an alert merge that saw the flight end left the
  tracker unfinished with a NULL `next_refresh_at`, which the reconcile cron never selected.
  All paths now run the same finish; the tracker never persists a NULL `next_refresh_at` for an
  unfinished phase; the cron also selects active rows with NULL `next_refresh_at` and a stale
  `updated_at`.
- **No `deleteAll()` ever discards an unsent outbox row (L2).** The finish alarm and the
  resolver's expiry alarm re-arm hourly while rows remain, raise one ops alert after the sixth
  deferral (`flight_tracker_outbox_stuck`, `designator_resolver_outbox_stuck`) and delete only
  once every row is confirmed (tracker) or sent (resolver). A resolver send that fails at resolve
  time retries an hour out instead of at the 24 h expiry.
- **A finished flight never gets a second lifetime (L9).** The resolver answers a search for a
  flight that is over from the fetched status and seeds nothing; migration 0002 adds
  `flight_instances.do_lifetime_epoch_ms`, the persist consumer ignores older-lifetime rows and
  refuses a newer lifetime for a terminal instance with the `flight_lifetime_rejected` alert; the
  R2 archive key is `events/{key}@{epochMs}.json`, written with `onlyIf: { etagDoesNotMatch }`.
  Increment 8's search route reads `flight_designators` and `flight_instances` before the
  resolver, and its migration becomes 0003.
- **The alarm joins an in-flight refresh, and refreshes coalesce on freshness (L14, L15).** The
  spec-lens skeptics judged the first build's contract satisfied (coalescing only while a fetch
  is in flight); overruled, because increment 8's acceptance is 500 refreshes in 60 s producing
  one provider call. `USER_REFRESH_FRESHNESS_MS` (60 s) answers from the snapshot without charging
  the user's cap; a slot satisfied by a refresh inside its tier interval makes no call (a scheduled
  poll never satisfies a slot, so the cadence stays at 74); the finish path runs under a
  `finishing` marker the refresh paths await; a user refresh is denied at the per-flight hard cap.
- **A provider fetch cannot hang (L3).** `PROVIDER_FETCH_TIMEOUT_MS` (30 s, `AbortSignal.timeout`
  on the fetch the tracker hands the router) turns a silent gateway into one billed transport
  record; `health()` reports `inflightSinceMs`; the reconcile consumer refreshes anyway past
  `INFLIGHT_STALE_MS` (5 min) and `forceRefresh('reconcile')` abandons the stale handle.
- **A configuration error is a provider error (L17).** `providerFor` runs inside the fetch try in
  the tracker and the resolver; a missing key is a zero-cost error record with the schedule kept
  and one `provider_config_error` alert per instance, never a thrown alarm.
- **Rows written are a budgeted number (J5, L6).** 1,200 rows per A2 lifecycle flight including
  the schema DDL (which `runSqlMigrations` now counts), 13 per unchanged alarm, 16.2 per alarm on
  average with seed, subscriptions, confirmations, finish and deletion spread over 74 alarms;
  `ROWS_WRITTEN_BUDGET_PER_FLIGHT = 1600` is asserted by the lifecycle test. Largest `sendBatch`
  seen 7 messages, largest message 1,635 bytes, median `flight_instance` message 1,318 bytes.
- **Outbox protocol (J3, L1).** Rows are written inside the transaction, sent after commit in
  byte-chunked batches (100 messages, 240 KB, a 120 KB single-message cap; an oversize row is
  dropped with an `outbox_oversize` event), `sent_at` set on acceptance, deleted only on the
  persist consumer's `confirmPersisted` RPC; unconfirmed rows older than a 10 s grace are re-sent
  by the next flush. Seqs come from `flight.outbox_next_seq` because SQLite reuses rowids.
  The instance row is appended before the events of its transaction so a batch never carries an
  event ahead of its instance.
- **Persist consumer.** The Analytics Engine point is written only when the `provider_calls`
  insert returned a row (Queues is at-least-once); `provider_call_daily` rows from the ProviderBudget
  object are stored per shard under `budget_daily` / `budget_daily:{n}` with replace semantics
  (the increment 12 roll-up excludes them); the DLQ handler retries a failed R2 archive within
  `max_retries` and acknowledges with the body logged on the last attempt.
- **KV snapshot (L11).** The debounce's `pending` flag is load-bearing: a suppressed write is
  performed by the next entry point once the 2 s gap has passed, and `#finish` writes the final
  snapshot itself after the flush, waiting the remainder of the one-second per-key gap with
  `scheduler.wait` inside the running alarm (the one permitted in-request wait).
- **vitest exited 0 on test failures since increment 3 (re-review finding, ruling M1).**
  `embedded-postgres` registers `async-exit-hook` at import, which hooks `beforeExit` and calls
  `process.exit(0)`, overriding the `exitCode = 1` vitest sets on failure, in `apps/api` and
  `packages/db`, locally and in CI (where no embedded cluster is even started). The re-reviewer
  proved it with a deliberately failing test (exit 0) and with this round's own full check, where
  turbo reported eleven successful tasks while the api suite had one failure. Fixed in this
  increment: the hook is removed right after the import, `scripts/vitest-exit-guard.mjs` runs a
  deliberately failing fixture in both packages and asserts a non-zero exit, and CI runs it after
  the test jobs. Every earlier increment's local full check printed zero failures, so the earlier
  branches are believed clean, but a green CI run before this fix proved nothing.
- **Second-lifetime gate (ruling M2).** The first fix answered a search without a tracker only
  for `arrived` and `cancelled`; a diverted flight or an uncovered past-date flight still seeded
  a tracker that finished on the spot and, after its deletion, a second lifetime that the persist
  consumer refused with the fatal alert. `flightIsOver` now asks the cadence (nothing left to
  schedule), the same decision the tracker's seed takes.
- **Dead-lettered rows heal, they are not confirmed (rulings M3 and N1 to N3, the orchestrator's
  own reversal).** Ruling M3 had the dead-letter handler confirm archived persist messages so a
  finished tracker could delete itself; the final re-review showed that a message dead-letters
  after five retries spanning about a minute, which covers a transient Postgres or Hyperdrive
  outage as much as a poison row, so confirming it deleted rows that used to heal on the next
  flush. Reversed: the DLQ handler only reports dead-lettering (`confirmPersisted` with a
  `deadLettered` flag stamps `dead_letter_count` and `last_dead_lettered_at_ms` on the row;
  FlightTracker migration 002), and the tracker re-sends such a row with a spacing that doubles
  from 1 h to a 24 h cap, so an outage heals on the first re-send after recovery and a poison
  row settles at one DLQ event per day while the stuck alert still fires once. A message the
  consumer acknowledges as unreadable is still confirmed (that failure is permanent). The
  DesignatorResolver deletes its cost-record rows on send, so after a dead-lettering they exist
  only in the DLQ's R2 copy: an accepted Phase 0 residual, closed by the increment 12
  housekeeping replay of `dlq/persist/` recorded in ADR 0011.
- **Finish-alarm timing and the resolver's bind limit (rulings M4, M5).** A cadence alarm
  arriving while a refresh was finishing the flight ran the +22 h logic at once (the object was
  deleted about 21 h early); the finished branch now computes the due time and re-arms an early
  alarm without counting a deferral. The resolver's flush chunks its `IN` list at 90 binds like
  the tracker, so a backlog of failed searches can no longer wedge a designator.
- **Test host note.** The 74-alarm lifecycle walk and the ProviderBudget per-second test (1,332
  sequential RPCs) exceeded the 60 s `testTimeout` under full host parallelism (stray
  `wrangler dev` processes from the increment 4 build were found and stopped during this
  close-out); both carry an explicit 180 s per-test timeout now (ruling M1).

## Pinned versions (increment 7)

No new runtime dependencies. New shared constants: `USER_REFRESH_FRESHNESS_MS` 60 s,
`INFLIGHT_STALE_MS` 5 min, `PROVIDER_FETCH_TIMEOUT_MS` 30 s, `ROWS_WRITTEN_BUDGET_PER_FLIGHT` 1,600,
`OUTBOX_RESEND_GRACE_MS` 10 s, `FINISH_RETRY_MS` 1 h.

## Deviations (increment 7)

- **Finish happens after the cadence's post-arrival tail poll**, not at the poll that saw `in`:
  the shared simulation counts the poll after arrival, so finishing at `in` would give 73 calls
  and fail the acceptance; `finish_reason` still reads `arrived`.
- **The outbox has no `confirmed_at` column**; a confirmed row is deleted, with a 10 s re-send
  grace for acknowledgements still in flight.
- **The reconcile cron selects `ACTIVE_TRACKING_STATES`** (`pending`, `tracking`, `airborne`,
  `landed`) from `@planeahead/db`; the schema has no `active` value.
- **A deleted or never-seeded tracker answers phase `absent`** and arms a 60 s cleanup alarm from
  every entry point, so an empty schema is never billed for long; `subscribe` and `getState` on
  it throw a typed `RpcRequestError(invalid_request)` that increment 8 maps to 404 or 410.
- **The soft cap stretches by skipping one grid slot** (a doubling inside a tier), and the hard
  cap's finish reason is `arrived` when its one reconciliation poll saw the flight in.
- **Test seams are public fields set through `runInDurableObject`** (outbox sink, KV, bucket,
  provider deps, caps, fetch timeout, row counters), the pattern ProviderBudget established.
- **The Worker-side resolve helper lives in `src/search/resolve.ts`** and waits with
  `scheduler.wait`; the Durable Object modules contain no timer of any kind.
- **`src/providers/router.ts` reads `AERODATABOX_BASE_URL`** (tests point it at the fake-provider
  server); `src/observability/ops-alert.ts` gains the queue and lifetime events; the increment 4
  and 6 tests were updated for the real schema versions, the reconcile queue and the validated
  persist messages.
- **Unverified:** workerd's retry time after a handler that called `setAlarm(next)` and then threw
  (the design is safe either way); the platform's billing counter is assumed to agree with the
  pool's `rowsWritten`; the "generating too much load" error is matched on its message text;
  whether an RPC throw across the stub boundary surfaces as an unhandled rejection in production
  as it does under the pool.
- **Carried to increment 8:** the search route's optional `origin` and the `flight_designators`
  read (the resolver's existing-tracker probe needs an origin); the 404 / 410 mapping for absent
  trackers; migration numbering (0003).

## Measurements and decisions (increment 6 review fixes)

- **The T-48h window (blocker, adapter-fidelity-1).** AeroAPI's bracket is `[scheduled_out - 1 d,
scheduled_out + 1 d)` clamped to 10 days back and 2 days ahead of now. At exactly T-48h the
  clamped end equals `scheduled_out`, the exclusive bound, so the request would have been billed
  and answered with the previous day's instance at the inclusive start. `containingWindow` now
  returns null unless the flight sits at or after the start and at least `horizonMarginMs`
  (5 min) before the end, and `router.aeroApiAllowedAt` is defined as `bracketWindow(...) !==
null`, so the router and the bracket cannot disagree at any instant; the T-48h slot goes to
  AeroDataBox and a live-mode A2 walk makes `A2_EXPECTED_POLLS - 1` AeroAPI calls. A designator
  answer returns only the instance nearest `scheduled_out` (within 12 h, with its diversion leg).
- **The operating designator comes from the callsign as a whole (ruling I3, revised).** The first
  build paired a callsign's carrier with the marketing number: `BA1512` flown as `AAL100` keyed
  as `AAL-1512-...`, which is American's own AA 1512 from the same airport on the same day (one
  object and one row for two aircraft). `resolveOperator` now returns the operating flight
  number too: a callsign supplies both halves (`AAL-100-...`), a hint or the marketing carrier
  keeps the marketing number, and an alphanumeric ATC callsign (`BAW12AB`) is not used at all.
  The collision case is a test in shared and in the adapter; ADR 0010 is amended.
- **`dateLocalRole=Departure` (ruling I1).** The path date is the origin-local scheduled
  departure date the key carries, so an overnight flight is never returned under its arrival
  date and the resolver in increment 7 matches on it directly. Pinned against the vendored spec.
- **AeroAPI's account-wide alert endpoint is set before the first alert (ruling I7).** The 4.17.1
  spec makes `PUT /alerts/endpoint` a prerequisite for `POST /alerts`; `registerAlert` PUTs this
  environment's token-bearing webhook URL once per isolate (zero-cost `alert_manage`) and then
  posts with the same URL as the per-alert `target_url`; the router builds that URL only from a
  well-formed 256-bit token, the same check the receiver applies. Whether staging and
  production need separate AeroAPI keys (the account endpoint is shared per key) is an open owner
  decision recorded in ADR 0010 for Phase 1.
- **Webhook receivers are exempt from the IP limiter (ruling I2).** A provider delivers from a few
  shared addresses, so a per-IP brake would drop real deliveries first; the 256-bit path token
  and queue backpressure bound them instead. Trade-off recorded in threat model section 3.1.
- **A closed budget day is read-only (budget-and-do-1).** After the 00:05 UTC alarm a late call
  never recreates the day: `reserve` refuses with `routing_rule`, the other RPCs answer the closed
  snapshot without throwing, no second daily row is sent, and every outbox origin carries the
  object's lifetime epoch so `(origin, seq)` stays unique. Migration 001 (never applied) was
  regenerated in place.
- **The webhook token stays out of Sentry (budget-and-do-2).** The scrubber's deep pass redacts
  `/v1/webhooks/{provider}/{token}` from every string in an event, `url.path` and span
  descriptions included; a real-chain test asserts the serialised envelopes.
- **ProviderBudget hardening.** The KV copy is written in the background (`ctx.waitUntil`, one
  write in flight, never on a debit's path; a failure waits out KV's one-write-a-second limit);
  `BudgetRequest.utcDate` is set once by `http.ts` so a reservation and its release land on the
  same day across midnight; the persistent kill switch is read in `#prepare` and the day fails
  closed (`persistent:unknown`, alert raised) when it cannot be read, lifting itself on a later
  read; transport errors (a rejected `fetch`) are billed and keep the reservation; a
  `WorkerCostLogger` can share one `AnalyticsBudget` per invocation.
- **Token bucket semantics (budget-and-do-7, and the close-out decision).** Neither provider says
  whether "N per second" is a fixed or a rolling window, so the bucket holds the stricter bound:
  at most N grants in any one-second window, with half the limit as burst and the rest as refill
  (`bucketForLimit`). The re-review noted (minor) that a burst of one with `N - 1` a second nearly
  doubles the sustained rate; rejected on purpose: a rate refusal is a lost poll slot, not a wait
  (the provider layer has no timers, `http.ts` records `rate_limited` at zero cost), debits are a
  Poisson stream of about 3.4 a second, and a one-token burst would drop roughly a third of
  clustered alarms while the half split absorbs them and still clears the mean. Recorded in the
  module comment with the revisit trigger (mean debit rate near half the plan limit).
- **Close-out fixes from the re-review's nits.** `localMinuteToUtcMs` put a spring-forward gap
  time an hour before the gap, which inverted a local board window straddling 02:00 in the AeroAPI
  adapter only; a gap time now lands on the transition itself (monotonic mapping, tested for the
  gap, the fall-back and a straddling window). The kill-switch comment claimed a 30 s recovery;
  through the guard the blocked KV copy bounds it at `BUDGET_KV_TTL_SECONDS` (60 s), now stated.
- **Pending measurements (ruling H9).** AeroDataBox lookahead per plan and p50 / p95 flight-status
  latency are unmeasured: there is no key. `scripts/record-adb-fixtures.mjs --probe-lookahead
--samples` records both once a Growth key exists; the adapter reads `maxDaysAhead` from config.
- **Migration 0000 regenerated (ruling I4).** The `packages/db` `ALERT_EVENTS` mirror drops
  `hold_start` and `hold_end`; the check constraint in migration 0000 and its snapshots were
  regenerated in place (nothing has ever been applied) and the contracts test asserts identical
  lists again.

## Pinned versions (increment 6)

No new runtime dependencies. Two vendored provider specifications, each with its SHA-256 pinned
in the adapter tests so a silent upstream change fails the build:

| Snapshot                                                       | Version  | SHA-256 (prefix)                   | Source                                                                       |
| -------------------------------------------------------------- | -------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| `apps/api/src/providers/specs/aerodatabox-direct-v1.15.3.yaml` | 1.15.3.0 | `9d2d6b908c57dc9a3e3f9b24ff5df907` | https://doc.aerodatabox.com/docs/openapi-direct-v1.yaml                      |
| `apps/api/src/providers/specs/aeroapi-v4.17.1.yaml`            | 4.17.1   | `3023e7a0c54c86be61d130eacf9a42`   | https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml |

## Deviations (increment 6)

- **Adapter tests run in the Workers pool with an injected `fetch` stub**, not Node-side Vitest
  with an undici MockAgent as the spec says (ruling H8: no undici, fetch injected).
- **The plus-or-minus-one-day retry runs only for the `user_search` and `import` triggers.** A
  tracker poll (alarm, reconcile, user refresh) makes exactly one call: retrying a miss on a
  neighbouring day would bill four more units and could attach another day's flight to a
  canonical key (ruling I5, stated in the adapter, the router contract and the shared interface).
- **Shared extras beyond the H1 list:** an AeroDataBox `health` operation at 0 units (a free
  check still needs a priced operation for its call record), the `provider_rate_limit` denial
  with `retryAfterMs` and an optional `BudgetGuard.backoff`, and the enums the new pure functions
  need (`ADB_STATUSES`, `CODESHARE_STATUSES`, `PRE_48H_RELAXATION_REASON`).
- **`deriveStatus` also takes `estimatedOut` and `boardingMinutesBefore`** (default 40, the
  cadence's boarding anchor) so a delayed flight does not read `boarding` too early;
  `disambiguateRevisedTime` takes the movement and returns the delay in seconds.
- **AeroDataBox cancellation and diversion come from its status enum** (`Canceled`, `Diverted`
  via `adbFlags`) and feed `deriveStatus` as flags; `CanceledUncertain` is not cancelled. The
  enum is never mapped straight onto our nine values.
- **`AEROAPI_MODE`, `ADB_PLAN` and `ADB_ALERTS_ENABLED` are optional settings** with cautious
  code defaults (`mock`, `starter`, `false`), listed in `.dev.vars.example` and `.dev.vars.test`
  rather than in `wrangler.jsonc` vars, so a deployment with none set stays safe.
- **The kill-switch Sentry event is raised by the persist consumer**, fed by an outbox row the
  ProviderBudget object sends at once: a Durable Object RPC has no Sentry client, and
  `instrumentDurableObjectWithSentry` would proxy storage on the hot debit path.
- **ProviderBudget has more than H4 lists:** `configure`, `backoff` and `ping` RPCs, a manual kill
  switch persisted in CONFIG KV so the next day's object starts killed, the daily cap tripping the
  switch automatically, an unpriced operation refused as `routing_rule` rather than thrown across
  RPC, and the eight-way sharding hook.
- **ADR 0010 also records the webhook path-token decision and its residual risk** (Cloudflare's
  invocation logs keep request URLs); 0011 stays reserved for increment 7.
- **Files outside the spec's list were touched** where the routes and fixtures needed it:
  `src/middleware/sentry.ts` (token redaction, the one allowed exception to the H7 middleware
  freeze), `src/middleware/rate-limit.ts` (ruling I2), `src/queues/persist.ts` and
  `provider-events.ts` (outbox kinds), `routes/v1.ts`, `tsconfig.json` (fixture JSON includes).
  Auth, idempotency, FlightTracker and DesignatorResolver are untouched.
- **Unverified, no key or account:** every fixture is synthetic (no real AeroDataBox or AeroAPI
  response has been seen, including the Cloudflare HTML 403, AeroAPI's 429 shape and the
  `DateTimeContract.local` format); whether AeroDataBox rewrites `arrival.airport` on a diversion;
  whether 451 and other JSON errors are billed (recorded as billed, the conservative direction);
  `revisedTime` read as a gate time; which AeroAPI codes carry gate changes (`change`,
  `minutes_out`, `power_on` map to `update`); ProviderBudget's live behaviour (KV 429 under load,
  the real 00:05 alarm, `locationHint`); the provisional daily caps (AeroAPI 10,000 result sets,
  AeroDataBox monthly quota / 30).
- **Owner tasks carried forward:** buy AeroDataBox Growth before real users; ask FlightAware in
  writing whether errors and empty results are billed and what a rate-limit breach returns;
  decide EU jurisdiction for Durable Objects before the first production tracker exists; decide
  one AeroAPI key per environment or one shared (ADR 0010).

## Measurements and decisions (increment 5 review fixes)

- **`better-auth/minimal` versus `better-auth` (ruling F3).** The Worker imports `betterAuth`
  from `better-auth/minimal`, which exposes everything the Drizzle adapter, the anonymous and
  magic-link plugins, the Expo plugin and the PlaneAhead plugin need (nothing was missing, no
  fallback). `wrangler deploy --dry-run --env staging` on the fix-round build: minimal
  3020.03 KiB raw / 571.04 KiB gzip; the same build with the full entry point 3739.89 KiB /
  674.71 KiB. The minimal entry saves 719.86 KiB raw and 103.67 KiB gzipped (the Kysely
  exclusion); the import is pinned to `minimal`.
- **Magic-link cap keying (ruling G1, revised in the second round).** Three counters. The
  owner budget (3 per hour, 10 per UTC day) is keyed by the address AND the requester, the valid
  `X-Install-Id` when present, else the client address: the owner's own device keeps its own
  budget. The address ceiling (10 per hour, 30 per UTC day, every requester combined) bounds what
  one inbox can receive whatever the attacker's address supply. The requester brake (429; 100
  per hour, 300 per UTC day across addresses) is keyed by the client address, else the install
  id, because the brake cannot be keyed by a value the client chooses and rotates. The client
  address is reduced the way Better Auth's limiter reduces it (IPv6 to /64) before any keying:
  the re-review's probe sent 25 requests for one inbox from 25 /128s in one /64 and got 25
  mails, because each was a new requester; and the first round's 20-per-hour brake was found to
  lock a whole NAT egress out, so the brake moved to NAT scale and the ceiling took over the
  mail-bomb bound. `better-auth` does not re-export `normalizeIP`, so `src/validation/client-ip.ts`
  carries a 40-line equivalent pinned to Better Auth's documented outputs by a unit test.
- **Session refresh on `/v1` (ruling G7, settled in the second round).** Forwarding the refreshed
  cookie on `/v1` only works for a client that stores it, and the increment 9 client does not
  (the Expo client stores cookies from its own `/api/auth/*` requests only). The auth middleware
  now reads the session with `disableRefresh` and `/v1` never emits `Set-Cookie`; the refresh
  happens on `GET /api/auth/get-session`, and the increment 9 spec now requires the session gate
  to call it on launch and on foreground, with a Jest test.
- **Push tokens across users (ruling G10, amended).** A token moves to the caller when the
  registering installation is the one the token's device row already names (account switch on
  one phone; cross-device magic link whose merge was withheld), checked inside the upsert's
  `ON CONFLICT ... WHERE` with a correlated subquery on `devices`; a different installation is
  still refused with `push_token_conflict`.
- **Landing page referrer policy.** `no-referrer` made Chromium send `Origin: null` on the
  page's own form post, so the consume route refused its own button. The page now declares
  `strict-origin`, and the consume route accepts `Origin: null` only with
  `Sec-Fetch-Site: same-origin` and refuses cross-site and same-site outright. The page is
  deliberately not a custom-scheme hand-off to the app (scheme squatting on Android).
- **Magic-link landing page (ruling G3).** The emailed URL is `${API_PUBLIC_URL}/auth/magic-link`
  outside the Better Auth mount; increment 9's universal-link prefix moves from
  `/api/auth/magic-link/*` to `/auth/magic-link*` (the increment 9 spec is updated).
- **Transaction test seam (ruling G4).** `createAuth` gained an optional `databaseHooks` dep used
  only by `auth-transaction.test.ts` to make the account INSERT of a new sign-in fail after the
  user INSERT; the Worker passes none.
- **NUL bytes (rulings G6 and G14).** Refused with 400 at every JSON boundary (the auth mount,
  `/v1/devices`, `/v1/me/preferences`) rather than only in the magic-link body, because Postgres
  refuses U+0000 in any text or jsonb value and every such input was a 500 on demand.
- **Facts settled by tests (ruling F7).** The Drizzle adapter rolls back a transaction with
  `transaction: true` (`auth-config.test.ts`); Better Auth's `runWithTransaction` was a
  pass-through without it (the fix-round finding); the anonymous after-hook fires for a plugin
  endpoint reached over HTTP and receives `ctx.query` (the requester binding relies on it);
  workerd's KV enforces the 60 second TTL floor (`used-tokens.ts` clamps to it).

## Deviations and decisions (increment 4 review fixes)

Applied on top of `b824ae4` after the Opus review panel. The spike results ruling E8 asks for are
recorded where they are load-bearing rather than repeated here: spike 3's answer (`PUBLIC_RL`
DOES enforce inside the Workers Vitest pool, 300 calls against the 120-per-10-s binding returned
180 failures) is the docstring of `apps/api/test/workers/rate-limit.test.ts`, and the `exports`
and alarm findings are in `apps/api/vitest.config.ts` and `apps/api/test/workers/do-ping.test.ts`.

- **The middleware chain moved to `apps/api/src/app.ts`.** `createApp()` is now the only place
  `use()` is called on the root app, and every test that needs the chain calls it. The chain's
  registration order is a runtime contract, and three test files had been reproducing it inverted
  (auth registered before the middleware under test), which is why a Worker that answered 500 to
  every mutating request carrying an `Idempotency-Key` shipped with 74 green tests. `src/index.ts`
  still owns the routes, because only the chained `.route()` expression carries the RPC types.
- **`c.var.user ?? null` everywhere ahead of the auth slot.** The `Variables` generic types the
  value as `AuthenticatedUser | null` and cannot express "not set yet", so a strict `=== null`
  test reads `user.id` off `undefined`. Applied to `storeFor`, `scopeFor`, `principalLimiter` and
  `requireUser`; the last one failed OPEN before, which is the dangerous direction for a guard.
- **`handleError` keeps Hono's `HTTPException` branch.** A custom `onError` without it turns every
  401, 403 and 413 signalled by a throw into an opaque 500. Nothing in increment 4 throws one (the
  house convention is to return the response), but increment 5 mounts the first thrower.
- **Sentry: stop capturing rather than scrub.** `sendDefaultPii: false` does not stop request body
  capture, so `sentryOptions` replaces the default `httpServerIntegration` with
  `maxRequestBodySize: 'none'`. `beforeSendTransaction` was added alongside `beforeSend`, which
  only ever sees error events. The end-to-end test added for this then found a leak no hand-built
  event could have: `url.query` and the query half of `url.full` ride out as SEGMENT SPAN
  attributes, which `event.request` does not cover. The scrubber now clears body, header and query
  attributes from `contexts.trace.data` and from every `spans[].data`.
- **Unauthenticated idempotency scopes are per `X-Install-Id`**, the client-owned install id
  increment 5's `POST /v1/devices` registers, not one shared `anonymous` bucket and not the
  client IP. The first fix round scoped by `CF-Connecting-IP`, which closed the cross-caller leak
  only for callers on different addresses and broke the one retry the key exists for: a phone
  moving from WiFi to LTE mid-retry changed scope and created its resource twice. A keyed request
  with neither a user nor an install id is answered 400 `idempotency_scope_missing` rather than
  run without the guarantee it asked for. Ruling E6 stands (idempotency ahead of auth), so the
  Postgres store and the per-user scope stay in the file as the documented path for the `/v1`
  mount behind auth in increment 8 and are stated, in code and in tests, to be unreachable from
  the global slot until then.
- **New ESLint rule `planeahead/no-literal-control-characters`**, with a RuleTester unit test and
  a `.gitattributes` backstop. A raw NUL in a template literal made git classify
  `apps/api/src/middleware/idempotency.ts` as binary (`Bin 0 -> 9233 bytes`), costing the one file
  no diff-based review could read its diff, its line-level comments and its three-way merge.
  Prettier, tsc and the toolchain guard all accepted it. The rule scans raw source text, so a
  control character in a comment or a regex is caught too, and it is enabled for every linted
  file rather than only `apps/api/src`.
- **The cron seam is async now**, while every handler is one log line: `runCron` and `scheduled`
  return `Promise<void>`, handlers are typed `CronHandler`, and the expression table is injectable
  so a rejected handler's path is testable. Increment 7's reconcile has to page and enqueue, and a
  `void` seam offered only two bad ways to express that.
- **`SqlMigrationError` gained `kind` and `foundVersion`.** The version-ahead path used to put the
  object's schema version in `migrationId`, which told an operator that a migration that had
  applied cleanly was the failure. `migrationId` is now always an id this build cannot account
  for.
- **`AnalyticsBudget` counts a missing dataset as `skipped`, not `failed`**, and names it once per
  invocation as `analytics_dataset_missing`. A missing `analytics_engine_datasets` block (a
  non-inheritable key) used to report exactly like a batch of oversized points.
- **`truncateToBytes` cuts on a codepoint boundary.** Slicing bytes and decoding puts U+FFFD at
  the cut, which re-encodes to three bytes, so the clamp could return a value LARGER than the
  platform limit it exists to enforce.
- **turbo.json names the migration journal and the generator** in the `typecheck` and `test`
  inputs. `scripts/**` resolves inside the package (`apps/api/scripts`, which does not exist), so
  a new migration used to cache-hit and replay a stale `up to date` line while the compiled-in
  `MIGRATION_HASH` still reported the previous schema. The `test-workers` CI job now also runs
  `gen-migration-hash.mjs --check`, because it regenerates the file before vitest and would
  otherwise test the value it just wrote.
- **`deploy-staging.yml` got the path filter its header already claimed**, and repeats typecheck,
  lint, the Worker suite and the dry run as steps before the deploy. ci.yml is a separate workflow
  triggered by the same push, so nothing ordered the two and a commit that failed CI still ran
  forward-only migrations against the staging Neon branch. `workflow_run` was rejected: it fires
  on completion regardless of conclusion and resolves the workflow file from the default branch.
  The `@planeahead/db` suite is deliberately not repeated there; it needs ci.yml's service
  container.
- **vitest, `@vitest/runner` and `@vitest/snapshot` are exact `4.1.11`**, matching the facts
  sheet. The tildes floated to any 4.1.x and nothing in the repository enforced the pinned value
  (the toolchain guard's pair assertion covers wrangler, by design).
- **`testTimeout` is 60 s, not 30.** The old comment's "about 10 seconds" understated the cold
  first-request cost by 2x. The number varies by an order of magnitude with the Vite transform
  cache, so the comment now gives the range and the reason rather than one figure.
- **`.dev.vars.example` lists the rest of the secret set** from plan section 5 as commented-out
  placeholders tagged with the increment that turns each one on, so the file is a checklist rather
  than a snapshot of what increment 4 happens to read.
- **`deploy-staging.yml` checks the migration hash first, immediately after install.** The first
  fix round inserted typecheck, test and the dry run between install and the `--check` step, and
  the api `typecheck` and `test` scripts regenerate the constant, so the check compared the file
  they had just written and could never fail. `tools/workflows/migration-hash-check.test.js`
  (run by the root `test:tools` script, which replaces `test:eslint-rules`) asserts in every job
  that checks that the check precedes every regenerating step.
- **`registerChain` returns the order it registered.** `MIDDLEWARE_ORDER` was a hand-maintained
  list compared to a literal copy of itself, and the suite stayed green with cors and rate-limit
  swapped in the code. The slots are now `[name, handler]` pairs the loop registers from, and
  chain.test.ts compares the returned names to the constant.

## Pinned versions (increment 5)

| Package           | Pin             | Resolved | Why this pin                                                                                                     |
| ----------------- | --------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| better-auth       | `1.7.5` (exact) | 1.7.5    | Runtime schema validator and plugin surface verified at this tag; `better-auth/minimal` entry point.             |
| @better-auth/expo | `1.7.5` (exact) | 1.7.5    | npm-pinned to better-auth 1.7.5; server plugin for trusted origins and the Expo client transport.                |
| jose              | `^6.2.12`       | 6.2.12   | RS256 verification against Apple and Google JWKS; `createRemoteJWKSet` at module scope (no I/O at construction). |

## Deviations (increment 5)

- **Magic links are verified in the app**, and the emailed URL is a non-consuming landing page (`/auth/magic-link?token=`) with a consume route for browsers, so mail scanners cannot burn the token and no cookie rides in a redirect.
- **The anonymous merge only runs for the anonymous user who requested the link** (a `verifications` side row keyed by the hashed token); a stranger's link signs the verifier in without merging.
- **Magic-link caps** are three: an owner budget per (inbox, requester), a per-inbox ceiling that counts mail the provider accepted, and a NAT-scale per-client-address brake (IPv6 reduced to its /64 the way Better Auth does). Subjects are SHA-256 of a canonical mailbox.
- **`/v1` does not extend the session**; the sliding 30-day session refreshes on `GET /api/auth/get-session`, which the app calls on launch and foreground (increment 9).
- **Push tokens move across users only from the installation that holds them.**
- **Apple `email_required` applies only to a new account**; returning users are found by subject first.
- **Idempotency scope for anonymous callers is `X-Install-Id`** (increment 4), preserved through devices and the merge.
- **The Workers test pool now starts embedded Postgres** through a shared harness; CI gives the `test-workers` and staging deploy jobs the `postgres:18` service container.

## Pinned versions (increment 4)

| Package                                  | Pin                        | Resolved | Why this pin                                                                |
| ---------------------------------------- | -------------------------- | -------- | --------------------------------------------------------------------------- |
| wrangler                                 | `4.135.0` (exact)          | 4.135.0  | Pair-locked to the Vitest plugin's bundled wrangler by the toolchain guard. |
| @cloudflare/vitest-plugin                | `1.1.13` (exact)           | 1.1.13   | `cloudflareTest()` plugin; SELF is deprecated; Vitest 5 breaks the pool.    |
| vitest, @vitest/runner, @vitest/snapshot | `4.1.11` (exact)           | 4.1.11   | The plugin's peers, declared explicitly for the isolated linker.            |
| hono                                     | `^4.13.8`                  | 4.13.8   | Chained app for a complete `AppType`.                                       |
| @hono/zod-validator                      | `^0.9.1`                   | 0.9.1    | Zod 4 support.                                                              |
| @sentry/cloudflare, @sentry/hono         | `10.75.0` (exact, matched) | 10.75.0  | `sentry()` middleware plus `withSentry`; the pair must match.               |

## Deviations (increment 4)

- **Middleware chain order stays request-id, sentry, cors, rate-limit, idempotency, auth** (ruling E6), so idempotency scopes anonymous callers by the client-owned `X-Install-Id` header (400 `idempotency_scope_missing` when a keyed request has neither a user nor a valid install id) rather than by IP. The specs for increments 5, 8 and 9 carry the header.
- **Queue and cron handlers take a context object** `{ env, ctx, log }` rather than loose arguments.
- **`/health` reports `migrationCount`** alongside the four fields the spec named.
- **CI splits the api suite into a Postgres-free `test-workers` job** and filters the api package out of the container-backed `test` job; a `wrangler-dry-run` job and a migration-hash ordering guard (a test over the workflow files) were added.
- **`@cloudflare/workers-types` is transitive only**; `worker-configuration.d.ts` (generated by `wrangler types`) is committed and excluded from Prettier and ESLint.
- **The rate-limit test drives the real binding** (spike 3 showed it enforces in the pool), and every DO test drains alarms in `afterEach` (spike 2 showed test-scheduled alarms fire on their own).

## Pinned versions (increment 3)

| Package           | Pin                      | Resolved       | Why this pin                                                                                           |
| ----------------- | ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------ |
| drizzle-orm       | `0.45.2` (exact)         | 0.45.2         | API surface restricted to what 1.0 rc keeps; migration format is version-specific.                     |
| drizzle-kit       | `0.31.10` (exact)        | 0.31.10        | Generates the committed SQL; the generated-column index-drop bug (issue 4929) is guarded by a test.    |
| postgres          | `^3.4.9`                 | 3.4.9          | The single driver on every path (Workers via Hyperdrive, CI, scripts, tests).                          |
| embedded-postgres | `18.4.0-beta.17` (exact) | 18.4.0-beta.17 | Real PostgreSQL 18.4 binaries in the npm tarball; open hang reports, so every call has a 60 s timeout. |
| geo-tz            | `^8.1.9`                 | 8.1.9          | Fetch script only (ODbL boundary data); the reviewed output is committed as curated data.              |

## Deviations (increment 3)

- **70 tables, not 61.** The spec's normative list has 70; the plan's figure was a miscount. The catalog, the vitest comment and the tests say 70.
- **Frozen `flight_key` expression uses `extract`/`lpad`**, not `date::text`: the text cast of a date depends on `DateStyle` and Postgres rejects it as not immutable in a generated column.
- **`instant()` is a custom type** that normalises Postgres's session-zone text to an ISO-8601 UTC string, so `mode: 'string'` values satisfy shared's `IsoInstantSchema`; the session zone is also asserted UTC by the test harness and documented as an `ALTER ROLE ... SET TimeZone = 'UTC'` environment step.
- **Format checks on 37 code columns** (ICAO, IATA, hex, flight number) beyond the three the spec named; `flight_events.type` is deliberately unconstrained (the DO's zod schema owns that vocabulary).
- **Composite airport foreign keys**: `(origin_airport_id, origin_icao, origin_tz)` and `(destination_airport_id, destination_icao)` reference `airports`, so a resolved airport cannot disagree with its row; `airports.icao` accepts OurAirports idents of 3 to 8 characters when `icao_source = 'ident'`, and 181 seeded scheduled-service airports therefore cannot yet be a flight origin (documented deferral: synthetic `ZZxx` codes are an open decision).
- **`deleted_at` also on `logbook_entries`** (a sync entity per shared's `SYNC_ENTITIES`); `deleted_subjects` uses `subject_deleted_at` so the tombstone invariant is a pure structural test.
- **Seed loaders load inside one transaction** and check every secondary unique column across source rows first (`SeedCollisionError` names both rows); the Airports loader skips airports on the explicit rejected list with a warning instead of failing.
- **The ESLint module-scope rule now bans `postgres(...)`** as well as `drizzle(...)`, including aliased and namespace imports, and covers `packages/db/src`.
- **Fetch script requests identity encoding** before comparing bytes with `Content-Length` (Node's fetch otherwise decompresses gzip transparently and the header describes the compressed size).

## Pinned versions (increment 2)

| Package | Pin        | Resolved | Why this pin                                                                                     |
| ------- | ---------- | -------- | ------------------------------------------------------------------------------------------------ |
| zod     | `^4.6.5`   | 4.6.5    | Zod 4: `z.looseObject`, `z.iso.*`, `z.partialRecord`; `@hono/zod-validator` 0.9 supports it.     |
| tsx     | `^4.23.13` | 4.23.13  | Runs `scripts/gen-cadence-table.ts`; needs esbuild's postinstall, allowed through `allowBuilds`. |

## Deviations (increment 2)

- **`allowBuilds` replaces `onlyBuiltDependencies`.** pnpm 12 ignores `onlyBuiltDependencies` (its changelog moved the allow list to `allowBuilds` in pnpm 11); with the old key `pnpm install --offline` fails with `ERR_PNPM_IGNORED_BUILDS` for esbuild. Confirmed empirically by the fixer and the re-reviewer.
- **Slot rule is `ceil`, not `round`.** The plan's per-window counts (42 / 21 / 7 / 2 = 72) came from rounding; the honest SLO measurement showed a 20-minute unpolled hole before boarding on a 15-minute grid, so a trailing partial slot now always earns a poll. A2 = 74 polls, 122 PE, $0.61 list; A1 = 84. The plan's tables in sections 8 and 9 are historical; `docs/architecture.md` is generated from the code.
- **AeroDataBox units 2 / 24 / 40 at 3 / 14 / 30 days**, not 4 / 26 / 42: the poll at exactly T-48 h is the AeroAPI bracketed fetch, not a second AeroDataBox call.
- **A1 post-arrival tail** is five fixed slots (in+0, +15, +30, +45, final +120) rather than an interval; the plan's "15-min 4 + 1 final" wording reads that way and it keeps the 15-minute post-arrival SLO for the first 45 minutes.
- **Cadence B in-flight slot** is at scheduled out + 15, not scheduled off + 15 (no taxi model in shared yet).
- **`FlightStatus` gained** an optional `key`, a provider-local `scheduledDepartureDateLocal`, and `AircraftPosition` gained `callsign`; `providerRefs` and `fieldQuality` are open string records (forward compatibility); enum fields degrade unknown strings to `unknown` but stay required.
- **Every RPC payload carries `rpcVersion`** (defaulted to 1) so a DO can answer in the caller's version.

## Pinned versions (increment 1)

Resolved with `npm view <pkg> version` on 2026-09-19. Every pin lives in the `catalog:` block of
`pnpm-workspace.yaml`; packages reference it with the `catalog:` protocol.

| Package                | Pin                                     | Resolved | Why this pin                                                                                                                                           |
| ---------------------- | --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| node                   | `>=24 <25`, `.node-version` 24          | 24.21.0  | Node 24 LTS. Corepack is gone from Node 25, so pnpm is pinned through `packageManager`.                                                                |
| pnpm                   | `pnpm@12.5.1` (exact, `packageManager`) | 12.5.1   | The version installed on the build machine. See the deviation note below.                                                                              |
| turbo                  | `^2.11.2`                               | 2.11.2   | Plan section 3.                                                                                                                                        |
| typescript             | `~6.0.3`                                | 6.0.3    | Latest on npm is 7.0.2, held back on purpose: Expo SDK 57 expects 6.0.x and typescript-eslint 8 peers on `>=4.8.4 <6.1.0`.                             |
| vitest                 | `~4.1.11`                               | 4.1.11   | Latest is 5.0.1, held back on purpose: `@cloudflare/vitest-plugin` 1.1.x peers on vitest `^4.1`.                                                       |
| eslint                 | `^9.39.5`                               | 9.39.5   | Latest is 10.11.0. The spec asks for ESLint 9 flat config; typescript-eslint 8.70 supports 8, 9 and 10, so the move to 10 is a later, deliberate step. |
| @eslint/js             | `^9.39.5`                               | 9.39.5   | Kept in lockstep with eslint.                                                                                                                          |
| typescript-eslint      | `^8.70.0`                               | 8.70.0   | Latest 8.x; the only line that supports TypeScript 6.0.                                                                                                |
| eslint-config-prettier | `^10.1.8`                               | 10.1.8   | Latest.                                                                                                                                                |
| globals                | `^17.12.0`                              | 17.12.0  | Node globals for the plain-JS files (ESLint config, plugin, scripts).                                                                                  |
| prettier               | `^3.9.8`                                | 3.9.8    | Latest 3.x.                                                                                                                                            |
| @types/node            | `^24.13.6`                              | 24.13.6  | Matches the Node 24 runtime; latest on npm is 26.6.2, which is a newer runtime than we ship.                                                           |

Recorded in the catalog as comments only, not installed yet: `@cloudflare/vitest-plugin` 1.1.13
and `wrangler` 4.135.0 (increment 4), `hono` 4.13.8 (increment 4), `zod` 4.6.5 (increment 2),
`expo` 57.0.24 (increment 9), `drizzle-orm` 0.45.2 and `drizzle-kit` 0.31.10 (increment 3),
`better-auth` 1.7.5 (increment 5).

## GitHub Actions versions (increment 1)

The spec pins `actions/checkout@v5`, `pnpm/action-setup@v4` and `actions/setup-node@v6`. All three
majors exist on the marketplace today, so no fallback was needed. Newer majors have since shipped
(checkout v7, action-setup v6, setup-node v7); Renovate will propose those bumps as reviewable PRs
rather than the build silently jumping a major.

## Decisions taken where the spec was silent (increment 1)

- **Turborepo task graph.** `lint` and `test` each depend on a root task (`//#lint:root`,
  `//#test:eslint-rules`) so the files that live outside a workspace package (the flat config,
  `scripts/`, `tools/`) are linted and the custom ESLint rule's unit test runs as part of
  `turbo run lint test`. Without this, `tools/` would never be checked by CI.
- **TypeScript emit.** `composite: true` with `emitDeclarationOnly: true` and `outDir: dist`.
  Composite is required for project references, and declaration-only emit keeps `tsc -b`
  incremental without producing JavaScript nobody consumes (packages are consumed as TypeScript
  source through their `exports` map).
- **Package entry points.** `exports` maps `.` to `./src/index.ts` for both the `types` and
  `default` conditions, per the spec. Consumers are Vite, Vitest and wrangler, all of which
  compile TypeScript, so there is no build step in Phase 0.
- **ESLint rule scope.** `planeahead/no-module-scope-drizzle` is enabled only for
  `apps/api/src/**/*.ts`, per the spec. It matches a bare `drizzle(...)` identifier call and a
  `ns.drizzle(...)` member call, and treats any enclosing function, arrow function or class static
  block as "not module scope". A bare block at module scope still counts as module scope.
- **Prettier scope.** `.prettierignore` excludes `docs/plans/`, `docs/research/` and
  `docs/increments/`. Those are orchestrator-owned inputs and reformatting them would be an edit.
- **`.npmrc`.** `engine-strict=true`, so an install on the wrong Node major fails loudly instead of
  producing a lockfile nobody can reproduce.
- **`onlyBuiltDependencies`.** pnpm 10+ blocks lifecycle scripts by default. `esbuild` (a Vite
  dependency) is allowlisted because it needs its postinstall to place the platform binary.

## Deviations (increment 1)

- **Two-document lockfile.** pnpm 12 with a `packageManager` pin writes `pnpm-lock.yaml` as two
  YAML documents: the first records pnpm's own `@pnpm/exe.*` binaries (self-managed package
  manager), the second is the workspace. `scripts/toolchain-guard.mjs` only matches unquoted
  `  name@version:` entries, so the quoted `@pnpm/exe` block in the first document is ignored.
- **Review stage skipped.** The build workflow's Opus review never ran (session limit). The
  orchestrator read every file instead; the fixes above were the only findings. A second-model
  review is not owed for a skeleton with no business logic, and increment 2's reviewers see this
  code again as context.

- **pnpm 12.5.1, not 12.4.2.** npm's `latest` dist-tag for pnpm 12 is 12.4.2; 12.5.1 is `next-12`
  and is what is installed on this machine. `packageManager` must match the binary that runs the
  install, so the pin follows the machine. Change both together, never one alone.
