import { NextResponse } from 'next/server';
import sql from '@/lib/db';
import { getValidToken, fetchActivities, fetchStreams, RATE_LIMITED, PER_PAGE } from '@/lib/strava';
import { latlngToLineString, isImportable } from '@/lib/sync';
import { matchRide } from '@/lib/matching';
import { rideXp } from '@/lib/game';

export const maxDuration = 60;
const BATCH = 5;

export async function POST() {
  try {
    const token = await getValidToken(sql);
    const [{ last }] = await sql`
      SELECT COALESCE(EXTRACT(EPOCH FROM MAX(started_at))::bigint, 0) AS last FROM rides`;
    const activities = await fetchActivities(token, Number(last));

    const todo = [];
    for (const a of activities) {
      if (!isImportable(a)) continue;
      const exists = await sql`SELECT 1 FROM rides WHERE strava_activity_id = ${a.id}`;
      if (!exists.length) todo.push(a);
      if (todo.length >= BATCH) break;
    }

    let imported = 0;
    let skipped = 0;
    for (const a of todo) {
      let ride;
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
        [ride] = await sql`
          INSERT INTO rides (strava_activity_id, name, started_at, distance_m, elevation_m, track)
          VALUES (${a.id}, ${a.name}, ${a.start_date}, ${a.distance}, ${a.total_elevation_gain},
                  ST_SetSRID(ST_GeomFromGeoJSON(${track}), 4326))
          ON CONFLICT (strava_activity_id) DO NOTHING
          RETURNING id`;
        if (!ride) continue; // raced with a concurrent sync — already imported
        try {
          const m = await matchRide(sql, ride.id, track, new Date(a.start_date));
          await sql`
            UPDATE rides
            SET new_segments = ${m.newCount}, unpaved_m = ${m.unpavedM},
                xp = ${rideXp(a.distance, m.newLenM)}
            WHERE id = ${ride.id}`;
        } catch (e) {
          console.error(`matching failed for activity ${a.id}:`, e);
          await sql`UPDATE rides SET status = 'failed' WHERE id = ${ride.id}`;
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

    // More work remains if we truncated the batch or Strava's page was full —
    // but only claim so when this call made progress, else the client would loop forever.
    const more = (todo.length >= BATCH || activities.length >= PER_PAGE) && imported + skipped > 0;
    return NextResponse.json({ imported, skipped, more });
  } catch (e) {
    if (e === RATE_LIMITED) {
      return NextResponse.json({ rateLimited: true }, { status: 429 });
    }
    throw e;
  }
}
