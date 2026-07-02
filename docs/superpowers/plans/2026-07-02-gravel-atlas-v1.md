# Gravel Atlas v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-user web app that imports Strava rides, paints ridden road segments on a map of the 50 km region around Reblino, and feeds an RPG character sheet (XP, levels, titles, four stats).

**Architecture:** Next.js (App Router) on Vercel + Neon Postgres with PostGIS. A one-time importer loads the OSM road network as segments. A sync endpoint pulls Strava activities and a PostGIS matching engine claims segments covered by each ride's GPS track. Screens read from Postgres.

**Tech Stack:** Next.js 15+ (TypeScript, App Router, no Tailwind), `postgres` (porsager) client, PostGIS (SRID 2180 for meter math), MapLibre GL, `osmtogeojson`, Vitest, `tsx` for scripts, Docker (local PostGIS only).

**Spec:** `docs/superpowers/specs/2026-07-02-gravel-atlas-design.md`

## Global Constraints

- Single user; every page except `/login` is behind the app-lock middleware.
- UI language: English.
- Matching thresholds (from spec, tunable constants in `lib/config.ts`): buffer **20 m**, coverage **≥ 0.7** of segment length.
- XP economy: **1 XP per km ridden**, **8 XP per km of newly claimed segment length** (exploration pays ~8×).
- Claims are first-ride-only (`claims.segment_id` is the primary key).
- All imports idempotent, keyed on `strava_activity_id` / `(osm_way_id, part_index)`.
- Completion % is by segment **length**, not count.
- Meters math in EPSG:2180 (`geom_m` columns); display/GeoJSON in EPSG:4326 (`geom`).
- Free tiers only: Vercel Hobby, Neon Free, OSM/Overpass, free Strava API app.
- DB access only from Node runtime (API routes, server components, scripts) — never from edge middleware.
- Integration tests require `TEST_DATABASE_URL`; when unset they must skip, not fail.

## File Structure

```
gravel-atlas/
├── app/
│   ├── layout.tsx                    # nav shell + SyncButton
│   ├── page.tsx                      # Map screen (home)
│   ├── character/page.tsx            # Character sheet
│   ├── rides/page.tsx                # Ride log
│   ├── login/page.tsx                # App-lock login form
│   └── api/
│       ├── login/route.ts            # POST password → cookie
│       ├── segments/route.ts         # GET GeoJSON of all segments
│       ├── stats/route.ts            # GET completion + character stats
│       ├── sync/route.ts             # POST import next batch of rides
│       └── strava/
│           ├── connect/route.ts      # GET → redirect to Strava OAuth
│           └── callback/route.ts     # GET OAuth code → save tokens
├── components/
│   ├── Radar.tsx                     # 4-axis SVG spider chart
│   └── SyncButton.tsx                # client loop over /api/sync
├── lib/
│   ├── config.ts                     # BUFFER_M, COVERAGE_MIN, XP constants
│   ├── region.ts                     # Reblino center + radius
│   ├── db.ts                         # postgres client singleton
│   ├── migrate.ts                    # runMigrations(sql)
│   ├── game.ts                       # XP, levels, titles
│   ├── matching.ts                   # matchRide() — the heart
│   ├── stats.ts                      # getStats() aggregate queries
│   ├── strava.ts                     # OAuth, tokens, API fetchers
│   ├── sync.ts                       # latlngToLineString, isImportable
│   └── network/
│       ├── split.ts                  # splitWays() OSM ways → segments
│       ├── surface.ts                # classifySurface()
│       └── load.ts                   # loadSegments() bulk insert
├── migrations/001_init.sql
├── scripts/
│   ├── migrate.ts                    # npm run migrate
│   └── import-network.ts             # npm run import:network
├── tests/
│   ├── helpers/db.ts                 # test DB connect/reset/fixtures
│   ├── game.test.ts
│   ├── split.test.ts
│   ├── surface.test.ts
│   ├── load.test.ts                  # integration (needs PostGIS)
│   ├── matching.test.ts              # integration (needs PostGIS)
│   ├── strava.test.ts                # mocked fetch
│   └── sync.test.ts
├── types/osmtogeojson.d.ts
├── middleware.ts                     # app lock
├── docker-compose.yml                # local PostGIS for dev + tests
├── vitest.config.ts
└── .env.example
```

---

### Task 1: Scaffold, database, migrations

**Files:**
- Create: Next.js scaffold (via `create-next-app`), `docker-compose.yml`, `.env.example`, `.env.local`, `migrations/001_init.sql`, `lib/db.ts`, `lib/migrate.ts`, `lib/config.ts`, `lib/region.ts`, `scripts/migrate.ts`, `vitest.config.ts`, `tests/helpers/db.ts`, `tests/migrate.test.ts`, `types/osmtogeojson.d.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `sql` default export from `lib/db.ts` (`postgres.Sql`); `runMigrations(sql: postgres.Sql): Promise<void>` from `lib/migrate.ts`; `BUFFER_M`, `COVERAGE_MIN`, `XP_PER_RIDE_KM`, `XP_PER_NEW_SEGMENT_KM` from `lib/config.ts`; `REGION: { lat: number; lon: number; radiusM: number }` from `lib/region.ts`; `testDb()`, `resetDb(sql)` from `tests/helpers/db.ts`; the full DB schema.

- [ ] **Step 1: Scaffold Next.js in the repo root**

Run (repo root `~/gravel-atlas`; `docs/` and `.git` are on create-next-app's allowlist, so scaffolding in place works):

```bash
npx create-next-app@latest . --typescript --app --eslint --no-tailwind --no-src-dir --import-alias "@/*" --use-npm
npm install postgres maplibre-gl osmtogeojson
npm install -D vitest tsx
```

- [ ] **Step 2: Verify Reblino coordinates**

Run:

```bash
curl -s 'https://nominatim.openstreetmap.org/search?q=Reblino,+gmina+Kobylnica,+Poland&format=json&limit=1' -H 'User-Agent: gravel-atlas-setup'
```

Expected: JSON with `lat`/`lon` around 54.4/16.9. Copy the exact values — they go into `.env.example`/`.env.local` in Step 4 as `NEXT_PUBLIC_REGION_LAT`/`NEXT_PUBLIC_REGION_LON`. If Nominatim returns nothing, retry with `q=Reblino,+pomorskie`.

- [ ] **Step 3: Local PostGIS via Docker**

Create `docker-compose.yml`:

```yaml
services:
  db:
    image: postgis/postgis:16-3.4
    ports:
      - "5432:5432"
    environment:
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: gravel
```

Run:

```bash
docker compose up -d
sleep 5
docker compose exec db createdb -U postgres gravel_test
```

Expected: both `gravel` and `gravel_test` databases exist (`docker compose exec db psql -U postgres -l` lists them).

- [ ] **Step 4: Environment files**

Create `.env.example` (commit this) and `.env.local` (gitignored by the scaffold; same content, with the real coordinates from Step 2 and a real password):

```bash
DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel
TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test
APP_PASSWORD=change-me
APP_URL=http://localhost:3000
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
NEXT_PUBLIC_REGION_LAT=54.41
NEXT_PUBLIC_REGION_LON=16.86
REGION_RADIUS_M=50000
```

- [ ] **Step 5: Schema migration**

Create `migrations/001_init.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE segments (
  id            BIGSERIAL PRIMARY KEY,
  osm_way_id    BIGINT NOT NULL,
  part_index    INT NOT NULL,
  name          TEXT,
  surface_class TEXT NOT NULL CHECK (surface_class IN ('paved', 'unpaved', 'unknown')),
  gmina         TEXT,
  length_m      DOUBLE PRECISION NOT NULL,
  geom          geometry(LineString, 4326) NOT NULL,
  geom_m        geometry(LineString, 2180) NOT NULL,
  UNIQUE (osm_way_id, part_index)
);
CREATE INDEX segments_geom_idx ON segments USING GIST (geom);
CREATE INDEX segments_geom_m_idx ON segments USING GIST (geom_m);

CREATE TABLE gminas (
  name TEXT PRIMARY KEY,
  geom geometry(MultiPolygon, 4326) NOT NULL
);

CREATE TABLE rides (
  id                 BIGSERIAL PRIMARY KEY,
  strava_activity_id BIGINT UNIQUE NOT NULL,
  name               TEXT NOT NULL,
  started_at         TIMESTAMPTZ NOT NULL,
  distance_m         DOUBLE PRECISION NOT NULL,
  elevation_m        DOUBLE PRECISION NOT NULL DEFAULT 0,
  unpaved_m          DOUBLE PRECISION NOT NULL DEFAULT 0,
  new_segments       INT NOT NULL DEFAULT 0,
  xp                 INT NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'imported'
                     CHECK (status IN ('imported', 'skipped_no_gps', 'failed')),
  track              geometry(LineString, 4326)
);

CREATE TABLE claims (
  segment_id BIGINT PRIMARY KEY REFERENCES segments(id) ON DELETE CASCADE,
  ride_id    BIGINT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE strava_tokens (
  id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL
);
```

`claims.segment_id` as PK is what makes claims first-ride-only; `ON CONFLICT DO NOTHING` on it is the idempotency mechanism.

- [ ] **Step 6: DB client, config, region, migration runner**

Create `lib/db.ts`:

```ts
import postgres from 'postgres';

const globalForDb = globalThis as unknown as { sql?: postgres.Sql };

const sql =
  globalForDb.sql ??
  postgres(process.env.DATABASE_URL!, {
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : 'require',
    max: process.env.NODE_ENV === 'production' ? 1 : 10,
  });

if (process.env.NODE_ENV !== 'production') globalForDb.sql = sql;

export default sql;
```

Create `lib/config.ts`:

```ts
export const BUFFER_M = 20;
export const COVERAGE_MIN = 0.7;
export const XP_PER_RIDE_KM = 1;
export const XP_PER_NEW_SEGMENT_KM = 8;
```

Create `lib/region.ts`:

```ts
export const REGION = {
  lat: Number(process.env.NEXT_PUBLIC_REGION_LAT ?? 54.41),
  lon: Number(process.env.NEXT_PUBLIC_REGION_LON ?? 16.86),
  radiusM: Number(process.env.REGION_RADIUS_M ?? 50000),
};
```

Create `lib/migrate.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import type postgres from 'postgres';

export async function runMigrations(sql: postgres.Sql) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)`;
  const dir = path.join(process.cwd(), 'migrations');
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const done = await sql`SELECT 1 FROM schema_migrations WHERE name = ${file}`;
    if (done.length) continue;
    await sql.unsafe(fs.readFileSync(path.join(dir, file), 'utf8'));
    await sql`INSERT INTO schema_migrations (name) VALUES (${file})`;
    console.log(`applied ${file}`);
  }
}
```

Create `scripts/migrate.ts`:

```ts
import postgres from 'postgres';
import { runMigrations } from '../lib/migrate';

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL not set');
const sql = postgres(url, { ssl: url.includes('localhost') ? false : 'require', max: 1 });

runMigrations(sql).then(
  async () => { console.log('migrations up to date'); await sql.end(); },
  async (e) => { console.error(e); await sql.end(); process.exit(1); }
);
```

Create `types/osmtogeojson.d.ts`:

```ts
declare module 'osmtogeojson';
```

Add to `package.json` scripts:

```json
"migrate": "tsx --env-file=.env.local scripts/migrate.ts",
"import:network": "tsx --env-file=.env.local scripts/import-network.ts",
"test": "vitest run"
```

- [ ] **Step 7: Vitest config and test DB helper**

Create `vitest.config.ts`:

```ts
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname) } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
```

Create `tests/helpers/db.ts`:

```ts
import postgres from 'postgres';
import { runMigrations } from '@/lib/migrate';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;

export function testDb(): postgres.Sql {
  if (!TEST_DB_URL) throw new Error('TEST_DATABASE_URL not set');
  return postgres(TEST_DB_URL, { ssl: false, max: 2, onnotice: () => {} });
}

export async function resetDb(sql: postgres.Sql) {
  await runMigrations(sql);
  await sql`TRUNCATE claims, rides, segments, gminas RESTART IDENTITY CASCADE`;
}

/** Insert a segment from WKT; geometry math (geom_m, length_m) done in SQL. */
export async function insertSegment(
  sql: postgres.Sql,
  opts: { wayId: number; part?: number; wkt: string; surface?: string; name?: string }
) {
  await sql`
    INSERT INTO segments (osm_way_id, part_index, name, surface_class, geom, geom_m, length_m)
    SELECT ${opts.wayId}, ${opts.part ?? 0}, ${opts.name ?? null}, ${opts.surface ?? 'unpaved'},
           g, ST_Transform(g, 2180), ST_Length(ST_Transform(g, 2180))
    FROM (SELECT ST_SetSRID(ST_GeomFromText(${opts.wkt}), 4326) AS g) t`;
}

export async function insertRide(
  sql: postgres.Sql,
  opts: { stravaId: number; name?: string; startedAt?: string; distanceM?: number }
): Promise<number> {
  const [row] = await sql`
    INSERT INTO rides (strava_activity_id, name, started_at, distance_m)
    VALUES (${opts.stravaId}, ${opts.name ?? 'test ride'},
            ${opts.startedAt ?? '2026-07-01T10:00:00Z'}, ${opts.distanceM ?? 10000})
    RETURNING id`;
  return row.id;
}
```

- [ ] **Step 8: Write the failing smoke test**

Create `tests/migrate.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, resetDb, TEST_DB_URL } from './helpers/db';

const d = TEST_DB_URL ? describe : describe.skip;

d('migrations', () => {
  const sql = testDb();
  beforeAll(async () => { await resetDb(sql); });
  afterAll(async () => { await sql.end(); });

  it('creates all core tables', async () => {
    const rows = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN
        ('segments', 'gminas', 'rides', 'claims', 'strava_tokens')`;
    expect(rows.length).toBe(5);
  });

  it('enables PostGIS', async () => {
    const [row] = await sql`SELECT PostGIS_Version() AS v`;
    expect(row.v).toBeTruthy();
  });

  it('is idempotent (second run is a no-op)', async () => {
    await resetDb(sql);
    const [row] = await sql`SELECT COUNT(*)::int AS n FROM schema_migrations`;
    expect(row.n).toBe(1);
  });
});
```

- [ ] **Step 9: Run test to verify it fails, then passes**

Run: `TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npx vitest run tests/migrate.test.ts`

First run may fail if any file has a typo — fix until: 3 passed. Also run `npm run migrate` against the dev DB — expected output: `applied 001_init.sql` then `migrations up to date`.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: scaffold Next.js app with PostGIS schema and migrations"
```

---

### Task 2: Network processing library (way splitting + surface classification)

**Files:**
- Create: `lib/network/surface.ts`, `lib/network/split.ts`
- Test: `tests/surface.test.ts`, `tests/split.test.ts`

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces:
  - `classifySurface(tags: Record<string, string>): 'paved' | 'unpaved' | 'unknown'`
  - Types `OsmNode { id: number; lat: number; lon: number }`, `OsmWay { id: number; nodes: number[]; tags: Record<string, string> }`, `Segment { osmWayId: number; partIndex: number; name: string | null; surfaceClass: 'paved' | 'unpaved' | 'unknown'; coords: [number, number][] }` (coords are `[lon, lat]`)
  - `splitWays(ways: OsmWay[], nodes: Map<number, OsmNode>): Segment[]`
  - `toWkt(coords: [number, number][]): string`

- [ ] **Step 1: Write failing surface tests**

Create `tests/surface.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifySurface } from '@/lib/network/surface';

describe('classifySurface', () => {
  it('uses the surface tag when present', () => {
    expect(classifySurface({ surface: 'asphalt' })).toBe('paved');
    expect(classifySurface({ surface: 'gravel' })).toBe('unpaved');
    expect(classifySurface({ surface: 'compacted' })).toBe('unpaved');
  });

  it('falls back to highway type when surface is missing', () => {
    expect(classifySurface({ highway: 'track' })).toBe('unpaved');
    expect(classifySurface({ highway: 'path' })).toBe('unpaved');
    expect(classifySurface({ highway: 'residential' })).toBe('paved');
    expect(classifySurface({ highway: 'tertiary' })).toBe('paved');
  });

  it('surface tag beats highway fallback', () => {
    expect(classifySurface({ highway: 'track', surface: 'asphalt' })).toBe('paved');
  });

  it('returns unknown when neither helps', () => {
    expect(classifySurface({ highway: 'service' })).toBe('unknown');
    expect(classifySurface({ highway: 'unclassified' })).toBe('unknown');
    expect(classifySurface({ surface: 'metal' })).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/surface.test.ts`
Expected: FAIL — cannot resolve `@/lib/network/surface`.

- [ ] **Step 3: Implement classifier**

Create `lib/network/surface.ts`:

```ts
const PAVED = new Set([
  'asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes',
  'paving_stones', 'sett',
]);
const UNPAVED = new Set([
  'gravel', 'fine_gravel', 'compacted', 'unpaved', 'dirt', 'ground',
  'earth', 'sand', 'grass', 'mud', 'pebblestone', 'wood',
]);
const PAVED_HIGHWAYS = new Set([
  'residential', 'tertiary', 'secondary', 'living_street', 'cycleway',
]);
const UNPAVED_HIGHWAYS = new Set(['track', 'path', 'bridleway']);

export function classifySurface(tags: Record<string, string>): 'paved' | 'unpaved' | 'unknown' {
  const s = tags.surface;
  if (s) {
    if (PAVED.has(s)) return 'paved';
    if (UNPAVED.has(s)) return 'unpaved';
    return 'unknown';
  }
  const h = tags.highway ?? '';
  if (UNPAVED_HIGHWAYS.has(h)) return 'unpaved';
  if (PAVED_HIGHWAYS.has(h)) return 'paved';
  return 'unknown';
}
```

- [ ] **Step 4: Run surface tests to verify pass**

Run: `npx vitest run tests/surface.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Write failing splitter tests**

Create `tests/split.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { splitWays, toWkt, type OsmNode, type OsmWay } from '@/lib/network/split';

function nodeMap(...nodes: [number, number, number][]): Map<number, OsmNode> {
  return new Map(nodes.map(([id, lon, lat]) => [id, { id, lat, lon }]));
}

describe('splitWays', () => {
  it('keeps a way with no shared nodes as one segment', () => {
    const nodes = nodeMap([1, 16.90, 54.40], [2, 16.91, 54.40], [3, 16.92, 54.40]);
    const ways: OsmWay[] = [{ id: 100, nodes: [1, 2, 3], tags: { highway: 'track' } }];
    const segs = splitWays(ways, nodes);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ osmWayId: 100, partIndex: 0, surfaceClass: 'unpaved' });
    expect(segs[0].coords).toEqual([[16.90, 54.40], [16.91, 54.40], [16.92, 54.40]]);
  });

  it('splits a way at a node shared with another way', () => {
    const nodes = nodeMap(
      [1, 16.90, 54.40], [2, 16.91, 54.40], [3, 16.92, 54.40],
      [4, 16.91, 54.41],
    );
    const ways: OsmWay[] = [
      { id: 100, nodes: [1, 2, 3], tags: { highway: 'track', name: 'A' } },
      { id: 200, nodes: [4, 2], tags: { highway: 'track' } },
    ];
    const segs = splitWays(ways, nodes);
    const partsOf100 = segs.filter((s) => s.osmWayId === 100);
    expect(partsOf100).toHaveLength(2);
    expect(partsOf100[0].coords).toEqual([[16.90, 54.40], [16.91, 54.40]]);
    expect(partsOf100[1].coords).toEqual([[16.91, 54.40], [16.92, 54.40]]);
    expect(partsOf100.map((s) => s.partIndex)).toEqual([0, 1]);
    expect(partsOf100[0].name).toBe('A');
    expect(segs.filter((s) => s.osmWayId === 200)).toHaveLength(1);
  });

  it('drops references to missing nodes and skips degenerate pieces', () => {
    const nodes = nodeMap([1, 16.90, 54.40], [3, 16.92, 54.40]);
    const ways: OsmWay[] = [{ id: 100, nodes: [1, 2, 3], tags: { highway: 'track' } }];
    const segs = splitWays(ways, nodes);
    expect(segs).toHaveLength(1);
    expect(segs[0].coords).toEqual([[16.90, 54.40], [16.92, 54.40]]);
  });
});

describe('toWkt', () => {
  it('formats lon lat pairs', () => {
    expect(toWkt([[16.90, 54.40], [16.91, 54.41]]))
      .toBe('LINESTRING(16.9 54.4, 16.91 54.41)');
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run tests/split.test.ts`
Expected: FAIL — cannot resolve `@/lib/network/split`.

- [ ] **Step 7: Implement splitter**

Create `lib/network/split.ts`:

```ts
import { classifySurface } from './surface';

export type OsmNode = { id: number; lat: number; lon: number };
export type OsmWay = { id: number; nodes: number[]; tags: Record<string, string> };
export type Segment = {
  osmWayId: number;
  partIndex: number;
  name: string | null;
  surfaceClass: 'paved' | 'unpaved' | 'unknown';
  coords: [number, number][]; // [lon, lat]
};

/** Split ways into segments at intersection nodes (nodes used by >1 way). */
export function splitWays(ways: OsmWay[], nodes: Map<number, OsmNode>): Segment[] {
  const usage = new Map<number, number>();
  for (const way of ways) {
    for (const n of new Set(way.nodes)) usage.set(n, (usage.get(n) ?? 0) + 1);
  }

  const segments: Segment[] = [];
  for (const way of ways) {
    let partIndex = 0;
    let current: number[] = [way.nodes[0]];
    for (let i = 1; i < way.nodes.length; i++) {
      current.push(way.nodes[i]);
      const isLast = i === way.nodes.length - 1;
      const isIntersection = (usage.get(way.nodes[i]) ?? 0) >= 2;
      if (!isLast && !isIntersection) continue;

      const coords = current
        .map((id) => nodes.get(id))
        .filter((n): n is OsmNode => n !== undefined)
        .map((n) => [n.lon, n.lat] as [number, number]);
      if (coords.length >= 2) {
        segments.push({
          osmWayId: way.id,
          partIndex: partIndex++,
          name: way.tags.name ?? null,
          surfaceClass: classifySurface(way.tags),
          coords,
        });
      }
      current = [way.nodes[i]];
    }
  }
  return segments;
}

export function toWkt(coords: [number, number][]): string {
  return `LINESTRING(${coords.map(([lon, lat]) => `${lon} ${lat}`).join(', ')})`;
}
```

- [ ] **Step 8: Run all unit tests to verify pass**

Run: `npx vitest run tests/split.test.ts tests/surface.test.ts`
Expected: all passed.

- [ ] **Step 9: Commit**

```bash
git add lib/network tests/surface.test.ts tests/split.test.ts
git commit -m "feat: OSM way splitting and surface classification"
```

---

### Task 3: Road network importer

**Files:**
- Create: `lib/network/load.ts`, `scripts/import-network.ts`
- Test: `tests/load.test.ts`

**Interfaces:**
- Consumes: `splitWays`, `toWkt`, `Segment` from `lib/network/split`; `REGION` from `lib/region`; `runMigrations` pattern for DB access via own `postgres()` connection.
- Produces: `loadSegments(sql: postgres.Sql, segments: Segment[]): Promise<void>` (bulk idempotent insert; computes `geom_m` and `length_m` in SQL); `npm run import:network` populates `segments` + `gminas` and assigns `segments.gmina`.

- [ ] **Step 1: Write failing loader test**

Create `tests/load.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, resetDb, TEST_DB_URL } from './helpers/db';
import { loadSegments } from '@/lib/network/load';
import type { Segment } from '@/lib/network/split';

const d = TEST_DB_URL ? describe : describe.skip;

// ~200 m west-east line at lat 54.40 (1° lon ≈ 64.8 km here)
const SEG: Segment = {
  osmWayId: 100,
  partIndex: 0,
  name: 'Test Track',
  surfaceClass: 'unpaved',
  coords: [[16.900000, 54.400000], [16.903086, 54.400000]],
};

d('loadSegments', () => {
  const sql = testDb();
  beforeAll(async () => { await resetDb(sql); });
  afterAll(async () => { await sql.end(); });

  it('inserts segments with SQL-computed length', async () => {
    await loadSegments(sql, [SEG]);
    const [row] = await sql`
      SELECT name, surface_class, length_m FROM segments
      WHERE osm_way_id = 100 AND part_index = 0`;
    expect(row.name).toBe('Test Track');
    expect(row.surface_class).toBe('unpaved');
    expect(row.length_m).toBeGreaterThan(190);
    expect(row.length_m).toBeLessThan(210);
  });

  it('is idempotent on (osm_way_id, part_index)', async () => {
    await loadSegments(sql, [SEG]);
    const [row] = await sql`SELECT COUNT(*)::int AS n FROM segments`;
    expect(row.n).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npx vitest run tests/load.test.ts`
Expected: FAIL — cannot resolve `@/lib/network/load`.

- [ ] **Step 3: Implement loader**

Create `lib/network/load.ts`:

```ts
import type postgres from 'postgres';
import { toWkt, type Segment } from './split';

const CHUNK = 1000;

export async function loadSegments(sql: postgres.Sql, segments: Segment[]) {
  for (let i = 0; i < segments.length; i += CHUNK) {
    const chunk = segments.slice(i, i + CHUNK);
    await sql`
      INSERT INTO segments (osm_way_id, part_index, name, surface_class, geom, geom_m, length_m)
      SELECT t.way_id, t.part_index, t.name, t.surface_class,
             g.geom, ST_Transform(g.geom, 2180), ST_Length(ST_Transform(g.geom, 2180))
      FROM UNNEST(
        ${chunk.map((s) => s.osmWayId)}::bigint[],
        ${chunk.map((s) => s.partIndex)}::int[],
        ${chunk.map((s) => s.name)}::text[],
        ${chunk.map((s) => s.surfaceClass)}::text[],
        ${chunk.map((s) => toWkt(s.coords))}::text[]
      ) AS t(way_id, part_index, name, surface_class, wkt)
      CROSS JOIN LATERAL (SELECT ST_SetSRID(ST_GeomFromText(t.wkt), 4326) AS geom) g
      ON CONFLICT (osm_way_id, part_index) DO NOTHING`;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npx vitest run tests/load.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Implement the import script**

Create `scripts/import-network.ts`:

```ts
import postgres from 'postgres';
import osmtogeojson from 'osmtogeojson';
import { REGION } from '../lib/region';
import { splitWays, type OsmNode, type OsmWay } from '../lib/network/split';
import { loadSegments } from '../lib/network/load';

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const HIGHWAYS =
  'track|path|bridleway|unclassified|tertiary|secondary|residential|service|cycleway|living_street';

const roadsQuery = `
[out:json][timeout:300];
way(around:${REGION.radiusM},${REGION.lat},${REGION.lon})
  ["highway"~"^(${HIGHWAYS})$"]
  ["access"!~"^(private|no)$"]
  ["bicycle"!~"^(no|private)$"];
(._;>;);
out body;`;

const gminasQuery = `
[out:json][timeout:300];
relation["boundary"="administrative"]["admin_level"="7"]
  (around:${REGION.radiusM},${REGION.lat},${REGION.lon});
out body geom;`;

async function overpass(query: string): Promise<any> {
  let lastError: unknown;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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

async function main() {
  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, { ssl: url.includes('localhost') ? false : 'require', max: 1 });

  console.log(`Fetching roads within ${REGION.radiusM / 1000} km of ${REGION.lat},${REGION.lon}…`);
  const roads = await overpass(roadsQuery);
  const nodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  for (const el of roads.elements) {
    if (el.type === 'node') nodes.set(el.id, { id: el.id, lat: el.lat, lon: el.lon });
    else if (el.type === 'way') ways.push({ id: el.id, nodes: el.nodes, tags: el.tags ?? {} });
  }
  const segments = splitWays(ways, nodes);
  console.log(`${ways.length} ways → ${segments.length} segments; loading…`);
  await loadSegments(sql, segments);
  await sql`DELETE FROM segments
            WHERE length_m < 5 AND id NOT IN (SELECT segment_id FROM claims)`;

  console.log('Fetching gmina boundaries…');
  const gj = osmtogeojson(await overpass(gminasQuery));
  for (const f of gj.features) {
    const name = f.properties?.name;
    const geomType = f.geometry?.type;
    if (!name || (geomType !== 'Polygon' && geomType !== 'MultiPolygon')) continue;
    await sql`
      INSERT INTO gminas (name, geom)
      VALUES (${name}, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(f.geometry)}), 4326)))
      ON CONFLICT (name) DO UPDATE SET geom = EXCLUDED.geom`;
  }
  await sql`
    UPDATE segments s SET gmina = g.name
    FROM gminas g
    WHERE ST_Intersects(g.geom, ST_LineInterpolatePoint(s.geom, 0.5))`;

  // Sanity checks
  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM segments`;
  if (n < 500) console.warn(`⚠️ only ${n} segments — check region/query`);
  if (n > 100000) console.warn(`⚠️ ${n} segments — suspiciously many`);
  const surfaces = await sql`
    SELECT surface_class, COUNT(*)::int AS segments, ROUND(SUM(length_m) / 1000)::int AS km
    FROM segments GROUP BY 1 ORDER BY 1`;
  console.table(surfaces.map((r) => ({ ...r })));
  const gminas = await sql`
    SELECT COALESCE(gmina, '(none)') AS gmina, COUNT(*)::int AS segments
    FROM segments GROUP BY 1 ORDER BY 2 DESC`;
  console.table(gminas.map((r) => ({ ...r })));
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Re-runs are safe: segment inserts are `ON CONFLICT DO NOTHING` (claims survive), gminas upsert. Geometry *refresh* of changed OSM ways is out of scope for v1 — documented limitation.

- [ ] **Step 6: Run the importer for real**

Run: `npm run migrate && npm run import:network`
Expected: a few minutes; final tables show a few thousand–~30k segments, plausible unpaved share (rural Pomerania: expect unpaved km ≥ paved km), and gminas including Kobylnica / Słupsk / Sławno. If Overpass times out, re-run (it resumes safely).

- [ ] **Step 7: Commit**

```bash
git add lib/network/load.ts scripts/import-network.ts tests/load.test.ts
git commit -m "feat: OSM road network importer with gmina assignment"
```

---

### Task 4: Game math (XP, levels, titles)

**Files:**
- Create: `lib/game.ts`
- Test: `tests/game.test.ts`

**Interfaces:**
- Consumes: `XP_PER_RIDE_KM`, `XP_PER_NEW_SEGMENT_KM` from `lib/config`.
- Produces:
  - `rideXp(distanceM: number, newSegmentM: number): number`
  - `levelForXp(xp: number): number` — level 1 at 0 XP, level n at `(n-1)² × 100` XP
  - `xpForLevel(level: number): number` — inverse threshold
  - `titleForLevel(level: number): string`
  - `sat(value: number, k: number): number` — saturation normalizer `value / (value + k)` for radar axes

- [ ] **Step 1: Write failing tests**

Create `tests/game.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rideXp, levelForXp, xpForLevel, titleForLevel, sat } from '@/lib/game';

describe('rideXp', () => {
  it('pays 1 XP per km ridden', () => expect(rideXp(30000, 0)).toBe(30));
  it('pays 8 XP per new-segment km on top', () => expect(rideXp(30000, 5000)).toBe(70));
  it('rounds to nearest integer', () => expect(rideXp(1400, 0)).toBe(1));
  it('never returns negative', () => expect(rideXp(0, 0)).toBe(0));
});

describe('levels', () => {
  it('starts at level 1 with 0 XP', () => expect(levelForXp(0)).toBe(1));
  it('reaches level 2 at exactly 100 XP', () => {
    expect(levelForXp(99)).toBe(1);
    expect(levelForXp(100)).toBe(2);
  });
  it('reaches level 3 at 400 XP', () => expect(levelForXp(400)).toBe(3));
  it('xpForLevel gives the threshold levelForXp uses', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(3)).toBe(400);
    expect(levelForXp(xpForLevel(5))).toBe(5);
  });
});

describe('titleForLevel', () => {
  it('gives the starting title at level 1', () => expect(titleForLevel(1)).toBe('Fresh Legs'));
  it('gives the highest earned title', () => expect(titleForLevel(13)).toBe('Forest Track Regular'));
  it('caps at the last title', () => expect(titleForLevel(99)).toBe('Master of the Grey Roads'));
});

describe('sat', () => {
  it('is 0 at 0', () => expect(sat(0, 100)).toBe(0));
  it('is 0.5 at k', () => expect(sat(100, 100)).toBe(0.5));
  it('approaches 1', () => expect(sat(10000, 100)).toBeGreaterThan(0.98));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/game.test.ts`
Expected: FAIL — cannot resolve `@/lib/game`.

- [ ] **Step 3: Implement**

Create `lib/game.ts`:

```ts
import { XP_PER_RIDE_KM, XP_PER_NEW_SEGMENT_KM } from './config';

export function rideXp(distanceM: number, newSegmentM: number): number {
  return Math.round(
    (distanceM / 1000) * XP_PER_RIDE_KM + (newSegmentM / 1000) * XP_PER_NEW_SEGMENT_KM
  );
}

export function levelForXp(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
}

export function xpForLevel(level: number): number {
  return (level - 1) ** 2 * 100;
}

export const TITLES: [number, string][] = [
  [1, 'Fresh Legs'],
  [3, 'Wanderer of Reblino'],
  [6, 'Gravel Apprentice'],
  [9, 'Słupia Valley Scout'],
  [12, 'Forest Track Regular'],
  [16, 'Baltic Wind Rider'],
  [20, 'Pomeranian Pathfinder'],
  [26, 'Master of the Grey Roads'],
];

export function titleForLevel(level: number): string {
  let title = TITLES[0][1];
  for (const [minLevel, t] of TITLES) {
    if (level >= minLevel) title = t;
  }
  return title;
}

/** Saturation curve for radar axes: 0 → 0, k → 0.5, ∞ → 1. */
export function sat(value: number, k: number): number {
  return value / (value + k);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/game.test.ts`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add lib/game.ts tests/game.test.ts
git commit -m "feat: XP economy, level curve, and titles"
```

---

### Task 5: Matching engine (the heart)

**Files:**
- Create: `lib/matching.ts`
- Test: `tests/matching.test.ts`

**Interfaces:**
- Consumes: `BUFFER_M`, `COVERAGE_MIN` from `lib/config`; schema from Task 1; test helpers `insertSegment`, `insertRide` from `tests/helpers/db`.
- Produces: `matchRide(sql: postgres.Sql, rideId: number, trackGeoJson: string, claimedAt: Date): Promise<{ newCount: number; newLenM: number; unpavedM: number }>` — `trackGeoJson` is a stringified GeoJSON LineString in `[lon, lat]` order. Inserts `claims` rows (first-ride-only); never updates `rides` (caller's job).

- [ ] **Step 1: Write failing tests**

Fixture geometry (lat 54.40: 1° lon ≈ 64,800 m, 1° lat ≈ 111,200 m):
- Segment A: 200 m along the track — should claim (coverage ≈ 100%).
- Segment B: 200 m side road leaving the track at A's midpoint — only ~20 m falls in the buffer (≈10%) — must NOT claim.
- Segment C: 200 m parallel road ~111 m north, track covers only its first half (≈60% incl. buffer caps) — must NOT claim (below 0.7).

Create `tests/matching.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, insertSegment, insertRide, TEST_DB_URL } from './helpers/db';
import { matchRide } from '@/lib/matching';

const d = TEST_DB_URL ? describe : describe.skip;

const LAT = 54.4;
const LON0 = 16.9;
const M200_LON = 0.003086; // ≈200 m of longitude at this latitude
const M200_LAT = 0.0017986; // ≈200 m of latitude
const CLAIMED_AT = new Date('2026-07-01T10:00:00Z');

function track(points: [number, number][]): string {
  return JSON.stringify({ type: 'LineString', coordinates: points });
}

/** N evenly spaced points from [lon,lat] a to b inclusive. */
function line(a: [number, number], b: [number, number], n = 11): [number, number][] {
  return Array.from({ length: n }, (_, i) => [
    a[0] + ((b[0] - a[0]) * i) / (n - 1),
    a[1] + ((b[1] - a[1]) * i) / (n - 1),
  ]);
}

d('matchRide', () => {
  const sql = testDb();
  beforeEach(async () => {
    await resetDb(sql);
    await insertSegment(sql, { wayId: 1, wkt: `LINESTRING(${LON0} ${LAT}, ${LON0 + M200_LON} ${LAT})`, surface: 'unpaved' }); // A
    await insertSegment(sql, { wayId: 2, wkt: `LINESTRING(${LON0 + M200_LON / 2} ${LAT}, ${LON0 + M200_LON / 2} ${LAT + M200_LAT})`, surface: 'paved' }); // B
    await insertSegment(sql, { wayId: 3, wkt: `LINESTRING(${LON0} ${LAT + 0.001} , ${LON0 + M200_LON} ${LAT + 0.001})`, surface: 'unpaved' }); // C, ~111 m north
  });
  afterAll(async () => { await sql.end(); });

  it('claims a fully covered segment, not the side road or a half-covered one', async () => {
    const rideId = await insertRide(sql, { stravaId: 11 });
    const t = track(line([LON0, LAT], [LON0 + M200_LON, LAT]));
    const result = await matchRide(sql, rideId, t, CLAIMED_AT);

    expect(result.newCount).toBe(1);
    expect(result.newLenM).toBeGreaterThan(190);
    expect(result.newLenM).toBeLessThan(210);

    const claims = await sql`
      SELECT s.osm_way_id FROM claims c JOIN segments s ON s.id = c.segment_id`;
    expect(claims.map((r) => Number(r.osm_way_id))).toEqual([1]);
  });

  it('does not claim a segment only half covered', async () => {
    const rideId = await insertRide(sql, { stravaId: 12 });
    // ride only the first 100 m of segment C
    const t = track(line([LON0, LAT + 0.001], [LON0 + M200_LON / 2, LAT + 0.001]));
    const result = await matchRide(sql, rideId, t, CLAIMED_AT);
    expect(result.newCount).toBe(0);
  });

  it('counts unpaved overlap even on re-rides, but claims only once', async () => {
    const t = track(line([LON0, LAT], [LON0 + M200_LON, LAT]));
    const first = await matchRide(sql, await insertRide(sql, { stravaId: 13 }), t, CLAIMED_AT);
    const second = await matchRide(sql, await insertRide(sql, { stravaId: 14 }), t, CLAIMED_AT);

    expect(first.newCount).toBe(1);
    expect(second.newCount).toBe(0);
    expect(second.newLenM).toBe(0);
    expect(second.unpavedM).toBeGreaterThan(150); // still riding gravel
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npx vitest run tests/matching.test.ts`
Expected: FAIL — cannot resolve `@/lib/matching`.

- [ ] **Step 3: Implement**

Create `lib/matching.ts`:

```ts
import type postgres from 'postgres';
import { BUFFER_M, COVERAGE_MIN } from './config';

export type MatchResult = { newCount: number; newLenM: number; unpavedM: number };

/**
 * Claim all segments with >= COVERAGE_MIN of their length inside a BUFFER_M
 * buffer of the ride track. First ride wins (claims PK); re-rides add nothing.
 * Returns totals the caller stores on the ride row.
 */
export async function matchRide(
  sql: postgres.Sql,
  rideId: number,
  trackGeoJson: string,
  claimedAt: Date
): Promise<MatchResult> {
  const [row] = await sql`
    WITH buf AS (
      SELECT ST_Buffer(
        ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(${trackGeoJson}), 4326), 2180),
        ${BUFFER_M}
      ) AS b
    ),
    cov AS (
      SELECT s.id, s.surface_class, s.length_m,
             ST_Length(ST_Intersection(s.geom_m, buf.b)) AS overlap_m
      FROM segments s, buf
      WHERE ST_Intersects(s.geom_m, buf.b)
    ),
    new_claims AS (
      INSERT INTO claims (segment_id, ride_id, claimed_at)
      SELECT id, ${rideId}, ${claimedAt}
      FROM cov
      WHERE overlap_m / length_m >= ${COVERAGE_MIN}
      ON CONFLICT (segment_id) DO NOTHING
      RETURNING segment_id
    )
    SELECT
      (SELECT COUNT(*)::int FROM new_claims) AS new_count,
      (SELECT COALESCE(SUM(cov.length_m), 0)::float
         FROM cov JOIN new_claims nc ON nc.segment_id = cov.id) AS new_len_m,
      (SELECT COALESCE(SUM(overlap_m), 0)::float
         FROM cov WHERE surface_class = 'unpaved') AS unpaved_m`;
  return { newCount: row.new_count, newLenM: row.new_len_m, unpavedM: row.unpaved_m };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npx vitest run tests/matching.test.ts`
Expected: 3 passed. If the half-coverage test is flaky around the 0.7 boundary, shorten the partial track to 40% of C (`M200_LON * 0.4`) — the assertion stays "no claim".

- [ ] **Step 5: Commit**

```bash
git add lib/matching.ts tests/matching.test.ts
git commit -m "feat: PostGIS ride-to-segment matching engine"
```

---

### Task 6: Strava client + OAuth routes

**Files:**
- Create: `lib/strava.ts`, `app/api/strava/connect/route.ts`, `app/api/strava/callback/route.ts`
- Test: `tests/strava.test.ts`

**Interfaces:**
- Consumes: `sql` from `lib/db`; env `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `APP_URL`.
- Produces:
  - `RATE_LIMITED: Error` sentinel (thrown on HTTP 429; callers compare with `===`)
  - `authorizeUrl(): string`
  - `exchangeCode(code: string): Promise<TokenSet>` where `TokenSet = { access_token: string; refresh_token: string; expires_at: number }` (epoch seconds)
  - `refreshTokens(refreshToken: string): Promise<TokenSet>`
  - `saveTokens(sql: postgres.Sql, t: TokenSet): Promise<void>`
  - `getValidToken(sql: postgres.Sql): Promise<string>` — refreshes when < 5 min validity left
  - `PER_PAGE = 50`; `fetchActivities(token: string, afterEpoch: number): Promise<SummaryActivity[]>` where `SummaryActivity = { id: number; name: string; sport_type: string; start_date: string; distance: number; total_elevation_gain: number }`; `fetchStreams(token: string, id: number): Promise<{ latlng?: { data: [number, number][] } }>` (`latlng` data is `[lat, lon]` — Strava order!)

- [ ] **Step 1: Write failing tests**

Create `tests/strava.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refreshTokens, fetchActivities, RATE_LIMITED, authorizeUrl } from '@/lib/strava';

describe('strava client', () => {
  beforeEach(() => {
    process.env.STRAVA_CLIENT_ID = 'cid';
    process.env.STRAVA_CLIENT_SECRET = 'csecret';
    process.env.APP_URL = 'https://example.test';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('authorizeUrl targets the callback with activity:read_all', () => {
    const url = new URL(authorizeUrl());
    expect(url.origin + url.pathname).toBe('https://www.strava.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.test/api/strava/callback');
    expect(url.searchParams.get('scope')).toBe('activity:read_all');
  });

  it('refreshTokens posts the refresh grant and returns tokens', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new-at', refresh_token: 'new-rt', expires_at: 1750000000,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const t = await refreshTokens('old-rt');
    expect(t.access_token).toBe('new-at');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://www.strava.com/oauth/token');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      client_id: 'cid', client_secret: 'csecret',
      refresh_token: 'old-rt', grant_type: 'refresh_token',
    });
  });

  it('throws the RATE_LIMITED sentinel on 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    await expect(fetchActivities('tok', 0)).rejects.toBe(RATE_LIMITED);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/strava.test.ts`
Expected: FAIL — cannot resolve `@/lib/strava`.

- [ ] **Step 3: Implement the client**

Create `lib/strava.ts`:

```ts
import type postgres from 'postgres';

const BASE = 'https://www.strava.com';
export const PER_PAGE = 50;
export const RATE_LIMITED = new Error('strava_rate_limited');

export type TokenSet = { access_token: string; refresh_token: string; expires_at: number };
export type SummaryActivity = {
  id: number;
  name: string;
  sport_type: string;
  start_date: string;
  distance: number;
  total_elevation_gain: number;
};

export function authorizeUrl(): string {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID!,
    redirect_uri: `${process.env.APP_URL}/api/strava/callback`,
    response_type: 'code',
    scope: 'activity:read_all',
  });
  return `${BASE}/oauth/authorize?${params}`;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      ...params,
    }),
  });
  if (!res.ok) throw new Error(`strava token request failed: ${res.status}`);
  return res.json();
}

export const exchangeCode = (code: string) =>
  tokenRequest({ code, grant_type: 'authorization_code' });
export const refreshTokens = (refreshToken: string) =>
  tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });

export async function saveTokens(sql: postgres.Sql, t: TokenSet) {
  await sql`
    INSERT INTO strava_tokens (id, access_token, refresh_token, expires_at)
    VALUES (1, ${t.access_token}, ${t.refresh_token}, to_timestamp(${t.expires_at}))
    ON CONFLICT (id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      expires_at = EXCLUDED.expires_at`;
}

export async function getValidToken(sql: postgres.Sql): Promise<string> {
  const [row] = await sql`
    SELECT access_token, refresh_token, expires_at FROM strava_tokens WHERE id = 1`;
  if (!row) throw new Error('Strava not connected — visit /api/strava/connect');
  if (new Date(row.expires_at).getTime() - Date.now() > 5 * 60 * 1000) {
    return row.access_token;
  }
  const t = await refreshTokens(row.refresh_token);
  await saveTokens(sql, t);
  return t.access_token;
}

async function api(token: string, path: string) {
  const res = await fetch(`${BASE}/api/v3${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) throw RATE_LIMITED;
  if (!res.ok) throw new Error(`strava api ${path}: ${res.status}`);
  return res.json();
}

export const fetchActivities = (token: string, afterEpoch: number): Promise<SummaryActivity[]> =>
  api(token, `/athlete/activities?after=${afterEpoch}&per_page=${PER_PAGE}`);

export const fetchStreams = (
  token: string,
  id: number
): Promise<{ latlng?: { data: [number, number][] } }> =>
  api(token, `/activities/${id}/streams?keys=latlng&key_by_type=true`);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/strava.test.ts`
Expected: 3 passed.

- [ ] **Step 5: OAuth routes**

Create `app/api/strava/connect/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { authorizeUrl } from '@/lib/strava';

export async function GET() {
  return NextResponse.redirect(authorizeUrl());
}
```

Create `app/api/strava/callback/route.ts`:

```ts
import { NextResponse } from 'next/server';
import sql from '@/lib/db';
import { exchangeCode, saveTokens } from '@/lib/strava';

export async function GET(req: Request) {
  const code = new URL(req.url).searchParams.get('code');
  if (!code) {
    return NextResponse.redirect(new URL('/?strava=denied', process.env.APP_URL));
  }
  const tokens = await exchangeCode(code);
  await saveTokens(sql, tokens);
  return NextResponse.redirect(new URL('/?strava=connected', process.env.APP_URL));
}
```

- [ ] **Step 6: Register the Strava API app (manual, one-time)**

1. Go to https://www.strava.com/settings/api and create an app: category "Data Importer", Authorization Callback Domain `localhost` for now (`localhost` is always permitted; the production domain is set in Task 12).
2. Put `Client ID` and `Client Secret` into `.env.local`.
3. Verify manually: `npm run dev`, open `http://localhost:3000/api/strava/connect`, approve on Strava, expect redirect to `/?strava=connected` and one row in `strava_tokens` (`docker compose exec db psql -U postgres -d gravel -c 'SELECT id, expires_at FROM strava_tokens'`).

- [ ] **Step 7: Commit**

```bash
git add lib/strava.ts app/api/strava tests/strava.test.ts
git commit -m "feat: Strava OAuth flow and API client with token refresh"
```

---

### Task 7: Sync pipeline (import rides, match, score)

**Files:**
- Create: `lib/sync.ts`, `app/api/sync/route.ts`, `components/SyncButton.tsx`
- Test: `tests/sync.test.ts`

**Interfaces:**
- Consumes: `getValidToken`, `fetchActivities`, `fetchStreams`, `RATE_LIMITED`, `PER_PAGE` from `lib/strava`; `matchRide` from `lib/matching`; `rideXp` from `lib/game`; `sql` from `lib/db`.
- Produces:
  - `latlngToLineString(latlng: [number, number][]): string` — Strava `[lat, lon]` → GeoJSON `[lon, lat]` LineString string
  - `isImportable(a: { sport_type: string }): boolean`
  - `POST /api/sync` → JSON `{ imported: number; skipped: number; more: boolean }` or 429 `{ rateLimited: true }`; processes ≤ 5 activities per call (Vercel timeout safety), caller loops while `more`
  - `<SyncButton />` client component used in the layout (Task 10)

- [ ] **Step 1: Write failing unit tests**

Create `tests/sync.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { latlngToLineString, isImportable } from '@/lib/sync';

describe('latlngToLineString', () => {
  it('swaps Strava [lat,lon] into GeoJSON [lon,lat]', () => {
    const json = latlngToLineString([[54.4, 16.9], [54.41, 16.91]]);
    expect(JSON.parse(json)).toEqual({
      type: 'LineString',
      coordinates: [[16.9, 54.4], [16.91, 54.41]],
    });
  });
});

describe('isImportable', () => {
  it('accepts bike rides', () => {
    for (const t of ['Ride', 'GravelRide', 'MountainBikeRide', 'EBikeRide']) {
      expect(isImportable({ sport_type: t })).toBe(true);
    }
  });
  it('rejects everything else', () => {
    for (const t of ['Run', 'Walk', 'VirtualRide', 'Swim']) {
      expect(isImportable({ sport_type: t })).toBe(false);
    }
  });
});
```

Note: `VirtualRide` is rejected on purpose — trainer rides paint no roads.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/sync.test.ts`
Expected: FAIL — cannot resolve `@/lib/sync`.

- [ ] **Step 3: Implement helpers**

Create `lib/sync.ts`:

```ts
const RIDE_TYPES = new Set(['Ride', 'GravelRide', 'MountainBikeRide', 'EBikeRide', 'EMountainBikeRide']);

export function latlngToLineString(latlng: [number, number][]): string {
  return JSON.stringify({
    type: 'LineString',
    coordinates: latlng.map(([lat, lon]) => [lon, lat]),
  });
}

export function isImportable(a: { sport_type: string }): boolean {
  return RIDE_TYPES.has(a.sport_type);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/sync.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Sync route**

Create `app/api/sync/route.ts`:

```ts
import { NextResponse } from 'next/server';
import sql from '@/lib/db';
import { getValidToken, fetchActivities, fetchStreams, RATE_LIMITED, PER_PAGE } from '@/lib/strava';
import { latlngToLineString, isImportable } from '@/lib/sync';
import { matchRide } from '@/lib/matching';
import { rideXp } from '@/lib/game';

export const maxDuration = 60;
const BATCH = 5;

export async function POST() {
  try {
    const token = await getValidToken(sql);
    const [{ last }] = await sql`
      SELECT COALESCE(EXTRACT(EPOCH FROM MAX(started_at))::bigint, 0) AS last FROM rides`;
    const activities = await fetchActivities(token, Number(last));

    const todo = [];
    for (const a of activities) {
      if (!isImportable(a)) continue;
      const exists = await sql`SELECT 1 FROM rides WHERE strava_activity_id = ${a.id}`;
      if (!exists.length) todo.push(a);
      if (todo.length >= BATCH) break;
    }

    let imported = 0;
    let skipped = 0;
    for (const a of todo) {
      const streams = await fetchStreams(token, a.id);
      const latlng = streams.latlng?.data;
      if (!latlng || latlng.length < 2) {
        await sql`
          INSERT INTO rides (strava_activity_id, name, started_at, distance_m, elevation_m, status)
          VALUES (${a.id}, ${a.name}, ${a.start_date}, ${a.distance},
                  ${a.total_elevation_gain}, 'skipped_no_gps')
          ON CONFLICT (strava_activity_id) DO NOTHING`;
        skipped++;
        continue;
      }
      const track = latlngToLineString(latlng);
      const [ride] = await sql`
        INSERT INTO rides (strava_activity_id, name, started_at, distance_m, elevation_m, track)
        VALUES (${a.id}, ${a.name}, ${a.start_date}, ${a.distance}, ${a.total_elevation_gain},
                ST_SetSRID(ST_GeomFromGeoJSON(${track}), 4326))
        ON CONFLICT (strava_activity_id) DO NOTHING
        RETURNING id`;
      if (!ride) continue; // raced with a concurrent sync — already imported
      try {
        const m = await matchRide(sql, ride.id, track, new Date(a.start_date));
        await sql`
          UPDATE rides
          SET new_segments = ${m.newCount}, unpaved_m = ${m.unpavedM},
              xp = ${rideXp(a.distance, m.newLenM)}
          WHERE id = ${ride.id}`;
      } catch (e) {
        console.error(`matching failed for activity ${a.id}:`, e);
        await sql`UPDATE rides SET status = 'failed' WHERE id = ${ride.id}`;
      }
      imported++;
    }

    // More work remains if we truncated the batch or Strava's page was full —
    // but only claim so when this call made progress, else the client would loop forever.
    const more = (todo.length >= BATCH || activities.length >= PER_PAGE) && imported + skipped > 0;
    return NextResponse.json({ imported, skipped, more });
  } catch (e) {
    if (e === RATE_LIMITED) {
      return NextResponse.json({ rateLimited: true }, { status: 429 });
    }
    throw e;
  }
}
```

- [ ] **Step 6: Sync button**

Create `components/SyncButton.tsx`:

```tsx
'use client';

import { useState } from 'react';

type State = 'idle' | 'syncing' | 'rate_limited' | 'error';

export default function SyncButton() {
  const [state, setState] = useState<State>('idle');
  const [count, setCount] = useState(0);

  async function run() {
    setState('syncing');
    let total = 0;
    for (;;) {
      const res = await fetch('/api/sync', { method: 'POST' });
      if (res.status === 429) { setState('rate_limited'); return; }
      if (!res.ok) { setState('error'); return; }
      const j = await res.json();
      total += j.imported + j.skipped;
      setCount(total);
      if (!j.more) break;
    }
    setState('idle');
    location.reload();
  }

  const label =
    state === 'syncing' ? `Syncing… ${count}` :
    state === 'rate_limited' ? 'Strava limit — retry in 15 min' :
    state === 'error' ? 'Sync failed — retry' :
    'Sync rides';

  return (
    <button onClick={run} disabled={state === 'syncing'} style={{ padding: '6px 14px' }}>
      {label}
    </button>
  );
}
```

- [ ] **Step 7: Manual end-to-end check**

With Strava connected (Task 6) and the network imported (Task 3): `npm run dev`, then `curl -X POST http://localhost:3000/api/sync` repeatedly (or wait for Task 10's button).
Expected: `{"imported":N,"skipped":M,"more":true|false}`; rides appear in `rides`; claims appear in `claims`. During a large backfill a 429 is normal — resume after 15 minutes; imports pick up exactly where they stopped (idempotent, `after=MAX(started_at)`).

- [ ] **Step 8: Commit**

```bash
git add lib/sync.ts app/api/sync components/SyncButton.tsx tests/sync.test.ts
git commit -m "feat: batched Strava ride sync with matching and XP scoring"
```

---

### Task 8: App lock (middleware + login)

**Files:**
- Create: `middleware.ts`, `app/login/page.tsx`, `app/api/login/route.ts`

**Interfaces:**
- Consumes: env `APP_PASSWORD`.
- Produces: every route except `/login`, `/api/login`, and Next.js internals redirects to `/login` unless the `atlas_key` cookie matches `APP_PASSWORD`. (v1.5 note: a future Strava webhook endpoint must be added to the matcher's exclusions.)

- [ ] **Step 1: Middleware**

Create `middleware.ts` (repo root):

```ts
import { NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  if (req.cookies.get('atlas_key')?.value === process.env.APP_PASSWORD) {
    return NextResponse.next();
  }
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = {
  matcher: ['/((?!login|api/login|_next|favicon.ico).*)'],
};
```

- [ ] **Step 2: Login page**

Create `app/login/page.tsx`:

```tsx
export default function LoginPage() {
  return (
    <main style={{ maxWidth: 320, margin: '20vh auto', fontFamily: 'system-ui' }}>
      <h1>🚵 Gravel Atlas</h1>
      <form method="post" action="/api/login">
        <input
          type="password"
          name="password"
          placeholder="Password"
          autoFocus
          style={{ width: '100%', padding: 8, marginBottom: 8 }}
        />
        <button type="submit" style={{ width: '100%', padding: 8 }}>Enter</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Login route**

Create `app/api/login/route.ts`:

```ts
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  const form = await req.formData();
  if (form.get('password') === process.env.APP_PASSWORD) {
    const res = NextResponse.redirect(new URL('/', req.url), 303);
    res.cookies.set('atlas_key', process.env.APP_PASSWORD!, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    });
    return res;
  }
  return NextResponse.redirect(new URL('/login', req.url), 303);
}
```

- [ ] **Step 4: Manual verification**

Run `npm run dev`. Open `http://localhost:3000/` in a private window → expect redirect to `/login`. Wrong password → back at `/login`. Correct password → redirected to `/`.

- [ ] **Step 5: Commit**

```bash
git add middleware.ts app/login app/api/login
git commit -m "feat: app-lock middleware with cookie login"
```

---

### Task 9: Read APIs (segments GeoJSON + stats)

**Files:**
- Create: `lib/stats.ts`, `app/api/segments/route.ts`, `app/api/stats/route.ts`

**Interfaces:**
- Consumes: `sql` from `lib/db`; `levelForXp`, `xpForLevel`, `titleForLevel`, `sat` from `lib/game`.
- Produces:
  - `getStats(): Promise<Stats>` from `lib/stats` where

    ```ts
    type Stats = {
      completion: { claimedM: number; totalM: number; pct: number };
      gminas: { gmina: string; claimedM: number; totalM: number; pct: number }[];
      xp: number; level: number; title: string;
      levelStartXp: number; nextLevelXp: number;
      explorer: number;      // segments claimed
      enduranceKm: number;   // total km + long-ride bonus km
      gritKm: number;        // unpaved km ridden
      climberM: number;      // meters climbed
      radar: { label: string; norm: number }[]; // 4 axes, norm in [0,1]
    };
    ```
  - `GET /api/segments` → GeoJSON FeatureCollection, properties `{ id, claimed, surface, name, length_m }`, geometry simplified (~5 m tolerance)
  - `GET /api/stats` → `Stats` as JSON

- [ ] **Step 1: Stats library**

Create `lib/stats.ts`:

```ts
import sql from './db';
import { levelForXp, xpForLevel, titleForLevel, sat } from './game';

export type GminaCompletion = { gmina: string; claimedM: number; totalM: number; pct: number };
export type Stats = {
  completion: { claimedM: number; totalM: number; pct: number };
  gminas: GminaCompletion[];
  xp: number; level: number; title: string;
  levelStartXp: number; nextLevelXp: number;
  explorer: number; enduranceKm: number; gritKm: number; climberM: number;
  radar: { label: string; norm: number }[];
};

const pct = (claimed: number, total: number) => (total > 0 ? (claimed / total) * 100 : 0);

export async function getStats(): Promise<Stats> {
  const [overall] = await sql`
    SELECT COALESCE(SUM(s.length_m) FILTER (WHERE c.segment_id IS NOT NULL), 0)::float AS claimed_m,
           COALESCE(SUM(s.length_m), 0)::float AS total_m
    FROM segments s LEFT JOIN claims c ON c.segment_id = s.id`;

  const gminaRows = await sql`
    SELECT COALESCE(s.gmina, '(unknown)') AS gmina,
           COALESCE(SUM(s.length_m) FILTER (WHERE c.segment_id IS NOT NULL), 0)::float AS claimed_m,
           COALESCE(SUM(s.length_m), 0)::float AS total_m
    FROM segments s LEFT JOIN claims c ON c.segment_id = s.id
    GROUP BY 1 ORDER BY 1`;

  const [rides] = await sql`
    SELECT COALESCE(SUM(xp), 0)::int AS xp,
           COALESCE(SUM(distance_m), 0)::float AS dist_m,
           COALESCE(SUM(elevation_m), 0)::float AS elev_m,
           COALESCE(SUM(unpaved_m), 0)::float AS unpaved_m,
           COALESCE(SUM(GREATEST(distance_m / 1000.0 - 50, 0)), 0)::float AS bonus_km
    FROM rides WHERE status = 'imported'`;

  const [{ explorer }] = await sql`SELECT COUNT(*)::int AS explorer FROM claims`;

  const level = levelForXp(rides.xp);
  const enduranceKm = rides.dist_m / 1000 + rides.bonus_km;
  const gritKm = rides.unpaved_m / 1000;

  return {
    completion: { claimedM: overall.claimed_m, totalM: overall.total_m, pct: pct(overall.claimed_m, overall.total_m) },
    gminas: gminaRows.map((g) => ({
      gmina: g.gmina, claimedM: g.claimed_m, totalM: g.total_m, pct: pct(g.claimed_m, g.total_m),
    })),
    xp: rides.xp,
    level,
    title: titleForLevel(level),
    levelStartXp: xpForLevel(level),
    nextLevelXp: xpForLevel(level + 1),
    explorer,
    enduranceKm,
    gritKm,
    climberM: rides.elev_m,
    radar: [
      { label: 'Explorer', norm: sat(explorer, 150) },
      { label: 'Endurance', norm: sat(enduranceKm, 1000) },
      { label: 'Grit', norm: sat(gritKm, 500) },
      { label: 'Climber', norm: sat(rides.elev_m, 5000) },
    ],
  };
}
```

- [ ] **Step 2: Segments GeoJSON route**

Create `app/api/segments/route.ts`:

```ts
import { NextResponse } from 'next/server';
import sql from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [row] = await sql`
    SELECT jsonb_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(jsonb_agg(f), '[]'::jsonb)
    ) AS fc
    FROM (
      SELECT jsonb_build_object(
        'type', 'Feature',
        'geometry', ST_AsGeoJSON(ST_Simplify(s.geom, 0.00005), 6)::jsonb,
        'properties', jsonb_build_object(
          'id', s.id,
          'claimed', c.segment_id IS NOT NULL,
          'surface', s.surface_class,
          'name', s.name,
          'length_m', ROUND(s.length_m)
        )
      ) AS f
      FROM segments s LEFT JOIN claims c ON c.segment_id = s.id
    ) sub`;
  return NextResponse.json(row.fc);
}
```

- [ ] **Step 3: Stats route**

Create `app/api/stats/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { getStats } from '@/lib/stats';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await getStats());
}
```

- [ ] **Step 4: Manual verification**

Run `npm run dev` (log in first, cookie applies to curl only via browser — verify in the browser):
- `http://localhost:3000/api/segments` → FeatureCollection with thousands of features.
- `http://localhost:3000/api/stats` → completion, gminas array, xp/level/title, radar with 4 axes.

- [ ] **Step 5: Commit**

```bash
git add lib/stats.ts app/api/segments app/api/stats
git commit -m "feat: segments GeoJSON and stats APIs"
```

---

### Task 10: Layout + Map screen

**Files:**
- Modify: `app/layout.tsx`, `app/page.tsx` (replace scaffold content)

**Interfaces:**
- Consumes: `GET /api/segments`, `GET /api/stats`, `<SyncButton />` from `components/SyncButton`, `REGION` from `lib/region` (client-safe: only `NEXT_PUBLIC_*` env).
- Produces: nav shell used by all pages; the map home screen.

- [ ] **Step 1: Layout with nav**

Replace `app/layout.tsx`:

```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import SyncButton from '@/components/SyncButton';
import './globals.css';

export const metadata: Metadata = { title: 'Gravel Atlas' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui' }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 16, padding: '8px 16px',
          borderBottom: '1px solid #ddd',
        }}>
          <strong>🚵 Gravel Atlas</strong>
          <nav style={{ display: 'flex', gap: 12 }}>
            <Link href="/">Map</Link>
            <Link href="/character">Character</Link>
            <Link href="/rides">Rides</Link>
          </nav>
          <span style={{ marginLeft: 'auto' }}><SyncButton /></span>
        </header>
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Map page**

Replace `app/page.tsx`:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { REGION } from '@/lib/region';

const GREY = '#9aa0a6';
const PAINT = '#e8590c';

type StatsLite = { completion: { pct: number } };

export default function MapPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [unpavedOnly, setUnpavedOnly] = useState(false);
  const [stats, setStats] = useState<StatsLite | null>(null);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      center: [REGION.lon, REGION.lat],
      zoom: 10,
    });
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('segments', { type: 'geojson', data: '/api/segments' });
      map.addLayer({
        id: 'seg-grey', type: 'line', source: 'segments',
        filter: ['==', ['get', 'claimed'], false],
        paint: { 'line-color': GREY, 'line-width': 1.5 },
      });
      map.addLayer({
        id: 'seg-claimed', type: 'line', source: 'segments',
        filter: ['==', ['get', 'claimed'], true],
        paint: { 'line-color': PAINT, 'line-width': 2.5 },
      });
      for (const layer of ['seg-grey', 'seg-claimed']) {
        map.on('click', layer, (e) => {
          const p = e.features?.[0]?.properties;
          if (!p) return;
          new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(
              `<strong>${p.name || 'Unnamed'}</strong><br/>` +
              `${p.surface} · ${p.length_m} m · ${p.claimed === true || p.claimed === 'true' ? 'claimed ✅' : 'unclaimed'}`
            )
            .addTo(map);
        });
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      }
    });

    fetch('/api/stats').then((r) => r.json()).then(setStats);
    return () => map.remove();
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer('seg-grey')) return;
    const withSurface = (claimed: boolean): maplibregl.FilterSpecification =>
      unpavedOnly
        ? ['all', ['==', ['get', 'claimed'], claimed], ['==', ['get', 'surface'], 'unpaved']]
        : ['==', ['get', 'claimed'], claimed];
    map.setFilter('seg-grey', withSurface(false));
    map.setFilter('seg-claimed', withSurface(true));
  }, [unpavedOnly]);

  return (
    <main style={{ position: 'relative', height: 'calc(100vh - 45px)' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <div style={{
        position: 'absolute', top: 12, left: 12, zIndex: 1, background: 'white',
        padding: '8px 12px', borderRadius: 8, boxShadow: '0 1px 4px rgba(0,0,0,.3)',
      }}>
        <div style={{ fontSize: 22, fontWeight: 700 }}>
          {stats ? `${stats.completion.pct.toFixed(2)}%` : '…'}
        </div>
        <div style={{ fontSize: 12, color: '#666' }}>of the atlas painted</div>
        <label style={{ fontSize: 13, display: 'block', marginTop: 6 }}>
          <input
            type="checkbox"
            checked={unpavedOnly}
            onChange={(e) => setUnpavedOnly(e.target.checked)}
          /> unpaved only
        </label>
      </div>
    </main>
  );
}
```

- [ ] **Step 3: Manual verification**

`npm run dev`, log in, open `/`. Expected: OSM basemap centered on Reblino, the full network in grey (orange where claims exist after a sync), completion badge top-left, popup on segment click, unpaved-only toggle hides paved segments. Check on a phone-sized viewport too — the header and badge must not overlap the map controls.

- [ ] **Step 4: Commit**

```bash
git add app/layout.tsx app/page.tsx
git commit -m "feat: map screen with painted segments and completion badge"
```

---

### Task 11: Character sheet + ride log

**Files:**
- Create: `components/Radar.tsx`, `app/character/page.tsx`, `app/rides/page.tsx`

**Interfaces:**
- Consumes: `getStats()` from `lib/stats`; `sql` from `lib/db` (server components query directly — no extra API needed).
- Produces: `/character` and `/rides` pages; `Radar({ axes: { label: string; norm: number }[] })` component.

- [ ] **Step 1: Radar component**

Create `components/Radar.tsx`:

```tsx
export default function Radar({ axes }: { axes: { label: string; norm: number }[] }) {
  const cx = 150, cy = 150, R = 110;
  const pt = (i: number, r: number): [number, number] => {
    const angle = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  };
  const ring = (f: number) => axes.map((_, i) => pt(i, R * f).join(',')).join(' ');
  const shape = axes.map((a, i) => pt(i, R * Math.max(0.02, a.norm)).join(',')).join(' ');

  return (
    <svg viewBox="0 0 300 300" width={300} height={300} role="img" aria-label="Stats radar">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <polygon key={f} points={ring(f)} fill="none" stroke="#ddd" />
      ))}
      {axes.map((_, i) => {
        const [x, y] = pt(i, R);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#ddd" />;
      })}
      <polygon points={shape} fill="rgba(232,89,12,0.35)" stroke="#e8590c" strokeWidth={2} />
      {axes.map((a, i) => {
        const [x, y] = pt(i, R + 24);
        return (
          <text key={i} x={x} y={y} textAnchor="middle" fontSize={13} fill="#333">
            {a.label}
          </text>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 2: Character page**

Create `app/character/page.tsx`:

```tsx
import { getStats } from '@/lib/stats';
import Radar from '@/components/Radar';

export const dynamic = 'force-dynamic';

export default async function CharacterPage() {
  const s = await getStats();
  const levelPct = Math.min(
    100,
    ((s.xp - s.levelStartXp) / (s.nextLevelXp - s.levelStartXp)) * 100
  );

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <h1 style={{ marginBottom: 0 }}>Level {s.level} — {s.title}</h1>
      <div style={{ background: '#eee', borderRadius: 6, height: 14, margin: '12px 0' }}>
        <div style={{
          width: `${levelPct}%`, height: '100%', background: '#e8590c', borderRadius: 6,
        }} />
      </div>
      <p style={{ color: '#666', marginTop: 0 }}>
        {s.xp} XP — {s.nextLevelXp - s.xp} to level {s.level + 1}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }}>
        <Radar axes={s.radar} />
        <ul style={{ lineHeight: 2, listStyle: 'none', padding: 0 }}>
          <li>🧭 <strong>Explorer</strong> — {s.explorer} segments claimed</li>
          <li>🔋 <strong>Endurance</strong> — {Math.round(s.enduranceKm)} pts</li>
          <li>🪨 <strong>Grit</strong> — {Math.round(s.gritKm)} unpaved km</li>
          <li>⛰️ <strong>Climber</strong> — {Math.round(s.climberM)} m climbed</li>
        </ul>
      </div>

      <h2>Gmina completion</h2>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd' }}>
            <th style={{ padding: 6 }}>Gmina</th><th style={{ padding: 6 }}>Painted</th>
            <th style={{ padding: 6 }}>%</th>
          </tr>
        </thead>
        <tbody>
          {s.gminas.map((g) => (
            <tr key={g.gmina} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{g.gmina}</td>
              <td style={{ padding: 6 }}>
                {(g.claimedM / 1000).toFixed(1)} / {(g.totalM / 1000).toFixed(0)} km
              </td>
              <td style={{ padding: 6 }}>{g.pct.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
```

- [ ] **Step 3: Ride log page**

Create `app/rides/page.tsx`:

```tsx
import sql from '@/lib/db';

export const dynamic = 'force-dynamic';

type RideRow = {
  id: number; name: string; started_at: string; distance_m: number;
  new_segments: number; xp: number; status: string;
};

export default async function RidesPage() {
  const rides = await sql<RideRow[]>`
    SELECT id, name, started_at, distance_m, new_segments, xp, status
    FROM rides ORDER BY started_at DESC LIMIT 200`;

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <h1>Ride log</h1>
      {rides.length === 0 && <p>No rides yet — hit “Sync rides” after your next gravel adventure.</p>}
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd' }}>
            <th style={{ padding: 6 }}>Date</th><th style={{ padding: 6 }}>Ride</th>
            <th style={{ padding: 6 }}>km</th><th style={{ padding: 6 }}>New segments</th>
            <th style={{ padding: 6 }}>XP</th>
          </tr>
        </thead>
        <tbody>
          {rides.map((r) => (
            <tr key={r.id} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{new Date(r.started_at).toLocaleDateString('en-GB')}</td>
              <td style={{ padding: 6 }}>
                {r.name}
                {r.status === 'skipped_no_gps' && ' ⚠️ (no GPS — skipped)'}
                {r.status === 'failed' && ' ❌ (matching failed)'}
              </td>
              <td style={{ padding: 6 }}>{(r.distance_m / 1000).toFixed(1)}</td>
              <td style={{ padding: 6 }}>{r.status === 'imported' ? r.new_segments : '—'}</td>
              <td style={{ padding: 6 }}>{r.status === 'imported' ? `+${r.xp}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
```

- [ ] **Step 4: Manual verification + full test run**

`npm run dev`: `/character` shows level, XP bar, radar, gmina table; `/rides` lists synced rides with statuses. Then run the whole suite:

`TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npm test`
Expected: all tests pass. Also `npm run build` must succeed.

- [ ] **Step 5: Commit**

```bash
git add components/Radar.tsx app/character app/rides
git commit -m "feat: character sheet and ride log screens"
```

---

### Task 12: Deploy (Neon + Vercel + Strava production config)

**Files:**
- None (configuration + one-off commands). Update `README.md` with the runbook below.

**Interfaces:**
- Consumes: everything above.
- Produces: the live app on `https://<project>.vercel.app`.

- [ ] **Step 1: Neon database**

1. Create a free project at https://neon.tech (region: EU).
2. In the SQL editor run: `CREATE EXTENSION IF NOT EXISTS postgis;`
3. Copy the **pooled** connection string (host contains `-pooler`).
4. Migrate and import the network from your machine:

```bash
MIGRATE_DATABASE_URL='<neon-pooled-url>' npm run migrate
DATABASE_URL='<neon-pooled-url>' npx tsx scripts/import-network.ts
```

Expected: same segment/gmina tables as local (Task 3 Step 6).

- [ ] **Step 2: Vercel project**

```bash
npx vercel link
npx vercel env add DATABASE_URL production    # neon pooled url
npx vercel env add APP_PASSWORD production
npx vercel env add APP_URL production         # https://<project>.vercel.app
npx vercel env add STRAVA_CLIENT_ID production
npx vercel env add STRAVA_CLIENT_SECRET production
npx vercel env add NEXT_PUBLIC_REGION_LAT production
npx vercel env add NEXT_PUBLIC_REGION_LON production
npx vercel env add REGION_RADIUS_M production
npx vercel deploy --prod
```

- [ ] **Step 3: Strava production callback**

In https://www.strava.com/settings/api set **Authorization Callback Domain** to `<project>.vercel.app` (no scheme, no path). `localhost` keeps working for dev.

- [ ] **Step 4: End-to-end smoke test on production**

1. Open the production URL on your **phone**: login gate → password → grey map of Pomerania.
2. Visit `/api/strava/connect`, approve, expect `/?strava=connected`.
3. Tap **Sync rides** — historical backfill begins (429 pauses are normal; resume after 15 min).
4. Confirm: painted segments on the map, level/title on `/character`, rides in `/rides`.
5. Pin to home screen. Go ride gravel. 🚵

- [ ] **Step 5: Commit README runbook**

Write `README.md` covering: what the app is, `.env.example` variables, `docker compose up -d`, `npm run migrate`, `npm run import:network`, `npm run dev`, `npm test` (needs `TEST_DATABASE_URL`), and the deploy steps above. Then:

```bash
git add README.md
git commit -m "docs: setup and deploy runbook"
```

---

## Post-v1 backlog (do not build now)

- Strava webhook auto-import (add endpoint to middleware exclusions + subscription handshake).
- Quests, bounty segments, additional regions, weather-based Grit (spec v2 section).
- Network refresh strategy for changed OSM geometry (currently: additive re-import only).
- Vector tiles if the segments GeoJSON payload ever feels slow on mobile.





