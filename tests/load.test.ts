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
