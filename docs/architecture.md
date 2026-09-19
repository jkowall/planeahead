# Architecture

Phase 0 architecture notes. Increment 12 completes this document; until then it carries the
generated refresh-cadence tables that the FlightTracker lifecycle test and the cost model import
from `@planeahead/shared`.

## Refresh cadence

<!-- cadence:start -->
<!-- prettier-ignore-start -->

_Generated from `packages/shared/src/cadence.ts` by `pnpm --filter @planeahead/shared gen:cadence-table`. Do not edit between the markers; `packages/shared/test/cadence-table.test.ts` fails when this block drifts from the code._

Assumptions: block 180 min, boarding at T-40 min, tail stops at in+120 min, on-time flight, one creation fetch at the lead time. Slot rule: start-anchored windows yield `round(duration / interval)` polls, so a trailing partial slot of at least half an interval earns a poll; the pre-48 h AeroDataBox windows count back from T-48 h (daily inside 14 d, every 2 d beyond) and yield `floor(duration / interval)`; the instant on a boundary belongs to the later window; fixed-slot windows list their slots. A flight that passes its planned arrival without `in` keeps polling until `in` or `MAX_LIFETIME`: interval windows continue their grid, fixed-slot windows poll every `lateIntervalMinutes` from the planned arrival. Prices are list prices from `cost.ts` (AeroAPI status $0.005, alert delivery $0.020; AeroDataBox 2 units per status call at $0.00025 per unit on Growth).

### Windows inside 48 h (AeroAPI)

| Window                             | Literal brief                        | A1 polls only                                              | A2 polls + alerts                    | B ADB webhooks + AeroAPI OOOI alerts |
| ---------------------------------- | ------------------------------------ | ---------------------------------------------------------- | ------------------------------------ | ------------------------------------ |
| Hourly window                      | 1 h interval, T-48h to T-3h: 45      | 1 h interval, T-48h to T-6h: 42                            | 1 h interval, T-48h to T-6h: 42      | fixed slots T-48h: 1                 |
| Pre-boarding window                | 10 min interval, T-3h to T-40min: 14 | 15 min interval, T-6h to T-40min: 21                       | 15 min interval, T-6h to T-40min: 21 | fixed slots T-3h: 1                  |
| In flight                          | 2 min interval, T-40min to in: 110   | 15 min interval, T-40min to in: 15                         | 30 min interval, T-40min to in: 7    | fixed slots out+15min: 1             |
| Post-arrival tail                  | 10 min interval, in to in+120min: 12 | fixed slots in, in+15min, in+30min, in+45min, in+120min: 5 | 1 h interval, in to in+120min: 2     | fixed slots in+15min, in+120min: 2   |
| AeroAPI polls inside 48 h          | 181                                  | 83                                                         | 72                                   | 5                                    |
| AeroAPI alert deliveries (assumed) | 0                                    | 0                                                          | 12                                   | 8                                    |
| AeroDataBox alert items (assumed)  | 0                                    | 0                                                          | 0                                    | 15                                   |
| Poll-equivalents inside 48 h       | 181                                  | 83                                                         | 120                                  | 37.75                                |
| List cost inside 48 h              | $0.905                               | $0.415                                                     | $0.60                                | $0.18875                             |

### Pre-48 h AeroDataBox calls and per-flight totals by lead time

AeroDataBox status calls are the same for every cadence; the per-cadence columns add the inside-48 h figures (and, for B, the assumed AeroDataBox alert items). The plan quoted 4 / 26 / 42 units; the simulation gives one call less per lead time because the poll at exactly T-48 h is the AeroAPI bracketed fetch, not a second AeroDataBox call.

| Lead time | ADB status calls | ADB units | ADB cost (Growth) | literal list cost (PE) | A1 list cost (PE) | A2 list cost (PE) | B list cost (PE) |
| --------- | ---------------- | --------- | ----------------- | ---------------------- | ----------------- | ----------------- | ---------------- |
| 3 days    | 1                | 2         | $0.0005           | $0.9055 (181.1)        | $0.4155 (83.1)    | $0.6005 (120.1)   | $0.18925 (37.85) |
| 14 days   | 12               | 24        | $0.006            | $0.911 (182.2)         | $0.421 (84.2)     | $0.606 (121.2)    | $0.19475 (38.95) |
| 30 days   | 20               | 40        | $0.01             | $0.915 (183)           | $0.425 (85)       | $0.61 (122)       | $0.19875 (39.75) |

### Constants exported by `@planeahead/shared`

| Constant                 | Value                                         | Meaning                                                                 |
| ------------------------ | --------------------------------------------- | ----------------------------------------------------------------------- |
| `A2_EXPECTED_POLLS`      | 72                                            | AeroAPI status polls per flight inside 48 h                             |
| `A2_EXPECTED_ALERTS`     | 12                                            | assumed alert deliveries (`ASSUMED_ALERTS_PER_FLIGHT` = 12, unverified) |
| `A2_EXPECTED_PE`         | 120                                           | expected poll-equivalents per flight, budget baseline                   |
| `A2_SOFT_CAP_PE`         | 240                                           | 2x: metric and stretch cadence one tier                                 |
| `A2_HARD_CAP_PE`         | 480                                           | 4x: delete alerts, stop polling, one reconciliation poll                |
| `A1_EXPECTED_POLLS`      | 83                                            | fallback cadence when alerts are silent                                 |
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

| Cadence | SLO window     | Cadence windows                | Widest poll gap | Strictest poll SLO | Why it is accepted                                                       |
| ------- | -------------- | ------------------------------ | --------------- | ------------------ | ------------------------------------------------------------------------ |
| literal | 6 h to 3 h     | Hourly window                  | 1 h             | 15 min             | the brief as written, kept for comparison only                           |
| A1      | 3 h to arrival | Pre-boarding window, In flight | 20 min          | 15 min             | polls are the only source; the SLO holds except on T-1h to T-40min       |
| A1      | Post-arrival   | Post-arrival tail              | 75 min          | 15 min             | polls are the only source; the SLO holds except on in+45min to in+120min |
| A2      | 3 h to arrival | Pre-boarding window, In flight | 40 min          | 15 min             | alerts carry OOOI and ETA; polls only need gates                         |
| A2      | Post-arrival   | Post-arrival tail              | 1 h             | 15 min             | alerts carry OOOI and ETA; polls only need gates                         |
| B       | 48 h to 6 h    | Hourly window                  | 45 h            | 1 h                | webhooks and alerts carry the SLO (unverified)                           |
| B       | 6 h to 3 h     | Pre-boarding window            | 45 h            | 15 min             | webhooks and alerts carry the SLO (unverified)                           |
| B       | 3 h to arrival | Pre-boarding window, In flight | 195 min         | 15 min             | webhooks and alerts carry the SLO (unverified)                           |
| B       | Post-arrival   | Post-arrival tail              | 3 h             | 15 min             | webhooks and alerts carry the SLO (unverified)                           |

Gap across the landing instant, from the last poll before `in` to the first at or after it: literal 2 min (out+178min to in); A1 10 min (out+170min to in); A2 40 min (out+140min to in); B 3 h (out+15min to in+15min).

<!-- prettier-ignore-end -->
<!-- cadence:end -->
