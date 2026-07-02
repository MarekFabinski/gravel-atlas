import postgres from 'postgres';
import { runMigrations } from '@/lib/migrate';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;

export function testDb(): postgres.Sql {
  // Vitest evaluates describe.skip(...) factory bodies even though the
  // contained tests never run, so testDb() gets called during skipped
  // suites too. It must never throw here: when TEST_DATABASE_URL is unset,
  // return a harmless client instead. The `postgres` library connects
  // lazily, so this never opens a real connection, and skipped suites
  // never issue a query against it.
  if (!TEST_DB_URL) return postgres('postgres://skip:skip@localhost:9/skip', { max: 1 });
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
