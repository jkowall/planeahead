# Cost estimate

Status: increment 12 (2026-09-23). The Phase 0 plan's section 9 recomputed from the constants the
code now carries: the cadence and its per-flight counts (`packages/shared/src/cadence.ts`, the
generated tables in `docs/architecture.md`), the price table (`packages/shared/src/cost.ts`), the
AeroDataBox plan table (`apps/api/src/providers/config.ts`), and the Durable Object numbers the
increment 7 lifecycle test measured. Every figure is monthly USD at list price unless it says
otherwise. What is measured, what is derived and what is assumed is marked, and the assumptions
are the ones to revisit first (section 6).

## 1. Per flight: the provider calls

Cadence A2 (the Phase 0 constant: polls plus alerts), one on-time flight, 3 h block
(`docs/architecture.md`, generated):

| Item                                 | Count                            | Unit price                           | Per flight                |
| ------------------------------------ | -------------------------------- | ------------------------------------ | ------------------------- |
| AeroAPI status polls inside 48 h     | 74 (`A2_EXPECTED_POLLS`)         | $0.005 per result set                | $0.37                     |
| AeroAPI alert deliveries (assumed)   | 12 (`ASSUMED_ALERTS_PER_FLIGHT`) | $0.020                               | $0.24                     |
| **Inside 48 h, list**                | **122 poll-equivalents**         |                                      | **$0.61**                 |
| AeroDataBox status calls before 48 h | 1 / 2 / 4 at 3 / 14 / 30 days    | 2 units, $0.00025 per unit on Growth | $0.0005 / $0.001 / $0.002 |
| **Per flight, 14-day lead, list**    | **122.2 PE**                     |                                      | **$0.611**                |

- The plan wrote 72 polls, 120 PE and $0.60 under a rounding slot rule; the code derives 74, 122 and
  $0.61 (increment 2), and the lifecycle test asserts exactly 74 calls.
- The pre-48 h layer is WEEKLY and end-anchored on T-48 h (increment 6: AeroDataBox's schedule
  layer refreshes biweekly), so 1 / 2 / 4 AeroDataBox calls at 3 / 14 / 30 days replace the plan's
  daily grid (1 / 12 / 20). The creation fetch (the search, made once by the DesignatorResolver
  and handed to the tracker) is the first of them.
- At exactly T-48 h the flight sits on AeroAPI's exclusive two-day horizon, so the router serves
  that one slot from AeroDataBox: in `live` mode a flight makes 73 AeroAPI polls and one more
  AeroDataBox call. The table keeps 74 as the budget baseline.
- A search that finds nothing costs up to three billed AeroDataBox misses (the requested date and
  the day either side), 6 units, cached for 24 h so a typo does not repeat them.
- Budgets derived from the baseline: soft cap 244 PE (2x, stretches the cadence one tier), hard cap
  488 PE (4x, stops polling). A flight can never cost more than about $2.44 of provider list price.

**Phase 0 as deployed is different.** `AEROAPI_MODE` defaults to `mock`, which routes every cadence
window to AeroDataBox: a flight then costs about 75 to 78 AeroDataBox status calls, 150 to 156
units, $0.04 at the Growth unit price, and the binding constraint is the plan's QUOTA, not money
(section 3).

## 2. Per flight: Cloudflare

| Resource                    | Per flight (derived from measurements)                                                                                                                                                                                                                            | Price                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Durable Object rows written | **1,203 measured** (the lifecycle test's line `[lifecycle] polls=74 alarms=74 rows_written_lifetime=1203 ... per_alarm_avg=16.3`: the schema DDL, 13 per unchanged alarm, 16.3 per alarm on average with seed, subscriptions, confirmations, finish and deletion) | 50M included, then $1.00 per million                                                    |
| Durable Object requests     | about 160 to 200 (74 alarms, 1 to 4 pre-48 h alarms, about 74 confirmations, subscriptions and refreshes, 2 finish alarms)                                                                                                                                        | 1M included, then $0.15 per million                                                     |
| Durable Object duration     | 3.9 to 9.75 GB-s (78 alarms at 128 MB, 0.125 GB, and 400 to 1,000 ms billable each, assumed; facts section 5)                                                                                                                                                     | 400,000 GB-s included, then $12.50 per MILLION GB-s, **rounded up to the next million** |
| Queue operations            | about 500 (150 to 200 persist messages, three operations each)                                                                                                                                                                                                    | 1M included, then $0.40 per million                                                     |
| KV writes                   | about 80 (debounced snapshots, search cache)                                                                                                                                                                                                                      | 1M included, then $5.00 per million                                                     |
| Analytics Engine points     | about 78 (one per stored provider call)                                                                                                                                                                                                                           | 10M included, then $0.25 per million                                                    |
| R2                          | one archive object per flight                                                                                                                                                                                                                                     | negligible below millions of objects                                                    |

Rows written are the Durable Object bill: about **$0.0012 per flight** marginal once past the 50M
allowance, against about $0.00003 for its requests. **The duration rounding cliff:** billable
duration rounds up to the next million GB-s before the rate applies, so the first GB-s over the
400,000 allowance costs a whole $12.50. The 100k-flight scenario is under the cliff only at the
400 ms end of the range: about 390,000 GB-s there (100,000 flights at 3.9 GB-s), 2.5 percent under
the 400,000 allowance, but about 975,000 GB-s at 1,000 ms, past it (the "$85 past the cliff"
figure below). Any growth past the allowance adds $12.50 at once,
then nothing until the next million. The duration figure rests on an assumed alarm wall clock that
nobody has measured against a real provider (open decisions).

## 3. AeroDataBox plan and quota

| Plan    | Price | Units per month | Per second | Flights per month, AeroAPI live (8 units each) | Flights per month, mock mode (156 units each) |
| ------- | ----- | --------------- | ---------- | ---------------------------------------------- | --------------------------------------------- |
| Starter | $19   | 40,000          | 5          | 5,000                                          | 256                                           |
| Growth  | $99   | 400,000         | 10         | 50,000                                         | 2,564                                         |
| Scale   | $499  | 4,000,000       | 20         | 500,000                                        | 25,641                                        |

Growth is the plan's floor, not Starter: Starter's caching term (7 days) forbids the Postgres and
R2 retention this system keeps, and it cannot carry a busy month at 1k flights in mock mode
(increment 6 decision 4). The ProviderBudget object spreads the monthly quota as a daily cap
(`monthlyUnits / 30`), so a spike day is refused rather than billed as overage.

## 4. Monthly scenarios

Assumptions as in the plan: subscribers per flight 1.2 / 1.5 / 2.5; MAU 600 / 7,500 / 125,000;
about 300 API requests per MAU per month; Neon at 0.5 / 0.5 / 2 CU always on.

| Line                                                           | 1k flights | 10k flights  | 100k flights             |
| -------------------------------------------------------------- | ---------- | ------------ | ------------------------ |
| AeroAPI, A2, list (74 x $0.005 + 12 x $0.020 per flight)       | $610       | $6,100       | $61,000                  |
| AeroAPI after the volume bands (plan's reading, see note)      | $610       | about $3,440 | about $12,000 (Premium)  |
| AeroDataBox (Growth floor; Scale at 100k)                      | $99        | $99          | $499                     |
| Workers Paid base, requests and CPU                            | $5         | $5           | $16                      |
| Durable Objects (rows, requests, duration)                     | $0         | $0.12        | $73 ($85 past the cliff) |
| Queues, KV, R2, Analytics Engine, Workers Logs                 | $0         | $1.60        | $57                      |
| Neon (plan section 9, not re-priced here)                      | $45        | $60          | $176 to $345             |
| Sentry, EAS, RevenueCat, email (plan section 9, not re-priced) | $45        | $68          | $862                     |
| **Total, bands applied**                                       | **~$804**  | **~$3,674**  | **~$13,680 to $13,850**  |
| **Per flight**                                                 | **$0.80**  | **$0.37**    | **$0.14**                |

- **AeroAPI's $100 Standard minimum** is billed whatever the usage (`AEROAPI_STANDARD_MONTHLY_MINIMUM_USD_MICROS`):
  below about 164 flights a month at $0.61 the invoice is the minimum, not the sum of the prices.
  Premium carries a $1,000 minimum and is forced near 45k flights a month, where A2 crosses
  Standard's 5 result sets a second at an assumed 4x departure-bank peak (plan section 8).
- **The bands.** FlightAware's volume discounts are marginal and not retroactive; the plan read
  them to $3,380 at 10k and $11,800 at 100k for $0.60 a flight, scaled here to $0.61. Confirm with
  FlightAware sales before 10k flights; this is the largest single uncertainty in the table.
- **AeroDataBox at 100k** needs Scale for the pre-48 h layer and searches (about 8 units a flight,
  800k units). In mock mode (Phase 0 as deployed) 1k flights fit Growth, 10k need Scale, and 100k
  (15.6M units) fit no published plan: AeroAPI or cadence B must carry the in-flight polling first.
- **Cloudflare** stays under $10 at 10k flights and near $150 at 100k, of which Durable Object rows
  written ($70) and KV writes ($35) are most. Provider cost is 88% (1k), 96% (10k) and 91% (100k)
  of spend.
- Cadence B (AeroDataBox webhooks plus AeroAPI OOOI alerts, 5 polls, 37.75 PE, $0.19 list) would
  cut the AeroAPI line by about 70% (plan: ~$380 / ~$1,830 / ~$8,500 totals); its alert field
  coverage is unmeasured (open decisions).

## 5. What the code enforces

- Per flight: the soft cap (244 PE) stretches the cadence and the hard cap (488 PE) stops polling,
  in the FlightTracker's own ledger; a user refresh has its own sub-budget (10 per flight per day).
- Per provider per UTC day: the ProviderBudget object's unit cap (AeroDataBox `monthlyUnits / 30`,
  AeroAPI a provisional 10,000 result sets), per-second token bucket, the 70 / 90 / 100 percent
  alert ladder and the kill switch in `CONFIG` KV.
- Per user: the free tier's 5 active subscriptions, 2 live-tracked, 20 new flights a day, 10
  anonymous tracker creations per IP per day (`FREE_TIER_LIMITS`), in `usage_counters`.
- Every call is a `provider_calls` row (90 days) and an Analytics Engine point; the nightly rollup
  keeps the per-day series in `provider_call_daily`, and the admin page shows both.

## 6. Assumptions to revisit, in order of impact

1. FlightAware's band arithmetic and whether errors and empty results bill (every non-200 is
   recorded as billed today, the conservative side).
2. `ASSUMED_ALERTS_PER_FLIGHT` = 12 ($0.24 of the $0.61): unmeasured until real alerts flow.
3. The billable wall clock of an alarm (the duration line and the 400,000 GB-s cliff).
4. The 4x departure-bank peak behind the Premium threshold.
5. Neon, Sentry, EAS, RevenueCat and email lines, carried from the plan and not re-priced.
