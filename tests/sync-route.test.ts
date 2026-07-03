// See tests/stats.test.ts for why this env override has to be the very
// first statement in the file: lib/db reads DATABASE_URL at *import* time,
// and ES module imports are hoisted above any other top-level code.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { testDb, resetDb, insertSegment, TEST_DB_URL } from './helpers/db';
import type { SummaryActivity } from '@/lib/strava';

const d = TEST_DB_URL ? describe : describe.skip;

const LAT = 54.4;
const LON0 = 16.9;
const M200_LON = 0.003086; // ≈200 m of longitude at this latitude

/** N evenly spaced [lat, lon] points — Strava's stream order — along a line. */
function latlngLine(
  a: [number, number],
  b: [number, number],
  n = 11
): [number, number][] {
  return Array.from({ length: n }, (_, i) => [
    a[0] + ((b[0] - a[0]) * i) / (n - 1),
    a[1] + ((b[1] - a[1]) * i) / (n - 1),
  ]);
}

const FIXTURE_LATLNG = latlngLine([LAT, LON0], [LAT, LON0 + M200_LON]);

async function seedSegment(sql: ReturnType<typeof testDb>) {
  await insertSegment(sql, {
    wayId: 1,
    wkt: `LINESTRING(${LON0} ${LAT}, ${LON0 + M200_LON} ${LAT})`,
    surface: 'unpaved',
  });
}

let nextId = 1;
function activity(overrides: Partial<SummaryActivity> = {}): SummaryActivity {
  const id = nextId++;
  return {
    id,
    name: `Activity ${id}`,
    sport_type: 'Ride',
    start_date: '2026-06-01T10:00:00.000Z',
    distance: 20000,
    total_elevation_gain: 100,
    ...overrides,
  };
}

// Mock factory is hoisted above these imports by Vitest, so it can't close
// over anything declared above it — build fresh vi.fn()s with harmless
// defaults; individual tests override behavior via vi.mocked(...).
vi.mock('@/lib/strava', () => ({
  RATE_LIMITED: new Error('strava_rate_limited'),
  PER_PAGE: 50,
  getValidToken: vi.fn(async () => 'test-token'),
  fetchActivities: vi.fn(async () => []),
  fetchStreams: vi.fn(async () => ({})),
}));

d('POST /api/sync', () => {
  const sql = testDb();
  let strava: typeof import('@/lib/strava');
  let POST: () => Promise<Response>;

  beforeEach(async () => {
    await resetDb(sql);
    // resetDb()'s TRUNCATE list doesn't include strava_tokens (see
    // tests/helpers/db.ts), so the single-row token/cursor state carries
    // over between tests unless we reset it here ourselves.
    await sql`
      INSERT INTO strava_tokens (id, access_token, refresh_token, expires_at, sync_cursor)
      VALUES (1, 'test-at', 'test-rt', now() + interval '1 hour', 0)
      ON CONFLICT (id) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_at = EXCLUDED.expires_at,
        sync_cursor = 0`;

    // Fresh module registry so the route's `import sql from '@/lib/db'`
    // resolves to a newly-evaluated instance (mirrors tests/stats.test.ts's
    // dynamic-import technique). Note this does NOT give us fresh vi.fn()s
    // for '@/lib/strava' — Vitest keeps mocked modules' mock instances
    // alive across resetModules() within a file, so any `mockResolvedValueOnce`
    // a previous test didn't fully drain (e.g. because the route's paging
    // loop stopped early) would otherwise leak into this test. mockReset()
    // below clears both the queued "once" values and any persistent
    // implementation before we set this test's defaults.
    vi.resetModules();
    strava = await import('@/lib/strava');
    vi.mocked(strava.getValidToken).mockReset().mockResolvedValue('test-token');
    vi.mocked(strava.fetchActivities).mockReset().mockResolvedValue([]);
    vi.mocked(strava.fetchStreams).mockReset().mockResolvedValue({});
    ({ POST } = await import('@/app/api/sync/route'));
  });

  afterAll(async () => { await sql.end(); });

  it('imports one activity with GPS covering a fixture segment', async () => {
    await seedSegment(sql);
    const a = activity();
    vi.mocked(strava.fetchActivities).mockResolvedValueOnce([a]);
    vi.mocked(strava.fetchStreams).mockResolvedValueOnce({ latlng: { data: FIXTURE_LATLNG } });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ imported: 1, skipped: 0, more: false });

    const [ride] = await sql`SELECT status, xp FROM rides WHERE strava_activity_id = ${a.id}`;
    expect(ride.status).toBe('imported');
    expect(ride.xp).toBeGreaterThan(0);

    const [{ n: claimCount }] = await sql`SELECT COUNT(*)::int AS n FROM claims`;
    expect(claimCount).toBeGreaterThan(0);
  });

  it('skips an activity with no GPS streams', async () => {
    const a = activity();
    vi.mocked(strava.fetchActivities).mockResolvedValueOnce([a]);
    vi.mocked(strava.fetchStreams).mockResolvedValueOnce({});

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ imported: 0, skipped: 1, more: false });

    const [ride] = await sql`SELECT status FROM rides WHERE strava_activity_id = ${a.id}`;
    expect(ride.status).toBe('skipped_no_gps');
  });

  it('advances the cursor past a full page of non-importable activities instead of stalling', async () => {
    await seedSegment(sql);

    // A full (PER_PAGE=50) page of runs imports nothing — under the old
    // rides-watermark-only logic this made `after` never move, permanently
    // blocking every gravel ride behind it.
    const runPage = Array.from({ length: 50 }, (_, i) =>
      activity({
        sport_type: 'Run',
        start_date: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      })
    );
    const gravelRide = activity({ start_date: new Date(Date.UTC(2026, 0, 2)).toISOString() });

    vi.mocked(strava.fetchActivities)
      .mockResolvedValueOnce(runPage)
      .mockResolvedValueOnce([gravelRide])
      .mockResolvedValueOnce([]); // safety net if the route pages further than needed
    vi.mocked(strava.fetchStreams).mockResolvedValueOnce({ latlng: { data: FIXTURE_LATLNG } });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.more).toBe(false); // loop terminates once it catches up

    const [ride] = await sql`SELECT status FROM rides WHERE strava_activity_id = ${gravelRide.id}`;
    expect(ride.status).toBe('imported');

    // The cursor must have moved past the run page — this is the actual
    // regression guard: without it, a future sync would re-fetch the same
    // stalled page forever.
    const [{ sync_cursor: cursor }] = await sql`SELECT sync_cursor::bigint AS sync_cursor FROM strava_tokens WHERE id = 1`;
    expect(Number(cursor)).toBeGreaterThan(0);
  });

  it('isolates a per-activity failure: one activity errors, the next still imports', async () => {
    await seedSegment(sql);
    const bad = activity();
    const good = activity();
    vi.mocked(strava.fetchActivities).mockResolvedValueOnce([bad, good]);
    vi.mocked(strava.fetchStreams).mockImplementation(async (_token: string, id: number) => {
      if (id === bad.id) throw new Error('boom: stream fetch failed');
      return { latlng: { data: FIXTURE_LATLNG } };
    });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.skipped).toBe(0);

    const [goodRide] = await sql`SELECT status FROM rides WHERE strava_activity_id = ${good.id}`;
    expect(goodRide.status).toBe('imported');

    const badRides = await sql`SELECT 1 FROM rides WHERE strava_activity_id = ${bad.id}`;
    expect(badRides.length).toBe(0); // never inserted — fetchStreams threw before any INSERT
  });

  it('returns 429 with rateLimited:true when Strava rate-limits activity listing', async () => {
    vi.mocked(strava.fetchActivities).mockRejectedValueOnce(strava.RATE_LIMITED);

    const res = await POST();
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ rateLimited: true });
  });

  it('does not lose todo activities behind the cursor when a later page rate-limits before import', async () => {
    await seedSegment(sql);

    // A full (PER_PAGE=50) page: 48 non-importable runs plus 2 importable
    // rides — not enough to hit BATCH(5), so under the old buggy logic the
    // page's fullness alone was enough to persist the cursor past it,
    // before either ride was ever imported.
    const runs = Array.from({ length: 48 }, (_, i) =>
      activity({
        sport_type: 'Run',
        start_date: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      })
    );
    const rideX = activity({ start_date: new Date(Date.UTC(2026, 0, 1, 1, 0)).toISOString() });
    const rideY = activity({ start_date: new Date(Date.UTC(2026, 0, 1, 1, 1)).toISOString() });
    const page1 = [...runs, rideX, rideY];
    expect(page1.length).toBe(50);

    vi.mocked(strava.fetchActivities)
      .mockResolvedValueOnce(page1)
      .mockRejectedValueOnce(strava.RATE_LIMITED); // page 2 fetch dies

    const res1 = await POST();
    expect(res1.status).toBe(429);
    const body1 = await res1.json();
    expect(body1).toEqual({ rateLimited: true });

    // Neither ride was imported...
    const rows1 = await sql`
      SELECT 1 FROM rides WHERE strava_activity_id IN (${rideX.id}, ${rideY.id})`;
    expect(rows1.length).toBe(0);
    // ...and critically, the cursor must not have advanced past them, or a
    // future sync would never see them again.
    const [{ sync_cursor: cursorAfterFirst }] =
      await sql`SELECT sync_cursor::bigint AS sync_cursor FROM strava_tokens WHERE id = 1`;
    expect(Number(cursorAfterFirst)).toBe(0);

    // Second request, fresh mocks: the same two importable rides come back
    // (as they would from Strava, since the cursor never moved past them),
    // followed by a short/empty page to end paging. Both must import.
    vi.mocked(strava.fetchActivities).mockReset();
    vi.mocked(strava.fetchActivities)
      .mockResolvedValueOnce([rideX, rideY])
      .mockResolvedValueOnce([]);
    vi.mocked(strava.fetchStreams).mockReset()
      .mockResolvedValue({ latlng: { data: FIXTURE_LATLNG } });

    const res2 = await POST();
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.imported).toBe(2);

    const rows2 = await sql`
      SELECT status FROM rides WHERE strava_activity_id IN (${rideX.id}, ${rideY.id})`;
    expect(rows2.length).toBe(2);
    expect(rows2.every((r) => r.status === 'imported')).toBe(true);
  });
});
