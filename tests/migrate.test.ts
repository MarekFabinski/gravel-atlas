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
