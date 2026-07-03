import postgres from 'postgres';
import osmtogeojson from 'osmtogeojson';
import { REGION } from '../lib/region';
import { splitWays, type OsmNode, type OsmWay } from '../lib/network/split';
import { loadSegments } from '../lib/network/load';

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const HIGHWAYS =
  'track|path|bridleway|unclassified|tertiary|secondary|residential|service|cycleway|living_street';

const roadsQuery = `
[out:json][timeout:300];
way(around:${REGION.radiusM},${REGION.lat},${REGION.lon})
  ["highway"~"^(${HIGHWAYS})$"]
  ["access"!~"^(private|no)$"]
  ["bicycle"!~"^(no|private)$"];
(._;>;);
out body;`;

const gminasQuery = `
[out:json][timeout:300];
relation["boundary"="administrative"]["admin_level"="7"]
  (around:${REGION.radiusM},${REGION.lat},${REGION.lon});
out body geom;`;

async function overpass(query: string): Promise<any> {
  let lastError: unknown;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Overpass rejects requests without a descriptive User-Agent (406);
          // Node's fetch sends none by default.
          'User-Agent': 'gravel-atlas-import/1.0 (mafabinski@gmail.com)',
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) throw new Error(`overpass ${url}: ${res.status}`);
      return await res.json();
    } catch (e) {
      lastError = e;
      console.warn(`overpass mirror failed, trying next: ${e}`);
    }
  }
  throw lastError;
}

async function main() {
  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, { ssl: url.includes('localhost') ? false : 'require', max: 1 });

  console.log(`Fetching roads within ${REGION.radiusM / 1000} km of ${REGION.lat},${REGION.lon}…`);
  const roads = await overpass(roadsQuery);
  const nodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  for (const el of roads.elements) {
    if (el.type === 'node') nodes.set(el.id, { id: el.id, lat: el.lat, lon: el.lon });
    else if (el.type === 'way') ways.push({ id: el.id, nodes: el.nodes, tags: el.tags ?? {} });
  }
  const segments = splitWays(ways, nodes);
  console.log(`${ways.length} ways → ${segments.length} segments; loading…`);
  await loadSegments(sql, segments);
  await sql`DELETE FROM segments
            WHERE length_m < 5 AND id NOT IN (SELECT segment_id FROM claims)`;

  console.log('Fetching gmina boundaries…');
  const gj = osmtogeojson(await overpass(gminasQuery));
  for (const f of gj.features) {
    const name = f.properties?.name;
    const geomType = f.geometry?.type;
    if (!name || (geomType !== 'Polygon' && geomType !== 'MultiPolygon')) continue;
    await sql`
      INSERT INTO gminas (name, geom)
      VALUES (${name}, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(f.geometry)}), 4326)))
      ON CONFLICT (name) DO UPDATE SET geom = EXCLUDED.geom`;
  }
  await sql`
    UPDATE segments s SET gmina = g.name
    FROM gminas g
    WHERE ST_Intersects(g.geom, ST_LineInterpolatePoint(s.geom, 0.5))`;

  // Sanity checks
  const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM segments`;
  if (n < 500) console.warn(`⚠️ only ${n} segments — check region/query`);
  if (n > 100000) console.warn(`⚠️ ${n} segments — suspiciously many`);
  const surfaces = await sql`
    SELECT surface_class, COUNT(*)::int AS segments, ROUND(SUM(length_m) / 1000)::int AS km
    FROM segments GROUP BY 1 ORDER BY 1`;
  console.table(surfaces.map((r) => ({ ...r })));
  const gminas = await sql`
    SELECT COALESCE(gmina, '(none)') AS gmina, COUNT(*)::int AS segments
    FROM segments GROUP BY 1 ORDER BY 2 DESC`;
  console.table(gminas.map((r) => ({ ...r })));
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
