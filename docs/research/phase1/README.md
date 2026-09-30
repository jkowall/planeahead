# Phase 1 facts sheets

Five research sheets written on 2026-09-30, before the Phase 1 plan (`docs/plans/phase1-plan.md`),
each by an Opus 5.5 researcher checking the questions the plan depends on against primary sources
(vendor documentation, licences and terms, pricing pages, maintainers' statements) and against the
repository at `main` 3302d39. Every fact carries its source URL and the date it was checked;
quotes are at most 15 words. Raw copies of the fetched pages, licences and terms were kept outside
the repository.

| Sheet | Question |
| --- | --- |
| [R1](R1-push-transport.md) | Push transport from Workers: APNs over HTTP/2, FCM HTTP v1, the platform limits that bound fan-out |
| [R2](R2-client-push.md) | Client push on Expo SDK 57: permissions, raw tokens, presentation, token hygiene |
| [R3](R3-boards-and-route-search.md) | Airport boards and route search: providers, prices, caching and licence terms |
| [R4](R4-change-detection.md) | Detecting delay and gate changes: AeroAPI alerts, AeroDataBox webhooks, polling, push policy |
| [R5](R5-store-distribution.md) | Shipping to TestFlight and the Play internal track: accounts, manifests, EAS, lead times |

Each sheet ends with the items it could not verify and how to settle them, and the owner actions
with their lead times; the plan's sections 10 and 11 collect them.
