# Drop Service Roads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove OSM `highway=service` ways from the game board — excluded from future imports and purged (clean sweep, claims included) from existing local and production databases.

**Architecture:** The importer's highway filter drops `service`, with the rideable list promoted to a testable constant in `lib/config.ts`. A one-time purge script fetches service **way-IDs** from Overpass (the DB doesn't store highway tags) and deletes matching segments by `osm_way_id`; claims cascade via the existing FK. The purge is dry-run by default with an implausibility tripwire, and its core is a library function with DB-gated tests. The shared Overpass fetch helper moves from the importer script into `lib/network/overpass.ts`.

**Tech Stack:** existing stack — tsx scripts, porsager postgres, Overpass API, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-05-drop-service-roads-design.md`

## Global Constraints

- Rideable highway set after this change: `track|path|bridleway|unclassified|tertiary|secondary|residential|cycleway|living_street` (exactly v1 minus `service`).
- Purge deletes by `osm_way_id = ANY(<ids>)`, chunked at 10,000 IDs per DELETE statement; claims cascade via existing `ON DELETE CASCADE` — no claims-table code in the purge.
- Dry-run by default; deletion ONLY with `--execute`.
- Abort (throw) when the Overpass ID list has fewer than 100 ways — a truncated response must never drive a mass delete. Overpass fetch failures hard-fail (existing helper behavior).
- Ride rows are never touched: XP/Grit/etc. stay banked; only `segments` (and cascaded `claims`) change.
- Rollout order is code → local dry-run → local execute → verify → prod dry-run → prod execute. Never run `--execute` before reviewing that DB's dry-run numbers.
- Full gate per task: `TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npx vitest run` green (72 existing + new), `npx tsc --noEmit` clean, `npm run build` clean.
- Integration tests skip-not-fail without `TEST_DATABASE_URL` (existing `d = TEST_DB_URL ? describe : describe.skip` pattern).

## File Structure

```
lib/config.ts                     # + RIDEABLE_HIGHWAYS constant (modify)
lib/network/overpass.ts           # overpass() + mirrors + User-Agent, extracted from importer (new)
lib/network/purge.ts              # purgeByWayIds() + assertPlausibleIdList() (new)
scripts/import-network.ts         # use lib/network/overpass + RIDEABLE_HIGHWAYS (modify)
scripts/purge-service-roads.ts    # CLI: fetch IDs → report → --execute (new)
tests/config.test.ts              # RIDEABLE_HIGHWAYS composition (new)
tests/purge.test.ts               # DB-gated purge core tests (new)
package.json                      # + purge:service script (modify)
```

---

### Task 1: Board filter constant + Overpass helper extraction

**Files:**
- Modify: `lib/config.ts`, `scripts/import-network.ts`
- Create: `lib/network/overpass.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: current `scripts/import-network.ts` (contains the `overpass()` helper, `OVERPASS_URLS`, `HIGHWAYS` string).
- Produces (Task 2 depends on these): `overpass(query: string): Promise<any>` from `lib/network/overpass`; `RIDEABLE_HIGHWAYS: string[]` from `lib/config`.

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RIDEABLE_HIGHWAYS } from '@/lib/config';

describe('RIDEABLE_HIGHWAYS', () => {
  it('excludes service roads (driveways/parking aisles are not part of the game board)', () => {
    expect(RIDEABLE_HIGHWAYS).not.toContain('service');
  });

  it('keeps the v1 rideable set otherwise', () => {
    expect([...RIDEABLE_HIGHWAYS].sort()).toEqual([
      'bridleway', 'cycleway', 'living_street', 'path', 'residential',
      'secondary', 'tertiary', 'track', 'unclassified',
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `RIDEABLE_HIGHWAYS` is not exported from `@/lib/config`.

- [ ] **Step 3: Implement**

Append to `lib/config.ts`:

```ts
/**
 * OSM highway values that make up the game board. `service` is deliberately
 * absent (driveways, parking aisles, alleys — dropped 2026-07-05; see
 * docs/superpowers/specs/2026-07-05-drop-service-roads-design.md).
 */
export const RIDEABLE_HIGHWAYS = [
  'track', 'path', 'bridleway', 'unclassified', 'tertiary', 'secondary',
  'residential', 'cycleway', 'living_street',
];
```

Create `lib/network/overpass.ts` by MOVING (not copying) the `OVERPASS_URLS` constant and `overpass()` function out of `scripts/import-network.ts`, unchanged including the User-Agent header and mirror-fallback comments:

```ts
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export async function overpass(query: string): Promise<any> {
  let lastError: unknown;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'gravel-atlas/1.0 (personal project)',
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) throw new Error(`overpass ${url}: ${res.status}`);
      return await res.json();
    } catch (e) {
      lastError = e;
      console.warn(`overpass mirror failed, trying next: ${e}`);
    }
  }
  throw lastError;
}
```

(The current importer's helper may differ slightly in comment text or header value — when moving, keep the EXISTING implementation verbatim; the listing above shows the expected shape, the file is the source of truth.)

Update `scripts/import-network.ts`:
- Delete the moved constant/function; add `import { overpass } from '../lib/network/overpass';` and `import { RIDEABLE_HIGHWAYS } from '../lib/config';`
- Replace the `HIGHWAYS` constant with: `const HIGHWAYS = RIDEABLE_HIGHWAYS.join('|');`
- Everything else unchanged.

- [ ] **Step 4: Run to verify pass + full gate**

Run: `npx vitest run tests/config.test.ts` → 2 passed.
Then: `TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npx vitest run` → 74 passed; `npx tsc --noEmit` clean; `npm run build` clean.

- [ ] **Step 5: Commit**

```bash
git add lib/config.ts lib/network/overpass.ts scripts/import-network.ts tests/config.test.ts
git commit -m "feat: exclude service roads from the board; extract shared overpass helper"
```

---

### Task 2: Purge core + CLI

**Files:**
- Create: `lib/network/purge.ts`, `scripts/purge-service-roads.ts`
- Modify: `package.json` (script)
- Test: `tests/purge.test.ts`

**Interfaces:**
- Consumes: `overpass()` from `lib/network/overpass`; `REGION` from `lib/region`; test helpers `testDb`, `resetDb`, `insertSegment`, `insertRide`, `TEST_DB_URL` from `tests/helpers/db`.
- Produces:
  - `MIN_PLAUSIBLE_IDS = 100`; `assertPlausibleIdList(ids: number[]): void` (throws below the minimum)
  - `type PurgeReport = { waysWithSegments: number; segments: number; km: number; claimed: number; deleted: boolean }`
  - `purgeByWayIds(sql: postgres.Sql, wayIds: number[], execute: boolean): Promise<PurgeReport>`
  - `npm run purge:service` (dry-run) / `npm run purge:service -- --execute`

- [ ] **Step 1: Write the failing tests**

Create `tests/purge.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, insertSegment, insertRide, TEST_DB_URL } from './helpers/db';
import { purgeByWayIds, assertPlausibleIdList, MIN_PLAUSIBLE_IDS } from '@/lib/network/purge';

describe('assertPlausibleIdList', () => {
  it('throws below the plausibility floor', () => {
    expect(() => assertPlausibleIdList(Array.from({ length: MIN_PLAUSIBLE_IDS - 1 }, (_, i) => i)))
      .toThrow(/refusing/i);
  });

  it('passes at the floor', () => {
    expect(() => assertPlausibleIdList(Array.from({ length: MIN_PLAUSIBLE_IDS }, (_, i) => i)))
      .not.toThrow();
  });
});

const d = TEST_DB_URL ? describe : describe.skip;

d('purgeByWayIds', () => {
  const sql = testDb();
  // ~200 m segments at lat 54.40; wayIds 1 & 2 play "service", 3 is a keeper
  const WKT_A = 'LINESTRING(16.900000 54.400000, 16.903086 54.400000)';
  const WKT_B = 'LINESTRING(16.910000 54.400000, 16.913086 54.400000)';
  const WKT_C = 'LINESTRING(16.920000 54.400000, 16.923086 54.400000)';

  beforeEach(async () => {
    await resetDb(sql);
    await insertSegment(sql, { wayId: 1, wkt: WKT_A, surface: 'unpaved' });
    await insertSegment(sql, { wayId: 2, wkt: WKT_B, surface: 'paved' });
    await insertSegment(sql, { wayId: 3, wkt: WKT_C, surface: 'unpaved' });
    const rideId = await insertRide(sql, { stravaId: 900 });
    await sql`
      INSERT INTO claims (segment_id, ride_id, claimed_at)
      SELECT id, ${rideId}, now() FROM segments WHERE osm_way_id = 1`;
  });
  afterAll(async () => { await sql.end(); });

  it('dry run reports without deleting', async () => {
    // 999 has no segments in the DB — must not inflate waysWithSegments
    const report = await purgeByWayIds(sql, [1, 2, 999], false);
    expect(report).toMatchObject({ waysWithSegments: 2, segments: 2, claimed: 1, deleted: false });
    expect(report.km).toBeGreaterThan(0.35);
    expect(report.km).toBeLessThan(0.45);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM segments`;
    expect(n).toBe(3);
  });

  it('execute deletes the targeted segments and cascades claims, sparing the rest', async () => {
    const report = await purgeByWayIds(sql, [1, 2, 999], true);
    expect(report.deleted).toBe(true);
    const remaining = await sql`SELECT osm_way_id FROM segments`;
    expect(remaining.map((r) => Number(r.osm_way_id))).toEqual([3]);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM claims`;
    expect(n).toBe(0);
    const [{ rides }] = await sql`SELECT COUNT(*)::int AS rides FROM rides`;
    expect(rides).toBe(1); // rides are never touched
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npx vitest run tests/purge.test.ts`
Expected: FAIL — cannot resolve `@/lib/network/purge`.

- [ ] **Step 3: Implement the core**

Create `lib/network/purge.ts`:

```ts
import type postgres from 'postgres';

/**
 * Tripwire: a real 50 km rural region has thousands of service ways. A list
 * smaller than this means a truncated/failed Overpass response, and executing
 * a purge from it would be meaningless-to-harmful. Refuse loudly.
 */
export const MIN_PLAUSIBLE_IDS = 100;

export function assertPlausibleIdList(ids: number[]): void {
  if (ids.length < MIN_PLAUSIBLE_IDS) {
    throw new Error(
      `implausibly small way-ID list (${ids.length} < ${MIN_PLAUSIBLE_IDS}) — ` +
      `refusing to proceed (truncated Overpass response?)`
    );
  }
}

export type PurgeReport = {
  waysWithSegments: number;
  segments: number;
  km: number;
  claimed: number;
  deleted: boolean;
};

const DELETE_CHUNK = 10_000;

/**
 * Reports (and with execute=true, deletes) all segments whose osm_way_id is
 * in wayIds. Claims cascade via the segments FK; rides are never touched —
 * banked XP survives, Explorer/completion recompute on read.
 */
export async function purgeByWayIds(
  sql: postgres.Sql,
  wayIds: number[],
  execute: boolean
): Promise<PurgeReport> {
  const [pre] = await sql`
    SELECT COUNT(DISTINCT s.osm_way_id)::int AS ways,
           COUNT(*)::int AS segments,
           COALESCE(SUM(s.length_m), 0)::float / 1000 AS km,
           COUNT(c.segment_id)::int AS claimed
    FROM segments s
    LEFT JOIN claims c ON c.segment_id = s.id
    WHERE s.osm_way_id = ANY(${wayIds})`;

  if (execute) {
    for (let i = 0; i < wayIds.length; i += DELETE_CHUNK) {
      const chunk = wayIds.slice(i, i + DELETE_CHUNK);
      await sql`DELETE FROM segments WHERE osm_way_id = ANY(${chunk})`;
    }
  }

  return {
    waysWithSegments: pre.ways,
    segments: pre.segments,
    km: pre.km,
    claimed: pre.claimed,
    deleted: execute,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npx vitest run tests/purge.test.ts`
Expected: 4 passed.

- [ ] **Step 5: The CLI**

Create `scripts/purge-service-roads.ts`:

```ts
import postgres from 'postgres';
import { overpass } from '../lib/network/overpass';
import { REGION } from '../lib/region';
import { purgeByWayIds, assertPlausibleIdList } from '../lib/network/purge';

const execute = process.argv.includes('--execute');

const query = `
[out:json][timeout:300];
way(around:${REGION.radiusM},${REGION.lat},${REGION.lon})["highway"="service"];
out ids;`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const sql = postgres(url, { ssl: url.includes('localhost') ? false : 'require', max: 1 });

  console.log(`Fetching service way IDs within ${REGION.radiusM / 1000} km of ${REGION.lat},${REGION.lon}…`);
  const data = await overpass(query);
  const ids: number[] = (data.elements ?? [])
    .filter((e: { type: string }) => e.type === 'way')
    .map((e: { id: number }) => e.id);
  console.log(`${ids.length} service ways in the region (OSM)`);
  assertPlausibleIdList(ids);

  const report = await purgeByWayIds(sql, ids, execute);
  console.log(`In this database: ${report.segments} segments across ${report.waysWithSegments} ways, ` +
    `${report.km.toFixed(0)} km, ${report.claimed} claimed`);

  if (!execute) {
    console.log('DRY RUN — nothing deleted. Re-run with --execute to purge.');
  } else {
    const [after] = await sql`
      SELECT COUNT(*)::int AS segments, COALESCE(SUM(length_m), 0)::float / 1000 AS km FROM segments`;
    const [comp] = await sql`
      SELECT COALESCE(SUM(s.length_m) FILTER (WHERE c.segment_id IS NOT NULL), 0)
             / NULLIF(SUM(s.length_m), 0) * 100 AS pct
      FROM segments s LEFT JOIN claims c ON c.segment_id = s.id`;
    console.log(`Purged. Board now: ${after.segments} segments, ${after.km.toFixed(0)} km; ` +
      `completion ${Number(comp.pct ?? 0).toFixed(2)}%`);
  }
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Add to `package.json` scripts:

```json
"purge:service": "tsx --env-file=.env.local scripts/purge-service-roads.ts"
```

- [ ] **Step 6: Full gate**

`TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npx vitest run` → 78 passed; plain `npx vitest run` skips DB suites; `npx tsc --noEmit` clean; `npm run build` clean. Do NOT run the CLI against any database in this task — that's Task 3, after review and merge.

- [ ] **Step 7: Commit**

```bash
git add lib/network/purge.ts scripts/purge-service-roads.ts tests/purge.test.ts package.json
git commit -m "feat: service-road purge script — dry-run by default, tripwired, chunked"
```

---

### Task 3: Rollout (operational — after final review + merge to main)

**Files:**
- Modify: `README.md` (board-size numbers), memory/ledger.

**Interfaces:**
- Consumes: merged main; `npm run purge:service`; Neon production `DATABASE_URL`.

- [ ] **Step 1: Local dry run** — `npm run purge:service`; review counts (expect thousands of ways, four-digit segment count or more, small claimed count).
- [ ] **Step 2: Local execute** — `npm run purge:service -- --execute`; then `npm run dev` and eyeball the map: driveway fuzz gone, real roads intact, completion % ticked up.
- [ ] **Step 3: Production dry run** — `DATABASE_URL='<neon-pooled-url>' npx tsx --env-file=.env.local scripts/purge-service-roads.ts`; compare numbers to local (should be near-identical).
- [ ] **Step 4: Production execute** — same command with `--execute`. Verify `https://gravel-atlas-two.vercel.app` map + stats afterward.
- [ ] **Step 5: Update README** — replace the "~82k segments, 15,500 km" board description with the post-purge numbers; commit "docs: board size after service-road purge".
- [ ] **Step 6: Ledger + memory** — record completion and the new board numbers.
