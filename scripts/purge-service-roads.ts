import postgres from 'postgres';
import { overpass } from '../lib/network/overpass';
import { REGION } from '../lib/region';
import { purgeByWayIds, assertPlausibleIdList } from '../lib/network/purge';

const execute = process.argv.includes('--execute');

const query = `
[out:json][timeout:300];
way(around:${REGION.radiusM},${REGION.lat},${REGION.lon})["highway"="service"];
out ids;`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const sql = postgres(url, { ssl: url.includes('localhost') ? false : 'require', max: 1 });

  console.log(`Fetching service way IDs within ${REGION.radiusM / 1000} km of ${REGION.lat},${REGION.lon}…`);
  const data = await overpass(query);
  const ids: number[] = (data.elements ?? [])
    .filter((e: { type: string }) => e.type === 'way')
    .map((e: { id: number }) => e.id);
  console.log(`${ids.length} service ways in the region (OSM)`);
  assertPlausibleIdList(ids);

  const report = await purgeByWayIds(sql, ids, execute);
  console.log(`In this database: ${report.segments} segments across ${report.waysWithSegments} ways, ` +
    `${report.km.toFixed(0)} km, ${report.claimed} claimed`);

  if (!execute) {
    console.log('DRY RUN — nothing deleted. Re-run with --execute to purge.');
  } else {
    const [after] = await sql`
      SELECT COUNT(*)::int AS segments, COALESCE(SUM(length_m), 0)::float / 1000 AS km FROM segments`;
    const [comp] = await sql`
      SELECT COALESCE(SUM(s.length_m) FILTER (WHERE c.segment_id IS NOT NULL), 0)
             / NULLIF(SUM(s.length_m), 0) * 100 AS pct
      FROM segments s LEFT JOIN claims c ON c.segment_id = s.id`;
    console.log(`Purged. Board now: ${after.segments} segments, ${after.km.toFixed(0)} km; ` +
      `completion ${Number(comp.pct ?? 0).toFixed(2)}%`);
  }
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
