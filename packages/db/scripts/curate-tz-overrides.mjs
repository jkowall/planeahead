#!/usr/bin/env node
/**
 * Promotes reviewed geo-tz candidates from seed/data/airports.tz-review.json into
 * seed/data/airports.tz-overrides.json, and lists the rejects in airports.tz-rejected.json.
 *
 * The check: a candidate zone is accepted only when IANA's zone1970.tab lists the airport's
 * ISO country for that zone. zone1970.tab is fetched at run time (public domain, part of tzdata)
 * and is not committed. A candidate whose zone does not list the country is rejected, never
 * guessed; the loader skips rejected airports with a warning and fails on any other null tz.
 *
 * Usage: node scripts/curate-tz-overrides.mjs [--curated-on YYYY-MM-DD]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(packageRoot, 'seed', 'data');
const ZONE_TAB_URL = 'https://raw.githubusercontent.com/eggert/tz/main/zone1970.tab';
// geo-tz returns the timezone-boundary-builder name, which for merged zones is a backward link
// (Pacific/Majuro is a link to Pacific/Tarawa). zone1970.tab lists only canonical zones, so links
// are resolved through tzdata's `backward` file before the country check.
const BACKWARD_URL = 'https://raw.githubusercontent.com/eggert/tz/main/backward';
const curatedOn = process.argv.includes('--curated-on')
  ? process.argv[process.argv.indexOf('--curated-on') + 1]
  : new Date().toISOString().slice(0, 10);

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'accept-encoding': 'identity' } });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}
const tab = await fetchText(ZONE_TAB_URL);
const links = new Map();
for (const line of (await fetchText(BACKWARD_URL)).split('\n')) {
  const match = /^Link\s+(\S+)\s+(\S+)/.exec(line);
  if (match !== null) {
    links.set(match[2], match[1]);
  }
}
function canonical(zone) {
  let current = zone;
  for (let hops = 0; hops < 5 && links.has(current); hops += 1) {
    current = links.get(current);
  }
  return current;
}
const zoneCountries = new Map();
for (const line of tab.split('\n')) {
  if (line.startsWith('#') || line.trim() === '') {
    continue;
  }
  const [codes, , zone] = line.split('\t');
  zoneCountries.set(zone, codes.split(','));
}

const review = JSON.parse(await readFile(join(dataDir, 'airports.tz-review.json'), 'utf8'));
const accepted = {};
const rejected = [];
for (const entry of review.entries) {
  if (!entry.candidate) {
    rejected.push({
      icao: entry.icao,
      iso_country: entry.iso_country,
      name: entry.name,
      reason: 'geo-tz returned no candidate',
    });
    continue;
  }
  const canonicalZone = canonical(entry.candidate);
  const countries = zoneCountries.get(canonicalZone);
  if (countries === undefined) {
    rejected.push({
      icao: entry.icao,
      iso_country: entry.iso_country,
      name: entry.name,
      candidate: entry.candidate,
      reason: `zone ${canonicalZone} is not in zone1970.tab`,
    });
    continue;
  }
  if (!countries.includes(entry.iso_country)) {
    rejected.push({
      icao: entry.icao,
      iso_country: entry.iso_country,
      name: entry.name,
      candidate: entry.candidate,
      zone_countries: countries,
      reason: `zone ${entry.candidate} is listed for ${countries.join(',')}, not ${entry.iso_country}`,
    });
    continue;
  }
  accepted[entry.icao] = {
    tz: entry.candidate,
    ...(canonicalZone !== entry.candidate ? { canonical: canonicalZone } : {}),
    iso_country: entry.iso_country,
    name: entry.name,
    source:
      'geo-tz candidate, accepted because zone1970.tab lists the airport country for the zone',
  };
}

const overrides = {
  $comment: `Curated on ${curatedOn} by scripts/curate-tz-overrides.mjs: each geo-tz candidate from airports.tz-review.json was checked against the airport's ISO country using IANA zone1970.tab and accepted only when the zone lists that country. This file is committed as reviewed data (the geo-tz boundary data is ODbL and is never used at build or run time). Rejected candidates are in airports.tz-rejected.json.`,
  curated_on: curatedOn,
  accepted: Object.keys(accepted).length,
  entries: Object.fromEntries(Object.entries(accepted).sort(([a], [b]) => (a < b ? -1 : 1))),
};
const rejects = {
  $comment: `Written on ${curatedOn} by scripts/curate-tz-overrides.mjs. Airports whose geo-tz candidate did not pass the country check. The airports loader skips these with a warning; resolving one means adding it to airports.tz-overrides.json by hand with a stated source and removing it here.`,
  curated_on: curatedOn,
  count: rejected.length,
  entries: rejected.sort((a, b) => (a.icao < b.icao ? -1 : 1)),
};
await writeFile(
  join(dataDir, 'airports.tz-overrides.json'),
  `${JSON.stringify(overrides, null, 2)}\n`,
);
await writeFile(
  join(dataDir, 'airports.tz-rejected.json'),
  `${JSON.stringify(rejects, null, 2)}\n`,
);
console.log(`accepted ${Object.keys(accepted).length}, rejected ${rejected.length}`);
for (const r of rejected) {
  console.log(`  rejected ${r.icao} (${r.iso_country}) ${r.name}: ${r.reason}`);
}
