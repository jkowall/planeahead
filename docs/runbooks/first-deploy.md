# First deploy runbook

Status: increment 12 (2026-09-23); the store steps (step 18) increment 13 (2026-09-30); the push
transport (the `push` queues in step 2, its secrets in step 6, step 19) increment 14
(2026-09-30). Everything
the owner does once, in order, before and during the first staging and production deploys and the
first store builds, with the exact commands. Nothing here has been run: there
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
- [ ] For the store builds (step 18), started now because of their lead times
      (docs/plans/phase1-plan.md section 10): the Apple Developer Program membership and a Google
      Play Console account, both as the organization that sells the app (D-U-N-S first), and an
      Expo account on Starter with `eas init` run in `apps/mobile` (apps/mobile/README.md, owner
      tasks).

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

A deploy fails with `Queue "<name>" does not exist`; it never creates them. Seven queues and
seven dead letter queues per environment (increment 12 added `housekeeping`, increment 14 `push`).
The dead letter queues keep messages 14 days (the maximum on Paid) so a missed alert still leaves
time to look; their consumer archives every message to R2 anyway.

- [ ] Staging:

  ```sh
  for q in persist notify push provider-events imports reconcile housekeeping; do
    pnpm exec wrangler queues create "planeahead-$q-staging"
    pnpm exec wrangler queues create "planeahead-$q-dlq-staging" --message-retention-period-secs 1209600
  done
  ```

- [ ] Production: the same loop with the names `planeahead-$q` and `planeahead-$q-dlq` (no
      suffix).
- [ ] An environment created before increment 14 needs only the two new ones:
      `pnpm exec wrangler queues create planeahead-push-staging` and
      `pnpm exec wrangler queues create planeahead-push-dlq-staging --message-retention-period-secs 1209600`
      (and the same without `-staging` for production), before the first deploy of increment 14.
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
in `apps/api/src/env.ts`, and in production also `PUSH_SECRET_NAMES`; `secrets-in-logs.test.ts`
keeps them equal), so wrangler refuses the first deploy while one is unset. Set them out of band;
the deploy workflows pass an EMPTY `secrets` input on purpose.

- [ ] For each environment, every name below with
      `pnpm exec wrangler secret put <NAME> --env <env>` (or once with
      `pnpm exec wrangler secret bulk secrets.<env>.json --env <env>` from a file that is never
      committed and deleted afterwards):

  | Secret                                                                               | Value                                                                                                                                                     |
  | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `SENTRY_DSN`                                                                         | the Sentry project DSN (empty drops every event)                                                                                                          |
  | `BETTER_AUTH_SECRET`                                                                 | `openssl rand -base64 48`, different per environment                                                                                                      |
  | `TOKEN_KEK_V1`                                                                       | `openssl rand -base64 32` (standard padded base64, 32 bytes); different per environment; keep an offline copy                                             |
  | `APPLE_SIWA_P8`, `APPLE_SIWA_KEY_ID`, `APPLE_SIWA_TEAM_ID`                           | the Sign in with Apple key created in step 12 (`.p8` PEM with newlines written as `\n`), its key id, the team id; the same values in both environments    |
  | `APPLE_BUNDLE_ID`                                                                    | the primary app: `app.planeahead.mobile` (production), `app.planeahead.mobile.dev` (staging); it also signs the revocation                                |
  | `GOOGLE_CLIENT_ID_WEB`, `GOOGLE_CLIENT_ID_IOS`, `GOOGLE_CLIENT_ID_ANDROID`           | the three OAuth client ids of the Google Cloud project                                                                                                    |
  | `RESEND_API_KEY`                                                                     | the Resend key for the verified sending domain                                                                                                            |
  | `AERODATABOX_API_KEY`, `AEROAPI_API_KEY`                                             | provider keys (AeroAPI unused while `AEROAPI_MODE` is `mock`; set a placeholder until step 13 decides)                                                    |
  | `WEBHOOK_TOKEN_AERODATABOX`, `WEBHOOK_TOKEN_AEROAPI`                                 | `openssl rand -base64 32 \| tr '+/' '-_' \| tr -d '='`, one per provider and environment                                                                  |
  | `DELETED_SUBJECT_HMAC_KEY`, `IP_SALT_SECRET`                                         | `openssl rand -base64 32` each, different per environment                                                                                                 |
  | `CF_API_TOKEN` (optional)                                                            | the operational token of step 1                                                                                                                           |
  | `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID` (production required, staging optional) | the APNs auth key of step 19 (`.p8` PEM with newlines written as `\n`), its key id, the team id: a Sandbox key on staging, a Production key on production |
  | `FCM_SERVICE_ACCOUNT_JSON` (production required, staging optional)                   | the FCM sender's service-account JSON key file of step 19, whole: `pnpm exec wrangler secret put FCM_SERVICE_ACCOUNT_JSON --env <env> < key.json`         |

- [ ] `ADB_PLAN=growth` in BOTH environments (`pnpm exec wrangler secret put ADB_PLAN --env <env>`,
      value `growth`, or a `vars` entry), for the Growth plan of step 0. Required, not optional:
      an unset or unknown value means Starter, whose quota the ProviderBudget spreads as a daily
      cap of 40,000 / 30 = 1,333 units, about 8 flights a day in mock mode, a tenth of what Growth
      pays for, after which the kill switch trips.
- [ ] Optional settings, only where a non-default is wanted (`wrangler secret put` or a `vars`
      entry): `AEROAPI_MODE` (`mock` default),
      `ADB_ALERTS_ENABLED`, `REVENUECAT_DELETE_ENABLED`, `APPLE_BUNDLE_IDS` (defaults to the
      environment's variants: production and preview against production, development against
      staging), `APPLE_TEAM_ID`, `APP_BUNDLE_IDS` and `ANDROID_SHA256_FINGERPRINTS` (step 11), and
      in production only `PUSH_INJECT_ALLOWED_USER_IDS` (step 19: the user ids whose tokens the
      admin page's test push may reach there, comma separated; unset refuses every token).
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
- [ ] `ANDROID_SHA256_FINGERPRINTS` per environment (`package=FP,FP;...`; every app signing key
      Play shows for the package AND the upload key, from Play Console > Protected with Play > Play
      Store distribution > Play app signing; a new app's hybrid signing shows three app signing
      fingerprints, step 18), then
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
      (Mondays). Its iOS gate leg took about 22 macOS minutes a run; increment 13's unsigned device
      archive adds about 16 (estimated; the first run after it measures it), so about 38, or $10
      of the $12 GitHub Free's minutes are worth each month, before the Android leg and every pull
      request's Linux checks. In September 2026 six nightly runs used the whole allowance and
      GitHub refused every job, PR checks included, until the month reset. Add a payment method
      with a budget (Settings > Billing and licensing) before the allowance runs short again: about
      $5 a month over the free minutes keeps the weekly run and the pull request checks going with
      margin; nightly costs about $2.50 a night, after which its cron can become `'17 6 * * *'`.
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

## 18. Store builds: TestFlight and the Play internal track

Increment 13. Testers get the `production` variant (`app.planeahead.mobile`), store signed, which
talks to `api.planeahead.app`, so step 17 comes first; steps 11 and 12 too. Run every `eas`
command from `apps/mobile` with the pinned CLI version or newer (`eas.json` `cli.version`). The
repository already carries what the builds need and the weekly native smoke proves it: the pinned
EAS images and CocoaPods, a privacy manifest in every bundle, the app's version in every embedded
bundle, `ITSAppUsesNonExemptEncryption: false`, and the Sentry upload held off
(docs/increments/13-verification.md). Not needed for internal testing: Beta App Review, the App
Privacy answers, Play's Data safety form, the content rating and the store listing.

- [ ] App Store Connect record (Account Holder, Admin or App Manager): Apps > + > New App, platform
      iOS, name `PlaneAhead` (at most 30 characters, editable until the first App Review
      submission), primary language, bundle ID `app.planeahead.mobile`, SKU `planeahead-ios`, user
      access Full. The bundle ID and the SKU are permanent; of the bundle ID Apple says "You can't
      change this property after you upload a build"
      ([App information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information)).
      Then copy the record's Apple ID (App Information > General, a number) into
      `apps/mobile/eas.json` as `"submit": { "production": { "ios": { "ascAppId": "<Apple ID>" } } }`
      next to the `android` entry, and commit it on a branch. This is the one manual edit the
      submit profile waits for: without it `eas submit` signs in with an Apple ID and creates the
      app interactively, which CI cannot answer. `__tests__/app-config.test.ts` asserts the id is
      absent: change that assertion to the committed value in the same commit.
- [ ] Internal TestFlight group: TestFlight > Internal Testing > + > `PlaneAhead internal`, with
      **Enable automatic distribution**, so every processed build reaches it without a submit
      step. Internal testers are App Store Connect users with a role (up to 100, invited in Users
      and Access first); their builds need no review
      ([TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview)).
- [ ] Team API key for `eas submit`: Users and Access > Integrations > App Store Connect API > Team
      Keys > +, access Admin (Expo's guide asks for it; whether App Manager suffices is unverified,
      R5 U7). The `.p8` downloads once: then `eas credentials --platform ios`, profile
      `production`, App Store Connect API key, add it with its key ID and issuer ID, and delete
      the local file.
- [ ] Play Console app (Owner or Admin): Create app, name `PlaneAhead`, default language, App, Free,
      the declarations and the Play App Signing terms. The package name comes with the first
      upload and never changes: Play calls package names "unique and permanent"
      ([Create and set up your app](https://support.google.com/googleplay/android-developer/answer/9859152)).
      Then Test and release > Testing > Internal testing > Testers: an email list of the testers
      (up to 100), and copy its opt-in link for them.
- [ ] Play service account for `eas submit`: in the Google Cloud project of the OAuth clients,
      enable the Google Play Android Developer API; IAM > Service accounts > create `eas-submit`,
      Keys > Add key > JSON. In Play Console > Users and permissions > Invite new users, the
      service account's email with, for PlaneAhead, the permissions to release to testing tracks
      and to manage testing tracks and tester lists
      ([Expo's guide](https://github.com/expo/fyi/blob/main/creating-google-service-account.md)).
      Then `eas credentials --platform android`, profile `production`, Google Service Account,
      upload the JSON key, and delete the local file.
- [ ] First iOS production build, interactively on the Mac, logged in with the Apple ID:
      `eas build --platform ios --profile production`, answering yes to the Apple account login
      and to EAS managing the credentials. App Groups are registered only with an Apple ID session,
      never with the API key ([iOS capabilities](https://docs.expo.dev/build-reference/ios-capabilities/)),
      so this first run cannot come from CI. EAS registers the four App IDs step 12 lists when they
      are missing (the app, `.widgets`, `.watchkitapp`, `.watchkitapp.widget`), syncs their
      capabilities, and creates the distribution certificate and the four provisioning profiles.
      It does not group Sign in with Apple (step 12 does, first).
- [ ] First Android production build: `eas build --platform android --profile production`, letting
      EAS generate the upload keystore. Keep a copy: `eas credentials --platform android`,
      profile `production`, download the keystore, into the password manager.
- [ ] Submit both: `eas submit --platform ios --profile production --latest`, then
      `eas submit --platform android --profile production --latest`. The iOS build appears in
      TestFlight after processing and automatic distribution hands it to the internal group. The
      Android release goes to the internal track (`submit.production.android` in eas.json). If
      Play refuses it with "Only releases with status draft may be created on draft app", the app
      has never been published: download that build's `.aab` from its EAS build page, upload it by
      hand in Internal testing > Create new release, roll it out, and use `eas submit` for every
      later build.
- [ ] Signing fingerprints, after the first Play upload: Protected with Play > Play Store
      distribution > Play app signing. A new app gets hybrid signing, with three app signing keys
      whose fingerprints must all be registered with every API provider
      ([Play app signing](https://support.google.com/googleplay/android-developer/answer/9842756)),
      plus the upload key. Put every SHA-256 into `ANDROID_SHA256_FINGERPRINTS` for
      `app.planeahead.mobile` (step 11) and create a Google OAuth Android client for the package
      with each SHA-1, so Google sign-in works whichever key signed the installed app. Hybrid
      versus classic can change only until the first open testing or production release; the
      plan took hybrid (docs/plans/phase1-plan.md section 13, decision 10).
- [ ] Export compliance: `ITSAppUsesNonExemptEncryption: false` (app.config.ts) answers App Store
      Connect's export compliance question for every build; without it each build waits in
      Missing Compliance. It is your attestation that the app uses only encryption built into the
      operating system (HTTPS, the Keychain through expo-secure-store, CommonCrypto through
      expo-crypto), which Apple treats as exempt
      ([Complying with encryption export regulations](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations)).
      Confirm it now, and again before adding any library that brings its own cryptography.
- [ ] Sentry: `apps/mobile/eas.json` sets `SENTRY_DISABLE_AUTO_UPLOAD=true` for every build profile,
      because Sentry's Xcode and Gradle steps fail a Release build whose upload fails and no Sentry
      project exists yet. Once `SENTRY_ORG`, `SENTRY_PROJECT` (Plain text) and `SENTRY_AUTH_TOKEN`
      (Secret) are in the three EAS environments (apps/mobile/README.md, owner tasks), delete the
      line from `build.base.env` and its assertion in `__tests__/app-config.test.ts` in one change;
      the next production build's log shows the source maps and debug files uploaded.
- [ ] Later builds run unattended once `ascAppId` is committed and both keys are stored:
      `eas build --platform all --profile production --auto-submit`, from CI with `EXPO_TOKEN`.
- [ ] Check: the build reaches Ready to Submit in TestFlight (distributable to internal testers)
      with no email about a missing privacy manifest reason (ITMS-91053) or an invalid binary; an
      internal tester installs it and the app opens on the sign-in screen; an Android tester opts
      in with the link and installs from Play. Record any App Store Connect email in
      docs/increments/13-verification.md (its unverified items).

## 19. Push transport: keys and the staging send

Increment 14. The API sends APNs directly and FCM through HTTP v1 from the `push` queue's
consumer; nothing produces real push jobs until increment 15, so the first push is the admin
page's test push. Staging deploys without any push secret (its consumer holds push jobs as
`not_configured` and `/admin` says so); production requires them (step 6). The exact staging
commands are in `docs/increments/14-verification.md`.

- [ ] APNs keys (Certificates, Identifiers and Profiles > Keys > +, **Apple Push Notifications
      service (APNs)**): one team-scoped key restricted to **Sandbox** for staging and one to
      **Production** for production (Apple allows two per environment; keep one slot free for
      rotation). Download each `.p8` once and note its key id and the team id; then step 6's
      `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID` per environment. Push Notifications is already
      on the three App IDs (step 12).
- [ ] Firebase: a project with the three Android apps (`app.planeahead.mobile`, `.preview`,
      `.dev`), the FCM API (V1) enabled, and a dedicated service account holding only
      `cloudmessaging.messages.create` (a custom role), with a JSON key (an organisation created
      on or after 2024-05-03 blocks key creation until an admin exempts the project). The key is
      step 6's `FCM_SERVICE_ACCOUNT_JSON`. The apps' `google-services.json` files are the client
      half (apps/mobile/README.md).
- [ ] Access for `/admin` (step 14) exists in the environment.
- [ ] Cloudflare, before the staging send: confirm the `planeahead.app` zone's **HTTP/2 to Origin**
      setting is on (dashboard, the zone, Speed > Settings > Protocol Optimization; on by default
      on every plan). APNs speaks HTTP/2 only; whether this zone setting governs a Worker's
      subrequests to a third-party host such as Apple at all is unverified (R1 U3): Cloudflare
      documents it for a zone proxying to its own origin. Keeping it on costs nothing.
- [ ] The staging send: a development build on the Simulator (Apple silicon, iOS 16+), signed in
      (a guest is enough), registers its token with Settings > Notifications > Allow
      notifications; `/admin/push/test` with that token, kind APNs and app id
      `app.planeahead.mobile.dev`; the result page shows `sent` with an `apns-id` and the
      Simulator shows the notification. Any other answer is a result too: record it in
      `docs/increments/14-verification.md`.
- [ ] If the send, or later the admin page's outcomes by reason during the soak, shows `edge_52x`
      answers without an `apns-id`: check the HTTP/2 to Origin setting above first, and only then
      open the Cloudflare support ticket asking how Worker subrequests to third-party origins are
      pooled and whether they speak HTTP/2 (R1 U2 and U3, owner action 7). That the setting
      governs Worker subrequests is unverified, so a setting found on does not close the question.
      Record the setting's state and the answer in `docs/increments/14-verification.md`.
- [ ] Production, after the first TestFlight install (increment 16): `PUSH_INJECT_ALLOWED_USER_IDS`
      set to your own user id, then the same test push to your iPhone's token.
