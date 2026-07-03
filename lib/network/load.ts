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
