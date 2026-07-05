import postgres from 'postgres';
import { overpass } from '../lib/network/overpass';
import { REGION } from '../lib/region';
import { purgeByWayIds, assertPlausibleIdList } from '../lib/network/purge';

const execute = process.argv.includes('--execute');

const query = `
[out:json][timeout:300];
way(around:${REGION.radiusM},${REGION.lat},${REGION.lon})["highway"="service"];
out ids;`;

// Same single-flight lease runSync() uses for its own concurrency problem
// (see lib/syncRunner.ts and migrations/003_sync_lease.sql): an atomic
// test-and-set on strava_tokens.sync_lock_until, 90s expiry. Deleting
// segments while a webhook-triggered matchRide is mid-flight can
// FK-violate/deadlock its claims insert and strand that ride 'failed'
// forever, so --execute must hold this lease across the whole delete.
// Kept local to the script rather than exported from syncRunner — the two
// call sites share nothing but this one query shape, not worth a shared
// abstraction for.
async function acquireSyncLease(sql: postgres.Sql): Promise<boolean> {
  const [lease] = await sql`
    UPDATE strava_tokens
    SET sync_lock_until = now() + interval '90 seconds'
    WHERE id = 1 AND (sync_lock_until IS NULL OR sync_lock_until < now())
    RETURNING 1`;
  return !!lease;
}

// Re-extends an already-acquired lease. A purge spanning many delete chunks
// can easily outlast the 90s window a single acquire buys.
async function extendSyncLease(sql: postgres.Sql): Promise<void> {
  await sql`UPDATE strava_tokens SET sync_lock_until = now() + interval '90 seconds' WHERE id = 1`;
}

async function releaseSyncLease(sql: postgres.Sql): Promise<void> {
  await sql`UPDATE strava_tokens SET sync_lock_until = NULL WHERE id = 1`;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const sql = postgres(url, { ssl: url.includes('localhost') ? false : 'require', max: 1 });

  console.log(`Fetching service way IDs within ${REGION.radiusM / 1000} km of ${REGION.lat},${REGION.lon}…`);
  const data = await overpass(query);
  // Overpass can return HTTP 200 with a valid-but-truncated JSON body plus a
  // `remark` field when it hit its own timeout/memory limit — the partial ID
  // list could still clear the plausibility tripwire below and silently
  // under-purge, so treat any remark as fatal.
  if (data.remark) throw new Error(`overpass returned a partial/aborted result: ${data.remark}`);
  const ids: number[] = (data.elements ?? [])
    .filter((e: { type: string }) => e.type === 'way')
    .map((e: { id: number }) => e.id);
  console.log(`${ids.length} service ways in the region (OSM)`);
  assertPlausibleIdList(ids);

  let leaseHeld = false;
  try {
    if (execute) {
      // A fresh DB that has never connected Strava has no strava_tokens row
      // at all — nothing can be mid-sync, so there's nothing to lease.
      const [tokenRow] = await sql`SELECT 1 FROM strava_tokens WHERE id = 1`;
      if (tokenRow) {
        leaseHeld = await acquireSyncLease(sql);
        if (!leaseHeld) {
          throw new Error('a sync is currently running — retry in a minute or two');
        }
      }
    }

    const report = await purgeByWayIds(sql, ids, execute, leaseHeld ? () => extendSyncLease(sql) : undefined);
    console.log(`In this database: ${report.segments} segments across ${report.waysWithSegments} ways, ` +
      `${report.km.toFixed(0)} km, ${report.claimed} claimed`);

    if (!execute) {
      console.log('DRY RUN — nothing deleted. Re-run with --execute to purge.');
    } else {
      console.log(`deleted ${report.deletedSegments} segments; pre-count was ${report.segments}`);
      const [after] = await sql`
        SELECT COUNT(*)::int AS segments, COALESCE(SUM(length_m), 0)::float / 1000 AS km FROM segments`;
      const [comp] = await sql`
        SELECT COALESCE(SUM(s.length_m) FILTER (WHERE c.segment_id IS NOT NULL), 0)
               / NULLIF(SUM(s.length_m), 0) * 100 AS pct
        FROM segments s LEFT JOIN claims c ON c.segment_id = s.id`;
      console.log(`Purged. Board now: ${after.segments} segments, ${after.km.toFixed(0)} km; ` +
        `completion ${Number(comp.pct ?? 0).toFixed(2)}%`);
    }
  } finally {
    // Only the caller that actually acquired the lease may clear it.
    if (leaseHeld) await releaseSyncLease(sql);
  }
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
