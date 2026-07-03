import { NextResponse } from 'next/server';
import sql from '@/lib/db';
import {
  getValidToken, fetchActivities, fetchStreams, RATE_LIMITED, PER_PAGE,
  type SummaryActivity,
} from '@/lib/strava';
import { latlngToLineString, isImportable } from '@/lib/sync';
import { matchRide } from '@/lib/matching';
import { rideXp } from '@/lib/game';

export const maxDuration = 60;
const BATCH = 5;
// Hard cap on how many Strava pages a single request will page through.
// Keeps worst case bounded for both the request timeout and Strava's rate
// limit — a stall of many consecutive non-importable pages just gets
// resumed on the next call instead of exhausted in one shot.
const MAX_PAGES = 5;

const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

export async function POST() {
  try {
    const token = await getValidToken(sql);
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

      if (todo.length >= BATCH) break;
      if (!lastPageFull) break;

      after = epoch(activities[activities.length - 1].start_date);
      await sql`UPDATE strava_tokens SET sync_cursor = ${after} WHERE id = 1`;
      cursorAdvanced = true;
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

    // Keep the cursor monotonic with the rides watermark it's meant to
    // complement — redundant with MAX(started_at) once rides land, but
    // harmless, and keeps GREATEST(watermark, cursor) correct either way.
    if (imported > 0) {
      const maxEpoch = Math.max(...todo.map((a) => epoch(a.start_date)));
      await sql`UPDATE strava_tokens SET sync_cursor = GREATEST(sync_cursor, ${maxEpoch}) WHERE id = 1`;
    }

    // More work remains if we truncated the batch or the last page we
    // fetched was full — but only claim so when this call made progress
    // (imported/skipped an activity, or advanced the cursor past a stalled
    // page), else the client would loop forever on a request that did
    // nothing.
    const madeProgress = imported + skipped > 0 || cursorAdvanced;
    const more = (todo.length >= BATCH || lastPageFull) && madeProgress;
    return NextResponse.json({ imported, skipped, more });
  } catch (e) {
    if (e === RATE_LIMITED) {
      return NextResponse.json({ rateLimited: true }, { status: 429 });
    }
    throw e;
  }
}
