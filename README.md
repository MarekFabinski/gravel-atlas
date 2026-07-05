# 🚵 Gravel Atlas

A personal, single-user web app that gamifies gravel cycling around Reblino, Pomerania. Rides recorded on Strava are imported and matched against the real OSM road network; every road segment you ride gets painted on the map. Exploration feeds an RPG character sheet: XP, levels, Pomeranian titles, and a four-stat radar (Explorer / Endurance / Grit / Climber).

**Production:** https://gravel-atlas-two.vercel.app (password-locked, single user)

## How it works

- **Game board:** all rideable roads/tracks within 50 km of Reblino (~58k segments, ~14,200 km), imported from OpenStreetMap and split at intersections. Service roads (driveways, parking aisles) are excluded. Grey = unridden, orange = claimed.
- **Claiming rule:** a segment is claimed when ≥70% of its length lies within a 20 m buffer of a ride's GPS track (PostGIS, EPSG:2180). First ride wins; thresholds in `lib/config.ts`.
- **XP economy:** 1 XP per km ridden + 8 XP per km of newly claimed segment length. Level `n` starts at `(n-1)² × 100` XP.
- **Stats:** Explorer = segments claimed; Endurance = km + long-ride bonus (>50 km); Grit = unpaved km; Climber = meters climbed. All rides count toward stats; only in-region segments paint the map.

## Stack

Next.js 16 (App Router) · Postgres + PostGIS (Neon in prod, Docker locally) · MapLibre GL · Strava API (OAuth, free tier) · Vitest. Hosted on Vercel (free tier).

## Local development

```bash
docker compose up -d                       # local PostGIS (gravel + gravel_test DBs)
docker compose exec db createdb -U postgres gravel_test   # first time only
cp .env.example .env.local                 # then fill in values (see below)
npm install
npm run migrate                            # apply migrations/*.sql
npm run import:network                     # load OSM road network (~5 min, Overpass)
npm run dev                                # http://localhost:3000
```

### Environment variables (`.env.local`)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection (local Docker or Neon) |
| `TEST_DATABASE_URL` | `gravel_test` DB; integration tests skip when unset |
| `APP_PASSWORD` | The app-lock password (login page) |
| `APP_URL` | Base URL for Strava OAuth redirects |
| `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` | From strava.com/settings/api |
| `STRAVA_VERIFY_TOKEN` | Webhook validation handshake secret |
| `NEXT_PUBLIC_REGION_LAT` / `NEXT_PUBLIC_REGION_LON` / `REGION_RADIUS_M` | Game-board center + radius |

### Tests

```bash
TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npm test   # full suite (72)
npm test                                                                        # unit-only (DB suites skip)
```

## Deployment runbook (Vercel + Neon)

1. **Neon:** create a free project (EU region). Migrations create the PostGIS extension automatically. From your machine:
   ```bash
   MIGRATE_DATABASE_URL='<neon-pooled-url>' npm run migrate
   DATABASE_URL='<neon-pooled-url>' npx tsx --env-file=.env.local scripts/import-network.ts
   ```
   Use the **pooled** connection string (host contains `-pooler`).
2. **Vercel:** `npx vercel login`, `npx vercel link --yes`, then set production env vars (`printf '%s' "<value>" | npx vercel env add <NAME> production` for every variable above except `TEST_DATABASE_URL`), and `npx vercel deploy --prod`. After the first deploy, set `APP_URL` to the assigned domain and redeploy.
3. **Strava:** at strava.com/settings/api set *Authorization Callback Domain* to the production domain (no scheme/path). `localhost` keeps working for dev.
4. **Connect:** open `<APP_URL>/api/strava/connect` in a logged-in browser, approve. Then tap **Sync rides** — historical backfill imports in batches; a "rate limited" pause is normal (Strava allows ~100 requests/15 min), just retry after 15 minutes and it resumes where it stopped.
5. **Webhook (auto-import):** Complete the initial Sync backfill (step 4) first — set `STRAVA_VERIFY_TOKEN` (random hex) in `.env.local` and Vercel production env, deploy, then `npm run webhook:create` with `APP_URL` pointing at production. Verify with `npm run webhook:view`. Rides now import automatically minutes after upload; the Sync button remains as fallback. `npm run webhook:delete` unsubscribes.

## Post-v1 backlog

vector tiles if the segments payload feels slow on mobile · optional exclusion of `service` roads to tighten the game board · quests, bounty segments, additional regions (spec v2).

Design docs: `docs/superpowers/specs/` (spec) and `docs/superpowers/plans/` (implementation plan).
