# Gravel Atlas — Design Spec

**Date:** 2026-07-02
**Status:** Approved design, pending implementation plan
**Working title:** Gravel Atlas (name open to change)

## What it is

A personal, single-user web app that gamifies gravel cycling around Reblino (Pomerania, Poland). Rides recorded in Strava are imported and matched against the real road network; every road segment ridden gets "painted" on a map. Exploration feeds an RPG-style character sheet (XP, levels, titles, four stats). The core motivation loop: unridden roads are grey, and grey roads itch.

## Goals & non-goals

**Goals**
- Make exploring new gravel roads intrinsically rewarding (map completion).
- Reflect the rider's actual riding personality via stats (RPG-as-mirror).
- Zero friction after setup: ride with Strava as usual, then glance at the app.
- Run free forever on hosted free tiers; usable from phone and laptop.

**Non-goals (v1)**
- No social/sharing features; single user only.
- No live/mid-ride features; the app is a pre-ride planner and post-ride reward.
- No native mobile app; mobile-friendly web app pinned to home screen.

## The game

### Game board
- All rideable roads and tracks within **50 km of Reblino**, sourced from OpenStreetMap: gravel, forest tracks, farm lanes, quiet asphalt. Excluded: motorways, trunk roads, and ways where bicycles are not permitted.
- Ways are split into **segments at intersections** (estimated a few thousand to ~15k segments). Each segment is **grey (unclaimed)** or **painted (claimed)**.
- Fixed region for v1; the design must not preclude adding more regions later (v2).

### Claiming rule
A segment is claimed when **≥70% of its length lies within a 20 m buffer** of a ride's GPS track. Rationale: forgiving of GPS drift under forest canopy, strict enough that passing a junction does not claim the side road. Thresholds are configuration values, tunable after real-world testing.

### Completion
- Headline: **overall completion %** (by segment length, not count).
- Sub-goals: completion per **gmina** (Słupsk, Kobylnica, Sławno, ...), derived from OSM administrative boundaries.

### XP economy
- Small XP per km ridden (re-rides pay a little).
- Large XP for each **first-time segment**, scaled by segment length. Exploration pays roughly **5–10×** re-riding. Exact constants tuned during implementation.

### Character sheet
Level derives from total XP. Levels unlock **titles** with local flavor ("Wanderer of Reblino" → "Słupia Valley Scout" → "Pomeranian Pathfinder" → ...). Four stats, each fed by ride data, displayed as a spider chart:

| Stat | Fed by |
|------|--------|
| Explorer | New segments claimed |
| Endurance | Distance; bonus for long single rides |
| Grit | Kilometers on unpaved/rough surfaces (from OSM `surface`/`highway` tags) |
| Climber | Elevation gained |

### v2 (designed-for, not built)
Quests ("claim 10 segments in Damnica forest"), bounty segments (double XP), additional regions, weather-based Grit bonuses, live "near unclaimed road" alerts.

## Architecture

### Stack
- **Next.js** (React + API routes, one project), deployed on **Vercel** free tier.
- **Neon Postgres** free tier with **PostGIS** for all spatial queries.
- **MapLibre GL** for map rendering with a free OSM-based basemap.

### Components

1. **Road network importer** (setup script, re-runnable)
   - Fetches rideable ways within 50 km of Reblino from OSM (Overpass API or a Geofabrik extract processed locally).
   - Splits ways at intersections into segments; stores geometry, length, surface classification, and gmina.
   - Idempotent: re-running refreshes the network without losing claim history (segments matched by stable OSM way id + geometry).

2. **Strava integration**
   - OAuth authorization code flow; tokens stored server-side and auto-refreshed. Free Strava account suffices; personal (unapproved) API app is limited to the owner — exactly our case.
   - v1: manual **Sync** button fetches new activities and their GPS streams (`latlng`, `altitude`).
   - v1.5: Strava **webhook** for automatic import.
   - First sync **backfills all historical rides** that touch the region.

3. **Matching engine**
   - Per ride: build 20 m buffer of the track (PostGIS `ST_Buffer`/`ST_Intersection`), claim every segment with ≥70% length coverage; record ride id and claim date per segment.
   - Computes ride contributions: distance → Endurance, unpaved km (via claimed/overlapped segment surfaces) → Grit, elevation gain → Climber, new segments → Explorer + XP.
   - Idempotent per ride: re-importing an activity never double-counts.

4. **Web app** — three screens
   - **Map**: painted vs. grey segments, overall + per-gmina completion, tap segment for details (name, surface, length, when claimed). Filter: unpaved only.
   - **Character sheet**: level, title, XP progress bar, four-stat spider chart, recent gains.
   - **Ride log**: per ride — date, distance, new segments, XP earned.

### Data flow
Strava → sync job → PostGIS matching → claims + stat/XP updates → map & character sheet read from Postgres.

### Data model (core tables)
- `segments` — id, osm_way_id, geometry (LineString), length_m, surface_class (paved/unpaved/unknown), gmina, name.
- `rides` — id, strava_activity_id (unique), date, distance_m, elevation_m, track geometry, raw stream reference.
- `claims` — segment_id, ride_id, claimed_at (first claim only; re-rides logged in ride stats, not claims).
- `stats` — single-row (or event-sourced from rides) totals: XP, per-stat values.
- `strava_tokens` — access/refresh token, expiry.

## Error handling
- Activities without GPS streams (trainer rides) are skipped with a visible note in the ride log.
- Imports are idempotent keyed on `strava_activity_id`.
- Strava rate limits: exponential backoff; sync resumes where it left off (matters mainly for the historical backfill).
- A matching failure on one ride is logged and skipped; it never blocks other rides.
- OSM import validates: no zero-length segments, no orphan geometry, plausible segment count.

## Testing
- **Matching engine**: unit tests with synthetic GPS tracks against a small fixture network — exact claim/no-claim assertions (drift tolerance, junction passing, partial coverage at the 70% boundary).
- **Importer**: sanity checks on segment counts and geometry validity for a small fixture extract.
- **XP/stats**: unit tests for the economy math.
- UI: lightweight; manual verification.

## Decisions log
- Input source: Strava only (free account, personal API app). No in-app GPS recording.
- Claim unit: road segments (not grid tiles).
- Region: fixed 50 km around Reblino; expansion is v2.
- Hosting: Vercel + Neon free tiers.
- Backfill history on first sync: yes.
- UI language: English.
- Single user; no auth beyond Strava connect + a simple app lock (e.g., single-user password or Vercel protection) — implementation detail.

## v1 build order
1. Project setup: repo, Next.js, Neon + PostGIS, Vercel deploy skeleton.
2. Road network importer — game board visible on the map, all grey.
3. Strava OAuth + manual Sync.
4. Matching engine + unit tests — rides paint segments.
5. Map screen with completion % (overall + per gmina).
6. XP, levels, titles, stats, character sheet.
7. Ride log.

v1.5: webhook auto-import, map filters, segment details polish.
