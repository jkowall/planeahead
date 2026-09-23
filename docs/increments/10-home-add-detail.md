# Increment 10: next-flight home, add flight, flight detail

Status: spec (2026-09-20). Builder: Opus 5. Reviewers: Opus 5 (React Native and data-flow correctness) plus orchestrator read. Branch `inc10-home-add-detail` based on `inc9-mobile-scaffold`.

## Goal

The three screens that make Phase 0's runnable milestone real: the next-flight home with an empty state, the add-flight sheet, and the flight detail with a timeline, all reading from the expo-sqlite store through the coalesced `useLiveQuery` and writing through the outbox, so the app works offline and the server stays authoritative.

Acceptance: on the iPhone 17 Pro simulator and the Pixel AVD against staging, adding tomorrow's AA100 shows scheduled times within 5 seconds and produces exactly one AeroDataBox call for that flight key in `provider_calls` (`cost_units = 2`); adding the same flight from a second account produces no further provider call; killing the network and relaunching still renders the list from the store; pulling to refresh calls `POST /v1/flights/:id/refresh` at most once per gesture and shows the 504 last-known-state case gracefully; the detail timeline renders `flight_events` from the snapshot with dark mode via theme tokens; Jest tests cover the add-flight validation against the shared `parseDesignator` and the list rendering from a seeded store; the list re-renders once, not 200 times, when a 200-row page is applied (the coalescing hook is asserted).

## Design

- Home (`(app)/index.tsx`): the next flight by `scheduledOut`, status pill derived from the shared `FlightStatusValue`, gate and terminal, countdown, then the rest of the list; empty state with the add button. All from `useLiveQuery` on `flight_subscriptions` (the flight snapshot is denormalised onto that row per increment 9).
- Add flight sheet: number and date input validated with `parseDesignator` and `IsoDateSchema` from shared; on submit, write an outbox row and an optimistic local subscription, then `POST /v1/flights` with an `Idempotency-Key` (uuidv7); on 403 `cap_exceeded` show the free-tier explanation; on 404 `flight_not_found` say which dates were tried (the increment 8 route answers `triedDates`, the day asked for and the day either side, because the adapter already tried them; its `suggestions` array is empty in Phase 0 and reserved for later); on 422 idempotency mismatch, regenerate the key (client bug, logged to Sentry without the body).
- Detail (`(app)/flight/[id].tsx`): timeline from `timeline_summary` and the snapshot's OOOI times, baggage claim, aircraft, provider attribution (`source`), a refresh action with the 8 s deadline UX, unsubscribe (tombstone plus outbox delete).
- Settings gains units and time-format toggles used by the screens (zustand persist in `expo-sqlite/kv-store`).
- Theme tokens for light and dark; no third-party UI kit.

## Files

```
apps/mobile/src/app/(app)/{index.tsx, add.tsx (sheet route), flight/[id].tsx}
apps/mobile/src/components/{FlightCard.tsx, StatusPill.tsx, Timeline.tsx, EmptyState.tsx, Countdown.tsx}
apps/mobile/src/lib/{format.ts (times in the user's units and format), flights.ts (mutations through the outbox)}
apps/mobile/src/theme/{tokens.ts, useTheme.ts}
apps/mobile/__tests__/{add-flight.test.tsx, home-list.test.tsx, detail.test.tsx, live-query-coalescing.test.ts}
docs/increments/10-verification.md (the exact device steps run and their results, including the provider_calls query)
```

## Constraints

- Every network write goes through the outbox with an idempotency key; no direct mutation from a component.
- The provider-call count assertions run against staging with the real AeroDataBox key (owner task from increment 6); until the key exists the acceptance runs against `wrangler dev` with the mocked provider and is marked pending.
- No em dashes.
