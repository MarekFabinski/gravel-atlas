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
    expect(report).toMatchObject({
      waysWithSegments: 2, segments: 2, claimed: 1, deleted: false, deletedSegments: 0,
    });
    expect(report.km).toBeGreaterThan(0.35);
    expect(report.km).toBeLessThan(0.45);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM segments`;
    expect(n).toBe(3);
    // A dry run must be a strict no-op — claims must survive untouched too.
    const [{ n: claimsN }] = await sql`SELECT COUNT(*)::int AS n FROM claims`;
    expect(claimsN).toBe(1);
  });

  it('execute deletes the targeted segments and cascades claims, sparing the rest', async () => {
    const report = await purgeByWayIds(sql, [1, 2, 999], true);
    expect(report.deleted).toBe(true);
    expect(report.deletedSegments).toBe(2);
    const remaining = await sql`SELECT osm_way_id FROM segments`;
    expect(remaining.map((r) => Number(r.osm_way_id))).toEqual([3]);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM claims`;
    expect(n).toBe(0);
    const [{ rides }] = await sql`SELECT COUNT(*)::int AS rides FROM rides`;
    expect(rides).toBe(1); // rides are never touched
  });

  it('handles wayId lists that span multiple delete chunks', async () => {
    // 10,001 IDs forces two DELETE chunks (10,000 + 1). Way 1 sits in chunk
    // 1 (index 0) and way 2 sits in chunk 2 (index 10,000) — both real
    // segments must still be deleted regardless of which chunk they land in.
    const ids = Array.from({ length: 10_001 }, (_, i) => 100_000_000 + i);
    ids[0] = 1;
    ids[10_000] = 2;

    const report = await purgeByWayIds(sql, ids, true);
    expect(report.deleted).toBe(true);
    expect(report.deletedSegments).toBe(2);
    const remaining = await sql`SELECT osm_way_id FROM segments`;
    expect(remaining.map((r) => Number(r.osm_way_id))).toEqual([3]);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM claims`;
    expect(n).toBe(0);
  });
});
