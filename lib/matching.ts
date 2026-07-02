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
