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
