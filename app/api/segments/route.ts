import { NextResponse } from 'next/server';
import sql from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [row] = await sql`
    SELECT jsonb_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(jsonb_agg(f), '[]'::jsonb)
    ) AS fc
    FROM (
      SELECT jsonb_build_object(
        'type', 'Feature',
        'geometry', ST_AsGeoJSON(ST_Simplify(s.geom, 0.00005), 6)::jsonb,
        'properties', jsonb_build_object(
          'id', s.id,
          'claimed', c.segment_id IS NOT NULL,
          'surface', s.surface_class,
          'name', s.name,
          'length_m', ROUND(s.length_m)
        )
      ) AS f
      FROM segments s LEFT JOIN claims c ON c.segment_id = s.id
    ) sub`;
  return NextResponse.json(row.fc);
}
