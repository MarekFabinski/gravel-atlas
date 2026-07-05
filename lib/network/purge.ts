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
