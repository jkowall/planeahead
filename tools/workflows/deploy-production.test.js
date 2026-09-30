/**
 * The production deploy workflow's shape (increment 12, ruling W6) and the smoke script both deploy
 * workflows run.
 *
 * Nothing here can deploy (no Cloudflare account, no Neon project), so the proof is the file:
 * triggered by a `v*` tag and by a manual run with a typed confirmation; the deploy job runs only
 * on that manual run, on a tag, with the tag typed back; migrations against
 * `NEON_PRODUCTION_DIRECT_URL` before the deploy, a plain `wrangler deploy --env production`
 * through wrangler-action v4 at wrangler 4.135.0 with an empty `secrets` input, and then the
 * `/health` smoke on api.planeahead.app that compares the build's migration hash and Durable
 * Object schema versions. The job keys' uniqueness is native-smoke.test.js's check over every
 * workflow; the migration-hash ordering is migration-hash-check.test.js's.
 *
 * Text based, like its siblings: the repository has no YAML parser at the root.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DO_FILES, compareHealth, expectedHealth } from '../../scripts/health-smoke.mjs';

const repoRoot = join(import.meta.dirname, '..', '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');

/** The workflow without comment lines, so prose about a command cannot satisfy a check. */
function code(file) {
  return readFileSync(join(workflowsDir, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** One job's block (non-comment lines), up to the next key at two spaces. */
function jobBlock(text, job) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `  ${job}:`);
  expect(start, `job ${job} is missing`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

describe('deploy-production.yml', () => {
  const text = code('deploy-production.yml');

  it('runs on a v* tag and on a manual run with a required confirmation, nothing else', () => {
    const on = text.slice(text.indexOf('\non:'), text.indexOf('\nconcurrency:'));
    expect(on).toMatch(/push:\s*\n\s+tags: \['v\*'\]/);
    expect(on).not.toMatch(/branches:/);
    expect(on).not.toMatch(/pull_request/);
    expect(on).toMatch(/workflow_dispatch:\s*\n\s+inputs:\s*\n\s+confirm:/);
    expect(on).toMatch(/required: true/);
    expect(text).toMatch(
      /concurrency:\s*\n\s+group: deploy-production\s*\n\s+cancel-in-progress: false/,
    );
  });

  it('deploys only from a manual run on a tag with the tag typed back, after the verify job', () => {
    const deploy = jobBlock(text, 'deploy');
    expect(deploy).toContain('needs: verify');
    expect(deploy).toContain("github.event_name == 'workflow_dispatch'");
    expect(deploy).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(deploy).toContain("inputs.confirm == format('deploy {0}', github.ref_name)");
    expect(deploy).toMatch(/environment:\s*\n\s+name: production/);
  });

  it('verifies with the dry run of the production environment and the Worker suite', () => {
    const verify = jobBlock(text, 'verify');
    expect(verify).toContain('wrangler deploy --dry-run --env production');
    expect(verify).toContain('pnpm turbo run test --filter=@planeahead/api');
    expect(verify).toContain('image: postgres:18');
  });

  it('migrates, then deploys plainly with wrangler-action v4 and empty secrets, then smokes', () => {
    const deploy = jobBlock(text, 'deploy');
    const migrate = deploy.indexOf('NEON_PRODUCTION_DIRECT_URL');
    const dbMigrate = deploy.indexOf('pnpm --filter @planeahead/db run db:migrate');
    const action = deploy.indexOf('uses: cloudflare/wrangler-action@v4');
    const smoke = deploy.indexOf(
      'node scripts/health-smoke.mjs https://api.planeahead.app production',
    );
    expect(migrate).toBeGreaterThan(-1);
    expect(dbMigrate).toBeGreaterThan(migrate);
    expect(action).toBeGreaterThan(dbMigrate);
    expect(smoke).toBeGreaterThan(action);
    expect(deploy).toContain("wranglerVersion: '4.135.0'");
    expect(deploy).toContain('command: deploy --env production');
    expect(deploy).toContain("secrets: ''");
    // A missing migration URL fails the deploy.
    expect(deploy).toMatch(/NEON_PRODUCTION_DIRECT_URL is not set[^\n]*\n\s+exit 1/);
    // Gradual deployments are unsupported with `exports`: the versions path never comes back.
    expect(text).not.toMatch(/versions (upload|deploy)/);
  });

  it('staging deploys with the same migrate, deploy, smoke shape', () => {
    const staging = jobBlock(code('deploy-staging.yml'), 'deploy');
    const migrate = staging.indexOf('pnpm --filter @planeahead/db run db:migrate');
    const action = staging.indexOf('uses: cloudflare/wrangler-action@v4');
    const smoke = staging.indexOf(
      'node scripts/health-smoke.mjs https://api-staging.planeahead.app staging',
    );
    expect(migrate).toBeGreaterThan(-1);
    expect(action).toBeGreaterThan(migrate);
    expect(smoke).toBeGreaterThan(action);
    expect(staging).toContain('command: deploy --env staging');
    // A missing migration URL fails the staging deploy too (ruling AA10): never a warning and a
    // deploy over an unmigrated schema.
    expect(staging).toMatch(/NEON_STAGING_DIRECT_URL is not set[^\n]*\n\s+exit 1/);
    expect(staging).not.toMatch(/Migrations skipped/);
    expect(staging).not.toMatch(/exit 0/);
  });
});

describe('scripts/health-smoke.mjs', () => {
  it('reads the build from the repository: the generated hash and every Durable Object version', () => {
    const expected = expectedHealth();
    expect(expected.migrationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(expected.migrationCount).toBeGreaterThan(0);
    expect(Object.keys(expected.doSchemaVersions).sort()).toEqual([
      'AirportState',
      'DesignatorResolver',
      'FlightTracker',
      'ProviderBudget',
      'PushAuth',
      'UserInbox',
    ]);
  });

  it('checks exactly the classes /health reports: DO_FILES names every DO_SCHEMA_VERSIONS key', () => {
    const health = readFileSync(
      join(repoRoot, 'apps', 'api', 'src', 'routes', 'health.ts'),
      'utf8',
    );
    const block = /export const DO_SCHEMA_VERSIONS = Object\.freeze\(\{([^}]*)\}\)/.exec(
      health,
    )?.[1];
    expect(block, 'DO_SCHEMA_VERSIONS not found in health.ts').toBeDefined();
    const keys = [...(block ?? '').matchAll(/^\s*([A-Za-z]+):/gm)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect([...keys].sort()).toEqual(Object.keys(DO_FILES).sort());
  });

  it('passes a /health body that is this build and names every mismatch otherwise', () => {
    const expected = {
      migrationHash: 'a'.repeat(64),
      migrationCount: 5,
      doSchemaVersions: { FlightTracker: 2, ProviderBudget: 1 },
    };
    const body = {
      ok: true,
      environment: 'production',
      migrationHash: 'a'.repeat(64),
      migrationCount: 5,
      doSchemaVersions: { FlightTracker: 2, ProviderBudget: 1 },
    };
    expect(compareHealth(expected, 'production', body)).toEqual([]);
    expect(
      compareHealth(expected, 'production', {
        ...body,
        environment: 'staging',
        migrationHash: 'b'.repeat(64),
        doSchemaVersions: { FlightTracker: 1, ProviderBudget: 1 },
      }),
    ).toEqual([
      'environment is "staging", expected production',
      `migrationHash is "${'b'.repeat(64)}", the build has ${'a'.repeat(64)}`,
      'doSchemaVersions.FlightTracker is 1, the build has 2',
    ]);
    expect(compareHealth(expected, 'production', null)).toEqual(['the body is not a JSON object']);
  });

  it('fails loudly on a checkout without the constants it compares', () => {
    const root = mkdtempSync(join(tmpdir(), 'health-smoke-'));
    try {
      mkdirSync(join(root, 'apps', 'api', 'src', 'generated'), { recursive: true });
      mkdirSync(join(root, 'apps', 'api', 'src', 'do'), { recursive: true });
      writeFileSync(join(root, 'apps', 'api', 'src', 'generated', 'migration-hash.ts'), '');
      expect(() => expectedHealth(root)).toThrow(/MIGRATION_HASH/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
