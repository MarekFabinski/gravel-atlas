// getStats() pulls in lib/db, whose module-level `postgres(...)` call reads
// process.env.DATABASE_URL at *import* time. ES module imports are hoisted
// and evaluated before any other top-level code in this file runs, so a
// plain `import { getStats } from '@/lib/stats'` here would connect lib/db
// to the dev database before we ever get a chance to repoint it — no matter
// where in the file the import line appears. To avoid that we (a) set
// DATABASE_URL to the test DB as literally the first statement this module
// executes, and (b) load lib/stats via a dynamic `await import(...)` inside
// beforeAll, well after that assignment has run. vi.resetModules() guards
// against a lib/db singleton some other test file already cached (pointed
// at the wrong database) leaking into this one.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { testDb, resetDb, insertSegment, insertRide, TEST_DB_URL } from './helpers/db';
import { levelForXp, titleForLevel, sat } from '@/lib/game';
import type { Stats } from '@/lib/stats';

const d = TEST_DB_URL ? describe : describe.skip;

const LAT = 54.4;
const LON0 = 16.9;
const M200_LON = 0.003086; // ≈200 m of longitude at this latitude
const CLAIMED_AT = new Date('2026-07-01T10:00:00Z');

d('getStats', () => {
  const sql = testDb();
  let getStats: () => Promise<Stats>;

  let seg1Id: number, seg2Id: number;
  let seg1Len: number, seg2Len: number, seg3Len: number;

  beforeAll(async () => {
    await resetDb(sql);

    vi.resetModules();
    ({ getStats } = await import('@/lib/stats'));

    // Two unpaved segments (each ~200 m, distinct osm_way_ids) that will be
    // claimed, plus one paved segment (~200 m) that never is. None set a
    // gmina, so all three should roll into the '(unknown)' bucket.
    await insertSegment(sql, { wayId: 1, wkt: `LINESTRING(${LON0} ${LAT}, ${LON0 + M200_LON} ${LAT})`, surface: 'unpaved' });
    await insertSegment(sql, { wayId: 2, wkt: `LINESTRING(${LON0} ${LAT + 0.002}, ${LON0 + M200_LON} ${LAT + 0.002})`, surface: 'unpaved' });
    await insertSegment(sql, { wayId: 3, wkt: `LINESTRING(${LON0} ${LAT + 0.004}, ${LON0 + M200_LON} ${LAT + 0.004})`, surface: 'paved' });

    const segRows = await sql<{ id: number; osm_way_id: string | number; length_m: number }[]>`
      SELECT id, osm_way_id, length_m FROM segments`;
    const byWayId = new Map(segRows.map((r) => [Number(r.osm_way_id), r]));
    seg1Id = byWayId.get(1)!.id;
    seg2Id = byWayId.get(2)!.id;
    seg1Len = byWayId.get(1)!.length_m;
    seg2Len = byWayId.get(2)!.length_m;
    seg3Len = byWayId.get(3)!.length_m;

    // Ride A: 60 km, imported. The only ride over the 50 km bonus
    // threshold, so it alone should contribute an endurance bonus.
    // insertRide only sets distance_m (+ a couple other basics); the rest
    // of the columns getStats() cares about are set directly.
    const rideA = await insertRide(sql, { stravaId: 9001, distanceM: 60000 });
    await sql`UPDATE rides SET elevation_m = 400, unpaved_m = 20000, xp = 150 WHERE id = ${rideA}`;

    // Ride B: 10 km, imported, under the bonus threshold.
    const rideB = await insertRide(sql, { stravaId: 9002, distanceM: 10000 });
    await sql`UPDATE rides SET elevation_m = 200, unpaved_m = 5000, xp = 50 WHERE id = ${rideB}`;

    // Ride C: failed import with wildly inflated numbers — must be
    // excluded from every rides-derived aggregate (xp, distance,
    // elevation, unpaved, bonus).
    const rideC = await insertRide(sql, { stravaId: 9003, distanceM: 999999 });
    await sql`UPDATE rides SET status = 'failed', xp = 99999 WHERE id = ${rideC}`;

    // Claim both unpaved segments (one per successful ride). The paved
    // segment is left unclaimed on purpose.
    await sql`INSERT INTO claims (segment_id, ride_id, claimed_at) VALUES (${seg1Id}, ${rideA}, ${CLAIMED_AT})`;
    await sql`INSERT INTO claims (segment_id, ride_id, claimed_at) VALUES (${seg2Id}, ${rideB}, ${CLAIMED_AT})`;
  });

  // Only close the helper's own connection. lib/db owns a process-wide
  // singleton (see lib/db.ts) that must stay open for any other code in
  // this process that still references it.
  afterAll(async () => { await sql.end(); });

  it('completion totals claimed/all segment length, ignoring the paved segment', async () => {
    const stats = await getStats();
    const expectedClaimed = seg1Len + seg2Len;
    const expectedTotal = seg1Len + seg2Len + seg3Len;

    // Precise: derived from the same length_m values getStats() itself sums.
    expect(stats.completion.claimedM).toBeCloseTo(expectedClaimed, 3);
    expect(stats.completion.totalM).toBeCloseTo(expectedTotal, 3);

    // Sanity range against the ~200 m-per-segment synthetic geometry.
    expect(stats.completion.claimedM).toBeGreaterThan(380);
    expect(stats.completion.claimedM).toBeLessThan(420);
    expect(stats.completion.totalM).toBeGreaterThan(580);
    expect(stats.completion.totalM).toBeLessThan(620);

    expect(stats.completion.pct).toBeCloseTo(
      (stats.completion.claimedM / stats.completion.totalM) * 100,
      6
    );
  });

  it('xp/level/title reflect only imported rides, excluding the failed one', async () => {
    const stats = await getStats();
    expect(stats.xp).toBe(200); // 150 + 50; ride C's 99999 excluded
    expect(stats.level).toBe(levelForXp(200));
    expect(stats.level).toBe(2);
    expect(stats.title).toBe(titleForLevel(2));
  });

  it('enduranceKm adds the >50km bonus only for the ride that earns it', async () => {
    const stats = await getStats();
    // 70 km ridden (60 + 10) + bonus of max(60-50,0) + max(10-50,0) = 10
    expect(stats.enduranceKm).toBeCloseTo(80, 5);
  });

  it('gritKm and climberM sum unpaved/elevation from imported rides only', async () => {
    const stats = await getStats();
    expect(stats.gritKm).toBeCloseTo(25, 6); // (20000 + 5000) / 1000
    expect(stats.climberM).toBeCloseTo(600, 6); // 400 + 200
  });

  it('explorer counts claimed segments regardless of surface', async () => {
    const stats = await getStats();
    expect(stats.explorer).toBe(2);
  });

  it('radar has four sat()-normalized axes in a fixed order', async () => {
    const stats = await getStats();
    expect(stats.radar.map((r) => r.label)).toEqual(['Explorer', 'Endurance', 'Grit', 'Climber']);

    expect(stats.radar[0].norm).toBe(sat(stats.explorer, 150));
    expect(stats.radar[1].norm).toBe(sat(stats.enduranceKm, 1000));
    expect(stats.radar[2].norm).toBe(sat(stats.gritKm, 500));
    expect(stats.radar[3].norm).toBe(sat(stats.climberM, 5000));
  });

  it('gminas has a single (unknown) bucket matching the overall totals', async () => {
    const stats = await getStats();
    expect(stats.gminas.length).toBe(1);
    expect(stats.gminas[0].gmina).toBe('(unknown)');
    expect(stats.gminas[0].claimedM).toBeCloseTo(stats.completion.claimedM, 6);
    expect(stats.gminas[0].totalM).toBeCloseTo(stats.completion.totalM, 6);
    expect(stats.gminas[0].pct).toBeCloseTo(stats.completion.pct, 6);
  });
});
