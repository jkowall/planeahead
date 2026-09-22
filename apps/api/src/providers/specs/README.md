# Vendored provider OpenAPI snapshots

Byte-for-byte copies of the providers' own OpenAPI documents, fetched on 2026-09-22. The adapters
in `src/providers` are written against these files, the fixtures in `src/providers/fixtures` are
checked against them by the adapter tests, and the SHA-256 of each file is pinned in those tests,
so a changed spec is a deliberate re-vendoring rather than a silent drift. `.prettierignore`
keeps Prettier off them; do not reformat or edit them.

| File                              | Source                                                                       | Version  | SHA-256                                                            | Pinned in                               |
| --------------------------------- | ---------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ | --------------------------------------- |
| `aerodatabox-direct-v1.15.3.yaml` | https://doc.aerodatabox.com/docs/openapi-direct-v1.yaml                      | 1.15.3.0 | `9d2d6b908c57dc9a3e3f9b24ff5df9074d26c5f344011c8f412e6843ffb2c4b5` | `test/unit/aerodatabox.adapter.test.ts` |
| `aeroapi-v4.17.1.yaml`            | https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml | 4.17.1   | `3023e7a0c54c86be61d130eacf9a420516574569d43c4feb62444e0b38611da5` | `test/unit/aeroapi.mock.test.ts`        |

Both downloads succeeded on the first attempt, so no fixture is built from the facts sheet's
prose alone. The AeroDataBox file is the direct gateway's document, whose security scheme is the
`X-Api-Key` header; the API.Market copy ships empty `securitySchemes` and is not a source of
truth (facts sheet section 1). The AeroAPI file is saved with a `.yaml` extension; the content is
unchanged from the `.yml` the URL serves.

The tests read the files as text through Vite's `?raw` import (the Workers test pool has no view
of the repository) and walk them with a small indentation reader in
`test/unit/helpers/openapi.ts`; there is no YAML library in the project.

## Re-vendoring

1. Download the new document to this folder under a name carrying its version.
2. Update the SHA-256 constant in the test that pins it, and this table.
3. Run the adapter tests: every fixture is checked against the schema, so a field the provider
   removed or retyped fails there first.
4. Record the change and what it broke in `docs/build-log.md`.

## Known gaps in the specs themselves

- Neither spec declares a 429, a `Retry-After` or any rate-limit header, although both providers
  enforce per-second limits. The adapters treat a 429, a 503 or a non-JSON body as a push-back;
  the AeroAPI rate-limit fixture is marked unverified.
- AeroDataBox documents only a generic `ErrorContract` for a 400; the body for an out-of-range
  date is unverified. Unauthenticated calls meet a Cloudflare HTML 403.
- AeroAPI's `status` field has no enum and no example; the adapters never read it.
- AeroAPI's `POST /alerts` request body lists server-generated fields (`id`, `created`,
  `changed`) as required; the adapter sends only the fields a client can set, and the test checks
  that every field it sends is declared.
