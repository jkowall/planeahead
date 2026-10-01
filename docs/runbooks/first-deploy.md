# First deploy runbook

Status: increment 12 (2026-09-23). Everything the owner does once, in order, before and during the
first staging and production deploys, with the exact commands. Nothing here has been run: there
is no Cloudflare account, Neon project, provider key or Apple and Google credential in the build
environment, so every command below is the documented form (wrangler flags checked against
`wrangler <command> --help` at 4.135.0; Neon and Apple steps against their docs). Tick each box
as it is done; a step that fails stops the list.

Conventions: run wrangler from `apps/api` as `pnpm exec wrangler ...` (the pinned 4.135.0);
`<env>` is `staging` or `production`; the resource names carry the environment suffix exactly as
`apps/api/wrangler.jsonc` declares them (`-staging` for staging, none for production).

## 0. Accounts and plans

- [ ] Cloudflare account on **Workers Paid** ($5/month), with `planeahead.app` as a zone on it. No
      DNS record may exist yet for `api.planeahead.app` or `api-staging.planeahead.app`: a Workers
      custom domain is refused while a CNAME holds the hostname.
- [ ] `pnpm exec wrangler login` on the machine that runs the commands below (or export a token
      with the scopes of step 1 as `CLOUDFLARE_API_TOKEN`), and note the account id
      (`pnpm exec wrangler whoami`).
- [ ] Neon project on Launch, PostgreSQL 18, `aws-us-east-1`, with branches `main` (production)
      and `staging` (step 7).
- [ ] AeroDataBox **Growth** subscription ($99 a month, 400,000 units; the floor, not Starter:
      Starter's 7-day caching term forbids the retention this system keeps,
      docs/cost-estimate.md section 3). Its key is `AERODATABOX_API_KEY` (step 6), and
      `ADB_PLAN=growth` must be set with it in both environments (step 6).

## 1. Cloudflare API tokens

- [ ] **Deploy token** (GitHub secret `CLOUDFLARE_API_TOKEN`, step 9). Dashboard > My Profile >
      API Tokens > Create Custom Token, account-scoped to this account, with exactly: Account >
      Workers Scripts > Edit; Account > Workers KV Storage > Edit; Account > Workers R2 Storage >
      Edit; Account > Queues > Edit; Account > Hyperdrive > Edit; Account > Account Settings >
      Read; and Zone > Workers Routes > Edit (the spec's "Write") for `planeahead.app` (the
      custom domains). The "Edit Cloudflare Workers" template lacks Queues Edit, and the deploy
      fails without it (`docs/increments/04-api-bootstrap.facts.md`, deploy mechanics). Whether
      Hyperdrive needs its own deploy permission is unverified: confirm on the first staging
      deploy.
- [ ] **Operational token** (Worker secret `CF_API_TOKEN`, optional, step 6): Account > Account
      Analytics > Read (the Analytics Engine SQL API: the nightly provider-call rollup and the
      admin page's figures for today) and Account > Queues > Read (the admin page's queue depths).
      Nothing else. Without it the rollup records a skipped run every night and the admin page
      shows those figures as unavailable.

## 2. Queues and dead letter queues

A deploy fails with `Queue "<name>" does not exist`; it never creates them. Six queues and six
dead letter queues per environment (increment 12 added `housekeeping`). The dead letter queues
keep messages 14 days (the maximum on Paid) so a missed alert still leaves time to look; their
consumer archives every message to R2 anyway.

- [ ] Staging:

  ```sh
  for q in persist notify provider-events imports reconcile housekeeping; do
    pnpm exec wrangler queues create "planeahead-$q-staging"
    pnpm exec wrangler queues create "planeahead-$q-dlq-staging" --message-retention-period-secs 1209600
  done
  ```

- [ ] Production: the same loop with the names `planeahead-$q` and `planeahead-$q-dlq` (no
      suffix).
- [ ] The consumers attach on the first deploy (wrangler.jsonc `queues.consumers`, one Worker per
      queue); `pnpm exec wrangler queues info planeahead-persist-staging` shows the consumer
      afterwards.

## 3. KV namespaces

- [ ] Per environment, three namespaces, and the printed ids pasted into the environment's
      `kv_namespaces` block in `apps/api/wrangler.jsonc` in place of the placeholder ids:

  ```sh
  for ns in CACHE PUBLIC CONFIG; do pnpm exec wrangler kv namespace create "$ns" --env staging; done
  for ns in CACHE PUBLIC CONFIG; do pnpm exec wrangler kv namespace create "$ns" --env production; done
  ```

## 4. R2 buckets and lifecycle rules

- [ ] Buckets:

  ```sh
  for b in planeahead-public-staging planeahead-private-staging planeahead-public planeahead-private; do
    pnpm exec wrangler r2 bucket create "$b"
  done
  ```

- [ ] Lifecycle rules on each PRIVATE bucket (the prefixes docs/schema-review.md section 10
      lists): tracker timelines one year, dead-letter archives 30 days (the nightly replay
      handles `dlq/persist/` within a day; `dlq/persist-parked/` and the other queues' archives
      are for a person to read), exports 7 days, imports 30 days:

  ```sh
  for b in planeahead-private-staging planeahead-private; do
    pnpm exec wrangler r2 bucket lifecycle add "$b" events-365d events/ --expire-days 365 -y
    pnpm exec wrangler r2 bucket lifecycle add "$b" dlq-30d dlq/ --expire-days 30 -y
    pnpm exec wrangler r2 bucket lifecycle add "$b" exports-7d exports/ --expire-days 7 -y
    pnpm exec wrangler r2 bucket lifecycle add "$b" imports-30d imports/ --expire-days 30 -y
  done
  ```

- [ ] `pnpm exec wrangler r2 bucket lifecycle list planeahead-private` shows the four rules.

## 5. Hyperdrive

One configuration per environment, pointed at the Neon **direct** (primary, read-write) endpoint:
never the `-pooler` host (Hyperdrive pools in transaction mode already) and never a read replica
(the sync route refuses a read-only connection; ADR 0012 item 7). Query caching DISABLED: a
correctness requirement of the sync feed's no-cursor snapshot page, not a performance choice
(ADR 0012 item 7).

- [ ] Staging (the Neon 0.25 CU `staging` branch admits 97 application connections; 80 leaves room
      for migrations and a console):

  ```sh
  pnpm exec wrangler hyperdrive create planeahead-staging \
    --connection-string="postgresql://planeahead_app:<password>@<endpoint>.us-east-1.aws.neon.tech/planeahead?sslmode=require" \
    --caching-disabled --origin-connection-limit 80
  ```

- [ ] Production, against the 0.5 CU always-on primary of `main` (202 usable connections;
      Hyperdrive's own soft ceiling on Paid is about 100):

  ```sh
  pnpm exec wrangler hyperdrive create planeahead-production \
    --connection-string="postgresql://planeahead_app:<password>@<endpoint>.us-east-1.aws.neon.tech/planeahead?sslmode=require" \
    --caching-disabled --origin-connection-limit 100
  ```

- [ ] Paste each printed id into the environment's `hyperdrive` block in `wrangler.jsonc`.
- [ ] Check caching is off and the host is the direct endpoint, now and after any later edit of the
      configuration: `pnpm exec wrangler hyperdrive get <id>` shows caching disabled and a host
      without `-pooler`.

## 6. Worker secrets and settings

`wrangler.jsonc` declares `secrets.required` per environment (the list is `WORKER_SECRET_NAMES`
in `apps/api/src/env.ts`, kept equal by `secrets-in-logs.test.ts`), so wrangler refuses the first
deploy while one is unset. Set them out of band; the deploy workflows pass an EMPTY `secrets` input
on purpose.

- [ ] For each environment, every name below with
      `pnpm exec wrangler secret put <NAME> --env <env>` (or once with
      `pnpm exec wrangler secret bulk secrets.<env>.json --env <env>` from a file that is never
      committed and deleted afterwards):

  | Secret                                                                     | Value                                                                                                                                                  |
  | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `SENTRY_DSN`                                                               | the Sentry project DSN (empty drops every event)                                                                                                       |
  | `BETTER_AUTH_SECRET`                                                       | `openssl rand -base64 48`, different per environment                                                                                                   |
  | `TOKEN_KEK_V1`                                                             | `openssl rand -base64 32` (standard padded base64, 32 bytes); different per environment; keep an offline copy                                          |
  | `APPLE_SIWA_P8`, `APPLE_SIWA_KEY_ID`, `APPLE_SIWA_TEAM_ID`                 | the Sign in with Apple key created in step 12 (`.p8` PEM with newlines written as `\n`), its key id, the team id; the same values in both environments |
  | `APPLE_BUNDLE_ID`                                                          | the primary app: `app.planeahead.mobile` (production), `app.planeahead.mobile.dev` (staging); it also signs the revocation                             |
  | `GOOGLE_CLIENT_ID_WEB`, `GOOGLE_CLIENT_ID_IOS`, `GOOGLE_CLIENT_ID_ANDROID` | the three OAuth client ids of the Google Cloud project                                                                                                 |
  | `RESEND_API_KEY`                                                           | the Resend key for the verified sending domain                                                                                                         |
  | `AERODATABOX_API_KEY`, `AEROAPI_API_KEY`                                   | provider keys (AeroAPI unused while `AEROAPI_MODE` is `mock`; set a placeholder until step 13 decides)                                                 |
  | `WEBHOOK_TOKEN_AERODATABOX`, `WEBHOOK_TOKEN_AEROAPI`                       | `openssl rand -base64 32 \| tr '+/' '-_' \| tr -d '='`, one per provider and environment                                                               |
  | `DELETED_SUBJECT_HMAC_KEY`, `IP_SALT_SECRET`                               | `openssl rand -base64 32` each, different per environment                                                                                              |
  | `CF_API_TOKEN` (optional)                                                  | the operational token of step 1                                                                                                                        |

- [ ] `ADB_PLAN=growth` in BOTH environments (`pnpm exec wrangler secret put ADB_PLAN --env <env>`,
      value `growth`, or a `vars` entry), for the Growth plan of step 0. Required, not optional:
      an unset or unknown value means Starter, whose quota the ProviderBudget spreads as a daily
      cap of 40,000 / 30 = 1,333 units, about 8 flights a day in mock mode, a tenth of what Growth
      pays for, after which the kill switch trips.
- [ ] Optional settings, only where a non-default is wanted (`wrangler secret put` or a `vars`
      entry): `AEROAPI_MODE` (`mock` default),
      `ADB_ALERTS_ENABLED`, `REVENUECAT_DELETE_ENABLED`, `APPLE_BUNDLE_IDS` (defaults to the
      environment's variants: production and preview against production, development against
      staging), `APPLE_TEAM_ID`, `APP_BUNDLE_IDS` and `ANDROID_SHA256_FINGERPRINTS` (step 11).
- [ ] The vars in `wrangler.jsonc`: `CF_ACCOUNT_ID` (the account id of step 0) per environment,
      and `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` from step 14.

## 7. Neon

- [ ] Branches: `main` for production (0.5 CU fixed, scale to zero OFF) and `staging` (0.25 CU,
      scale to zero on). One application role per branch, `planeahead_app`, owner of the schema.
- [ ] On EACH branch, as the project owner (docs/schema-review.md section 12; Hyperdrive resets
      session settings, so they live on the role):

  ```sql
  ALTER ROLE planeahead_app SET TimeZone = 'UTC';
  ALTER ROLE planeahead_app SET statement_timeout = '10s';
  ALTER ROLE planeahead_app SET idle_in_transaction_session_timeout = '30s';
  GRANT pg_read_all_stats TO planeahead_app;
  ```

  The 10 s `statement_timeout` is why every housekeeping purge is paged: the sync purge moves its
  horizon at most 10,000 rows per queue message (migration 0005's `xid` btree serves it) and every
  other purge deletes in batches of 5,000, so no statement of the nightly run comes near it.
  `pg_read_all_stats` lets the admin page's watermark lag see every backend in
  `pg_stat_activity`; without it the page shows "partial: the role lacks pg_read_all_stats" and
  the lag can read low.

  Then reconnect as `planeahead_app` and check `SHOW TimeZone; SHOW statement_timeout;
SHOW idle_in_transaction_session_timeout;` and
  `SELECT pg_has_role(current_user, 'pg_read_all_stats', 'member');` (true). The idle timeout is what bounds the sync watermark
  lag the admin page shows: one session idle inside a writing transaction freezes `GET /v1/sync`
  for every user.

- [ ] History window 1 day, explicitly (the deletion disclosure promises "up to 24 hours";
      docs/increments/08-flight-routes-and-sync.facts.md section 3): Project settings > Storage >
      History retention = 1 day, or
      `curl -X PATCH https://console.neon.tech/api/v2/projects/<project_id> -H "Authorization: Bearer $NEON_API_KEY" -H 'Content-Type: application/json' -d '{"project":{"history_retention_seconds":86400}}'`.
- [ ] The direct (non-pooler) connection strings of both branches become the GitHub secrets
      `NEON_STAGING_DIRECT_URL` and `NEON_PRODUCTION_DIRECT_URL` (step 9); migrations refuse a
      `-pooler` host.
- [ ] **After ANY point-in-time restore or branch reset** (not only at first deploy): bump the sync
      epoch, or every device's cursor from the lost timeline can skip rows once the restored cluster
      reuses its xids (docs/schema-review.md section 6, ADR 0012 item 6):

  ```sql
  UPDATE sync_epoch SET epoch = epoch + 1, bumped_at = now() WHERE id = 1;
  ```

## 8. Paste the ids and prove the config

- [ ] `apps/api/wrangler.jsonc` holds the real KV and Hyperdrive ids for both environments, the
      account id var, and (after step 14) the Access vars. Commit on a branch.
- [ ] `cd apps/api && pnpm exec wrangler deploy --dry-run --env staging && pnpm exec wrangler deploy --dry-run --env production`
      passes (CI's `wrangler-dry-run` job runs the same). A dry run does NOT check that the ids
      exist; the first staging deploy does.

## 9. GitHub

- [ ] Environments `staging` and `production` (Settings > Environments), each with the secrets
      `CLOUDFLARE_API_TOKEN` (step 1) and `CLOUDFLARE_ACCOUNT_ID`; `staging` also
      `NEON_STAGING_DIRECT_URL`, `production` also `NEON_PRODUCTION_DIRECT_URL`.
- [ ] The production gate: required reviewers on the `production` environment need GitHub Pro on
      a private repository. Until then `deploy-production.yml` deploys only from a manual run on a
      `v*` tag with `deploy <tag>` typed into `confirm`. With Pro: add yourself as a required
      reviewer, then, if the tag run itself should deploy after approval, drop the
      `github.event_name == 'workflow_dispatch'` and `inputs.confirm` clauses from the deploy
      job's `if` (keep the tag clause), and in the same change update the "deploys only from a
      manual run on a tag with the tag typed back, after the verify job" case of
      `tools/workflows/deploy-production.test.js`, which asserts both clauses and otherwise fails
      the tools suite (docs/open-decisions.md, the production approval gate).

## 10. First staging deploy

- [ ] Merge to `main` (or run **Deploy staging** by hand). The job checks the migration hash,
      typechecks, tests, dry-runs, migrates the staging branch, deploys, and smokes
      `https://api-staging.planeahead.app/health` with `scripts/health-smoke.mjs`, which requires
      THIS commit's migration hash and Durable Object schema versions, not merely a 200.
- [ ] `pnpm exec wrangler queues info planeahead-housekeeping-staging` shows the Worker as the
      consumer; `pnpm exec wrangler hyperdrive get <staging id>` still shows caching disabled.
- [ ] The next morning (the daily cron is 03:00 UTC): the admin page (step 14) lists
      `housekeeping.*` audit rows for every step, `done: true`.

## 11. Apple and Google association, email sources

- [ ] `APPLE_TEAM_ID` set per environment; the association files then answer:
      `curl -s https://api-staging.planeahead.app/.well-known/apple-app-site-association` (the
      development build) and the production host (production and preview). Apple's CDN copy:
      `curl -s https://app-site-association.cdn-apple.com/a/v1/api.planeahead.app`.
- [ ] `ANDROID_SHA256_FINGERPRINTS` per environment (`package=FP,FP;...`; Play's app signing key
      AND the upload key from Play Console > Setup > App signing), then
      `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://api.planeahead.app&relation=delegate_permission/common.handle_all_urls`
      lists the packages.
- [ ] Sign in with Apple for Email Communication (Certificates, Identifiers and Profiles >
      Services): register the sending domain and the From address Resend uses, with SPF and DKIM
      passing, or magic links to a private relay address are dropped.

## 12. Apple App IDs and capabilities

- [ ] App IDs for the three variants (`app.planeahead.mobile`, `.preview`, `.dev`) with Sign in
      with Apple, Associated Domains, **Push Notifications**, and the App Groups capability with
      `group.<bundle id>` (ADR 0005).
- [ ] Sign in with Apple grouping, BEFORE any user signs in: on `app.planeahead.mobile` enable
      Sign in with Apple as **Enable as a primary App ID**; on `app.planeahead.mobile.preview` and
      `app.planeahead.mobile.dev` choose **Group with an existing primary App ID** and pick
      `app.planeahead.mobile`. Why: the API signs the client secret and exchanges the code with the
      identity token's own audience as `client_id` (`APPLE_BUNDLE_IDS`), which Apple accepts from
      one key only for App IDs grouped under that key's primary; ungrouped variants would also give
      one Apple user a different `sub` per variant, and regrouping after users exist is the
      expensive direction.
- [ ] The Sign in with Apple key: Certificates, Identifiers and Profiles > Keys > + > enable
      **Sign in with Apple** > Configure > primary App ID `app.planeahead.mobile` > Save and
      download the `.p8` (once only). Its contents, its key id and the team id become
      `APPLE_SIWA_P8`, `APPLE_SIWA_KEY_ID` and `APPLE_SIWA_TEAM_ID` in BOTH environments (step 6).
- [ ] App IDs for the widget extension of each variant (`<bundle id>.widgets`) and the watch
      extensions (`<bundle id>.watchkitapp` and `<bundle id>.watchkitapp.widget`), each with the
      **App Groups** capability and the variant's group (ADR 0008).

## 13. AeroAPI account endpoint

- [ ] Decide one AeroAPI key per environment or one shared key (ADR 0010; docs/open-decisions.md).
      The adapter PUTs the account-wide alert endpoint before its first alert (ruling I7), so with
      one shared key staging and production overwrite each other's endpoint; every alert also
      carries its own `target_url`. The cheap answer for Phase 0: keep `AEROAPI_MODE=mock` in
      staging and use the key in production only; separate keys double the $100 Standard minimum.

## 14. Cloudflare Access for /admin

- [ ] Zero Trust > Access > Applications > Add an application > Self-hosted: application domain
      `api.planeahead.app`, path `admin` (it covers `/admin` and below), session 24 h; one Allow
      policy naming the owner's email (or an IdP group). A second application for
      `api-staging.planeahead.app` path `admin`.
- [ ] From each application's Overview copy the **Application Audience (AUD) tag** into
      `ACCESS_AUD`, and the team domain (`<team>.cloudflareaccess.com`, shown under Zero Trust > Settings)
      into `ACCESS_TEAM_DOMAIN`, in that environment's `vars` in `wrangler.jsonc`; deploy.
      Until both are set the Worker answers `/admin` 403 to everyone, Access or not.
- [ ] Check: `curl -si https://api.planeahead.app/admin` redirects to the Access login; in a
      browser after login the page renders every section; a request with a forged
      `Cf-Access-Jwt-Assertion` answers 403.

## 15. macOS runner minutes and the native smoke gate

- [ ] GitHub Actions minutes: GitHub Free includes 2,000 minutes a month, and a macOS minute is
      priced at about ten Linux minutes ($0.062 against $0.006), so `native-smoke.yml` runs weekly
      (Mondays); its iOS legs take about 22 macOS minutes a run. In September 2026 six nightly runs
      used the whole allowance and GitHub refused every job, PR checks included, until the month
      reset. To run it nightly, add a payment method with a budget (Settings > Billing and
      licensing) that covers about $1.50 a night, then change its cron to `'17 6 * * *'`.
- [ ] Prove the Android leg. The Xcode 26.6 gate leg passed on every scheduled run from
      2026-09-24 to 2026-09-29; the Android leg never has (it filled the runner's disk until the
      fix of 2026-09-30). Once Actions minutes are available, run
      `gh workflow run native-smoke.yml -f platforms=android` and then `gh run watch`. Without
      `-f platforms` a run covers both platforms; the Xcode 27 leg may fail without failing it.

## 16. Support inbox

The public deletion page (`/account/delete`) names `SUPPORT_EMAIL` (`support@planeahead.app` in
every environment's `vars`) and promises a reply before anything is deleted; Google Play checks
that the page works, so the inbox must exist before the listing names the page.

- [ ] Create the mailbox, or route it: Cloudflare dashboard > the `planeahead.app` zone > Email >
      Email Routing > enable, then Routing rules > Create address `support@planeahead.app` >
      Send to the owner's verified destination address.
- [ ] Send a test message to `support@planeahead.app` from an outside address and confirm it
      arrives; reply from it once, so the From address the replies use is proven too.
- [ ] The procedure for a request that arrives there: reply to the account's own address and wait
      for its confirmation; find the user id (for an Apple or Google account, by the address the
      request came from, in `users`); then the admin page's **Operator account deletion**
      (`https://api.planeahead.app/admin/accounts/delete`, behind Access, step 14): look the id
      up, type it again, delete. It runs the same deletion as the app and writes one audit row
      naming you. Reply that it is done. Never delete with SQL: that skips the tracker
      unsubscribes, the Apple revocation, the `deleted_subjects` hashes and the session tombstones.

## 17. First production deploy

- [ ] Steps 2 to 7 done for production, `wrangler.jsonc` merged with the production ids.
- [ ] `git tag v0.0.1 && git push origin v0.0.1`: **Deploy production** runs `verify` only (the
      summary says how to deploy).
- [ ] Actions > Deploy production > Run workflow, branch/tag `v0.0.1`, confirm
      `deploy v0.0.1`: verify, migrate `NEON_PRODUCTION_DIRECT_URL`, `wrangler deploy --env
production`, smoke `https://api.planeahead.app/health` against the build.
- [ ] Rolling back: re-run the workflow on the previous tag. Migrations are forward only, so the
      previous build must work against the newer schema (expand and contract, docs/schema-review.md
      section 12); gradual deployments and `versions` rollbacks are not available to a Worker that
      declares `exports`.
- [ ] Google Play's Data safety form (depends on step 16: the inbox exists and received its test
      message): the account-deletion URL is `https://api.planeahead.app/account/delete` (the
      support inbox on it is the `SUPPORT_EMAIL` var).
