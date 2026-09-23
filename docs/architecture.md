# Architecture

Phase 0 architecture notes. Increment 12 completes this document; until then it carries the
generated refresh-cadence tables that the FlightTracker lifecycle test and the cost model import
from `@planeahead/shared`.

## Refresh cadence

<!-- cadence:start -->
<!-- prettier-ignore-start -->

_Generated from `packages/shared/src/cadence.ts` by `pnpm --filter @planeahead/shared gen:cadence-table`. Do not edit between the markers; `packages/shared/test/cadence-table.test.ts` fails when this block drifts from the code._

Assumptions: block 180 min, boarding at T-40 min, tail stops at in+120 min, on-time flight, one creation fetch at the lead time. Slot rule: start-anchored windows yield `ceil(duration / interval)` polls, so a trailing partial slot always earns a poll and no window ends with a gap longer than its interval; the pre-48 h AeroDataBox windows count back from T-48 h (daily inside 14 d, every 2 d beyond) and yield `floor(duration / interval)`; the instant on a boundary belongs to the later window; fixed-slot windows list their slots. A flight that passes its planned arrival without `in` keeps polling until `in` or `MAX_LIFETIME`: interval windows continue their grid, fixed-slot windows poll every `lateIntervalMinutes` from the planned arrival. Prices are list prices from `cost.ts` (AeroAPI status $0.005, alert delivery $0.020; AeroDataBox 2 units per status call at $0.00025 per unit on Growth).

### Windows inside 48 h (AeroAPI)

| Window                             | Literal brief                        | A1 polls only                                              | A2 polls + alerts                    | B ADB webhooks + AeroAPI OOOI alerts |
| ---------------------------------- | ------------------------------------ | ---------------------------------------------------------- | ------------------------------------ | ------------------------------------ |
| Hourly window                      | 1 h interval, T-48h to T-3h: 45      | 1 h interval, T-48h to T-6h: 42                            | 1 h interval, T-48h to T-6h: 42      | fixed slots T-48h: 1                 |
| Pre-boarding window                | 10 min interval, T-3h to T-40min: 14 | 15 min interval, T-6h to T-40min: 22                       | 15 min interval, T-6h to T-40min: 22 | fixed slots T-3h: 1                  |
| In flight                          | 2 min interval, T-40min to in: 110   | 15 min interval, T-40min to in: 15                         | 30 min interval, T-40min to in: 8    | fixed slots out+15min: 1             |
| Post-arrival tail                  | 10 min interval, in to in+120min: 12 | fixed slots in, in+15min, in+30min, in+45min, in+120min: 5 | 1 h interval, in to in+120min: 2     | fixed slots in+15min, in+120min: 2   |
| AeroAPI polls inside 48 h          | 181                                  | 84                                                         | 74                                   | 5                                    |
| AeroAPI alert deliveries (assumed) | 0                                    | 0                                                          | 12                                   | 8                                    |
| AeroDataBox alert items (assumed)  | 0                                    | 0                                                          | 0                                    | 15                                   |
| Poll-equivalents inside 48 h       | 181                                  | 84                                                         | 122                                  | 37.75                                |
| List cost inside 48 h              | $0.905                               | $0.42                                                      | $0.61                                | $0.18875                             |

### Pre-48 h AeroDataBox calls and per-flight totals by lead time

AeroDataBox status calls are the same for every cadence; the per-cadence columns add the inside-48 h figures (and, for B, the assumed AeroDataBox alert items). The plan quoted 4 / 26 / 42 units; the simulation gives one call less per lead time because the poll at exactly T-48 h is the AeroAPI bracketed fetch, not a second AeroDataBox call.

| Lead time | ADB status calls | ADB units | ADB cost (Growth) | literal list cost (PE) | A1 list cost (PE) | A2 list cost (PE) | B list cost (PE) |
| --------- | ---------------- | --------- | ----------------- | ---------------------- | ----------------- | ----------------- | ---------------- |
| 3 days    | 1                | 2         | $0.0005           | $0.9055 (181.1)        | $0.4205 (84.1)    | $0.6105 (122.1)   | $0.18925 (37.85) |
| 14 days   | 12               | 24        | $0.006            | $0.911 (182.2)         | $0.426 (85.2)     | $0.616 (123.2)    | $0.19475 (38.95) |
| 30 days   | 20               | 40        | $0.01             | $0.915 (183)           | $0.43 (86)        | $0.62 (124)       | $0.19875 (39.75) |

### Constants exported by `@planeahead/shared`

| Constant                 | Value                                         | Meaning                                                                 |
| ------------------------ | --------------------------------------------- | ----------------------------------------------------------------------- |
| `A2_EXPECTED_POLLS`      | 74                                            | AeroAPI status polls per flight inside 48 h                             |
| `A2_EXPECTED_ALERTS`     | 12                                            | assumed alert deliveries (`ASSUMED_ALERTS_PER_FLIGHT` = 12, unverified) |
| `A2_EXPECTED_PE`         | 122                                           | expected poll-equivalents per flight, budget baseline                   |
| `A2_SOFT_CAP_PE`         | 244                                           | 2x: metric and stretch cadence one tier                                 |
| `A2_HARD_CAP_PE`         | 488                                           | 4x: delete alerts, stop polling, one reconciliation poll                |
| `A1_EXPECTED_POLLS`      | 84                                            | fallback cadence when alerts are silent                                 |
| `LITERAL_EXPECTED_POLLS` | 181                                           | the brief as written, for comparison                                    |
| `B_EXPECTED_POLLS`       | 5                                             | Phase 1 target, unverified                                              |
| `MAX_LIFETIME`           | min(scheduledIn + 6 h, actualOff + 2 x block) | hard stop for a flight that never reports in                            |

### Detection-latency SLOs the cadence is derived from

| Event                          | > 7 d | 7 d to 48 h | 48 h to 6 h | 6 h to 3 h | 3 h to arrival             | Post-arrival |
| ------------------------------ | ----- | ----------- | ----------- | ---------- | -------------------------- | ------------ |
| Schedule change / cancellation | 2 d   | 1 d         | 1 h         | 15 min     | 15 min                     | n/a          |
| Gate change                    | n/a   | n/a         | 1 h         | 15 min     | 15 min                     | n/a          |
| ETA / delay change             | n/a   | n/a         | 1 h         | 15 min     | 15 min (2 min with alerts) | 15 min       |
| OOOI                           | n/a   | n/a         | n/a         | n/a        | 15 min (2 min with alerts) | 15 min       |

### Where a cadence polls slower than the SLO

Measured from the simulated poll sequence (one creation fetch 30 days out, then every slot `refreshIntervalFor` schedules, with the tail stop closing the last gap): each SLO window is charged the widest gap between consecutive polls that lies inside it or crosses one of its edges. A gap that crosses a window boundary counts against both windows; a gap that ends on the boundary counts against the earlier window only. A row appears when the widest gap exceeds the strictest poll SLO of the window.

| Cadence | SLO window     | Widest gap span       | Widest poll gap | Strictest poll SLO | Why it is accepted                                                                                                |
| ------- | -------------- | --------------------- | --------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| literal | 6 h to 3 h     | T-6h to T-5h          | 1 h             | 15 min             | the brief as written, kept for comparison only                                                                    |
| A1      | Post-arrival   | in+45min to in+120min | 75 min          | 15 min             | plan section 8: the fallback tail is five fixed polls, 15-minute cover for the first 45 minutes then a final poll |
| A2      | 3 h to arrival | T-40min to T-10min    | 30 min          | 15 min             | plan section 8: OOOI and ETA arrive by alert; in-flight gate changes are accepted at 30-minute latency            |
| A2      | Post-arrival   | in to in+60min        | 1 h             | 15 min             | plan section 8: alerts carry in; the tail only refreshes baggage claim                                            |
| B       | 48 h to 6 h    | T-48h to T-3h         | 45 h            | 1 h                | webhooks and alerts are assumed to carry the SLO (unverified, Phase 1 decision)                                   |
| B       | 6 h to 3 h     | T-48h to T-3h         | 45 h            | 15 min             | webhooks and alerts are assumed to carry the SLO (unverified, Phase 1 decision)                                   |
| B       | 3 h to arrival | T-3h to out+15min     | 195 min         | 15 min             | webhooks and alerts are assumed to carry the SLO (unverified, Phase 1 decision)                                   |
| B       | Post-arrival   | out+15min to in+15min | 3 h             | 15 min             | webhooks and alerts are assumed to carry the SLO (unverified, Phase 1 decision)                                   |

Gap across the landing instant, from the last poll before `in` to the first at or after it: literal 2 min (out+178min to in); A1 10 min (out+170min to in); A2 10 min (out+170min to in); B 3 h (out+15min to in+15min).

<!-- prettier-ignore-end -->
<!-- cadence:end -->
