import sql from '@/lib/db';
import {
  getValidToken, fetchActivities, fetchStreams, RATE_LIMITED, PER_PAGE,
  type SummaryActivity,
} from '@/lib/strava';
import { latlngToLineString, isImportable } from '@/lib/sync';
import { matchRide } from '@/lib/matching';
import { rideXp } from '@/lib/game';

export type SyncOutcome = { imported: number; skipped: number; more: boolean };
export type SyncResult = SyncOutcome | { rateLimited: true };

const BATCH = 5;
// Hard cap on how many Strava pages a single request will page through.
// Keeps worst case bounded for both the request timeout and Strava's rate
// limit — a stall of many consecutive non-importable pages just gets
// resumed on the next call instead of exhausted in one shot.
const MAX_PAGES = 5;

const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

export async function runSync(): Promise<SyncResult> {
  let leaseHeld = false;
  try {
    const token = await getValidToken(sql);

    // Single-flight lease: the webhook loop and the manual Sync button (or
    // several rapid-fire webhook events) can call runSync() concurrently.
    // matchRide's multi-row claims INSERT has no deterministic ordering
    // across two overlapping transactions touching overlapping segments,
    // which is a classic recipe for a Postgres deadlock — the victim ride
    // gets stuck 'failed' forever. Session-level advisory locks would be
    // the usual fix, but Neon's pooled connection (the one this app uses)
    // is pgbouncer-style transaction-mode pooling: a session lock can be
    // taken on one physical connection and "held" by a client that later
    // gets handed a *different* connection, so it never reliably releases.
    // Instead we lease a plain row: atomically test-and-set
    // strava_tokens.sync_lock_until only if it's unset or expired. Losing
    // the race just means another sync is already in flight — deferring to
    // it is semantically perfect for a doorbell (the in-flight run will
    // pick up whatever this call would have seen anyway). A hard kill
    // (Vercel timeout, crash) self-heals once the lease expires: 90s here
    // comfortably outlasts Fix 1's 45s background budget plus one round's
    // worst-case in-flight work.
    const [lease] = await sql`
      UPDATE strava_tokens
      SET sync_lock_until = now() + interval '90 seconds'
      WHERE id = 1 AND (sync_lock_until IS NULL OR sync_lock_until < now())
      RETURNING 1`;
    if (!lease) {
      return { imported: 0, skipped: 0, more: false };
    }
    leaseHeld = true;

    const [{ last }] = await sql`
      SELECT COALESCE(EXTRACT(EPOCH FROM MAX(started_at))::bigint, 0) AS last FROM rides`;
    const [{ cursor }] = await sql`SELECT sync_cursor::bigint AS cursor FROM strava_tokens WHERE id = 1`;
    let after = Math.max(Number(last), Number(cursor));

    // Page forward through Strava's activity feed, collecting up to BATCH
    // new importable activities. A full (PER_PAGE) page that yields nothing
    // importable advances the persisted cursor past it before moving on, so
    // a wall of runs/Zwift rides can never permanently block real gravel
    // rides behind it. A short page means we've caught up to "now" — stop.
    const todo: SummaryActivity[] = [];
    let cursorAdvanced = false;
    let lastPageFull = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const activities = await fetchActivities(token, after);
      lastPageFull = activities.length >= PER_PAGE;
      if (activities.length === 0) break;

      for (const a of activities) {
        if (!isImportable(a)) continue;
        const exists = await sql`SELECT 1 FROM rides WHERE strava_activity_id = ${a.id}`;
        if (!exists.length) todo.push(a);
        if (todo.length >= BATCH) break;
      }
      // Never persist the cursor past a pending todo item. It's not enough
      // for THIS page to have contributed nothing — an earlier page in this
      // same request may have added 1-4 importable activities (not enough
      // to hit BATCH) that haven't been imported yet. If this request dies
      // before the import loop below runs (e.g. the next page fetch below
      // throws RATE_LIMITED), persisting past this page would leave those
      // earlier activities permanently behind the cursor with no trace. So
      // only persist when `todo` is empty across the whole request so far.
      // The in-memory `after` still advances so this request's own paging
      // keeps moving forward.
      const pageStalled = todo.length === 0;

      if (todo.length >= BATCH) break;
      if (!lastPageFull) break;

      after = epoch(activities[activities.length - 1].start_date);
      if (pageStalled) {
        await sql`UPDATE strava_tokens SET sync_cursor = ${after} WHERE id = 1`;
        cursorAdvanced = true;
      }
    }

    let imported = 0;
    let skipped = 0;
    for (const a of todo) {
      let ride: { id: number } | undefined;
      try {
        const streams = await fetchStreams(token, a.id);
        const latlng = streams.latlng?.data;
        if (!latlng || latlng.length < 2) {
          await sql`
            INSERT INTO rides (strava_activity_id, name, started_at, distance_m, elevation_m, status)
            VALUES (${a.id}, ${a.name}, ${a.start_date}, ${a.distance},
                    ${a.total_elevation_gain}, 'skipped_no_gps')
            ON CONFLICT (strava_activity_id) DO NOTHING`;
          skipped++;
          continue;
        }
        const track = latlngToLineString(latlng);
        [ride] = await sql<{ id: number }[]>`
          INSERT INTO rides (strava_activity_id, name, started_at, distance_m, elevation_m, track)
          VALUES (${a.id}, ${a.name}, ${a.start_date}, ${a.distance}, ${a.total_elevation_gain},
                  ST_SetSRID(ST_GeomFromGeoJSON(${track}), 4326))
          ON CONFLICT (strava_activity_id) DO NOTHING
          RETURNING id`;
        if (!ride) continue; // raced with a concurrent sync — already imported
        const rideId = ride.id; // pin a definitely-assigned value for the closure below
        try {
          // matchRide's claim inserts and the xp/segment UPDATE below must
          // land together — otherwise a failure between them could burn
          // claims (first-ride-wins) without ever crediting xp for them.
          await sql.begin(async (tx) => {
            const m = await matchRide(tx, rideId, track, new Date(a.start_date));
            await tx`
              UPDATE rides
              SET new_segments = ${m.newCount}, unpaved_m = ${m.unpavedM},
                  xp = ${rideXp(a.distance, m.newLenM)}
              WHERE id = ${rideId}`;
          });
        } catch (e) {
          console.error(`matching failed for activity ${a.id}:`, e);
          await sql`UPDATE rides SET status = 'failed' WHERE id = ${rideId}`;
        }
        imported++;
      } catch (e) {
        if (e === RATE_LIMITED) throw e;
        console.error(`sync failed for activity ${a.id}:`, e);
        if (ride) {
          await sql`UPDATE rides SET status = 'failed' WHERE id = ${ride.id}`;
        }
        continue;
      }
    }

    // No post-import cursor bump: todo-bearing pages progress via the rides
    // watermark (MAX(started_at), which includes skipped_no_gps rows) once
    // imports land — the cursor itself never advances past a todo-bearing
    // page (see pageStalled above). That leaves activities whose
    // fetchStreams threw transiently still retryable on the next sync,
    // since the cursor never passed them either.

    // More work remains if we truncated the batch or the last page we
    // fetched was full — but only claim so when this call made progress
    // (imported/skipped an activity, or advanced the cursor past a stalled
    // page), else the client would loop forever on a request that did
    // nothing.
    const madeProgress = imported + skipped > 0 || cursorAdvanced;
    const more = (todo.length >= BATCH || lastPageFull) && madeProgress;
    return { imported, skipped, more };
  } catch (e) {
    if (e === RATE_LIMITED) return { rateLimited: true };
    throw e;
  }
}

/**
 * Drives runSync() to completion for background (webhook) use. Stops on
 * rateLimited — the next event or manual sync resumes from the watermark/
 * cursor, so nothing is lost. Never throws: this runs post-ACK where an
 * exception would only produce a noisy unhandled rejection.
 */
export async function runSyncLoop(maxRounds = 20): Promise<void> {
  try {
    for (let round = 0; round < maxRounds; round++) {
      const result = await runSync();
      if ('rateLimited' in result) {
        console.warn('webhook sync: rate limited, stopping (will resume on next event)');
        return;
      }
      console.log(`webhook sync round ${round + 1}: imported=${result.imported} skipped=${result.skipped} more=${result.more}`);
      if (!result.more) return;
    }
    console.warn(`webhook sync: stopped after ${maxRounds} rounds with work remaining`);
  } catch (e) {
    console.error('webhook sync failed:', e);
  }
}
