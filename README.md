# PlaneAhead

PlaneAhead is a flight tracking service built as a pnpm + Turborepo monorepo: a Cloudflare Workers
API backed by Neon Postgres and Durable Objects, shared Zod contracts, and a React Native + Expo
mobile app. This repository is being built increment by increment; the full design, decisions and
cost model live in [docs/plans/phase0-plan.md](docs/plans/phase0-plan.md), with architecture
decision records in [docs/adr](docs/adr) and a per-increment record in
[docs/build-log.md](docs/build-log.md).

## Quick start

```sh
corepack enable        # or: npm i -g pnpm@12
pnpm install
pnpm turbo run typecheck lint test
pnpm prettier --check .
node scripts/toolchain-guard.mjs
```

Node 24 is required (see `.node-version`); pnpm is pinned through `packageManager`.
