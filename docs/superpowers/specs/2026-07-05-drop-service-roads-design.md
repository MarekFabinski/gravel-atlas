# Drop Service Roads from the Game Board — Design Spec

**Date:** 2026-07-05
**Status:** Approved design, pending implementation plan
**Extends:** `2026-07-02-gravel-atlas-design.md` (game-board calibration, post-v1 backlog item)

## What it is

OSM `highway=service` ways (driveways, parking aisles, alleys) are removed from the Gravel Atlas game board: excluded from all future imports, and purged — including any already claimed — from the existing local and production databases. The board becomes smaller and more meaningful: every grey segment is a real road worth riding, and completion % moves faster.

## Why

The v1 board is 81,940 segments / ~15,522 km, diluted by service ways that are mostly private driveways and parking lots. This makes headline completion glacial and litters the map with unclaimable-in-spirit segments. Flagged in the v1 final review as a calibration issue; user opted to drop `service` entirely.

## Decisions

- **Clean sweep (user choice, Option A):** claimed service segments are deleted too. The board stays 100% consistent. Banked ride XP is untouched (stored on `rides.xp`); Explorer count (= COUNT of claims) drops by the cascaded claims; completion % recomputes on both sides of the fraction.
- **All `highway=service` goes** — no sub-tag carve-outs (`service=driveway` vs. through-roads). Simplicity beats edge-case connectors; re-adding later is a re-import away.
- **No `highway` column added to the schema (YAGNI):** the DB cannot identify service segments by itself; the purge fetches service **way-IDs** from Overpass instead. Future tuning can reuse the same approach.

## Design

### 1. Importer exclusion (permanent)
Remove `service` from the `HIGHWAYS` regex in `scripts/import-network.ts`. Future imports (board refreshes, new regions) never load service ways again. The rideable set becomes: `track|path|bridleway|unclassified|tertiary|secondary|residential|cycleway|living_street`.

### 2. One-time purge script
`scripts/purge-service-roads.ts`, run via `npm run purge:service` (tsx, `--env-file=.env.local`, `DATABASE_URL` overridable per target DB — same convention as the importer):

1. Query Overpass for service way-IDs only, within the configured region:
   `way(around:R,LAT,LON)["highway"="service"]; out ids;` (reuses the importer's mirror-fallback + User-Agent fetch pattern; extract the shared `overpass()` helper into `lib/network/overpass.ts` rather than copy-pasting it).
2. Report, always: how many of those way-IDs have segments in the DB, segment count, total km, and how many are claimed.
3. **Dry-run by default** — deletes ONLY when invoked with `--execute`. Deletion is `DELETE FROM segments WHERE osm_way_id = ANY(<ids>)`, chunked (10k IDs per statement); `claims` rows cascade via the existing `ON DELETE CASCADE` FK.
4. Print after-state: segment/km totals, new overall completion %.

### Rollout order
1. Land code (importer exclusion + purge script + tests) on main.
2. Local DB: dry run → review numbers → `--execute` → spot-check map at localhost.
3. Production (Neon): dry run → `--execute`. Data-only; no deploy required for the purge itself (the importer change ships with the normal auto-deploy but affects nothing until a future import).

## Effects (observable)

- `/api/segments` payload and map render shrink by the purged share.
- Overall and per-gmina completion % increase (both numerator and denominator shrink; denominator shrinks more for typical riders).
- Explorer stat drops by the number of cascaded claims; XP, level, Grit, Climber, ride log: unchanged.
- Future rides can no longer claim service segments (they're simply absent).

## Error handling

- Overpass failure: same mirror-fallback as the importer; hard fail (no partial ID list is ever used for deletion — the script aborts unless the Overpass response is complete and parsed).
- Empty/implausible ID list (< 100 ways): abort with a warning even under `--execute` (a truncated response must never trigger a mass delete of the wrong rows — and a real region this rural still has thousands of service ways).
- The DELETE runs in a single transaction per chunk; an interrupted run is resumable (re-run deletes the remainder; already-deleted IDs simply match nothing).

## Testing

- DB-gated integration test for the purge's core (deletion function extracted from the CLI): fixture board with service and non-service segments plus a claim on a service segment → deleting with an injected ID list removes exactly the service segments, cascades the claim, spares everything else; dry-run mode deletes nothing.
- Unit test for the abort guard (implausibly small ID list → refuses to execute).
- Manual: dry-run output reviewed on both DBs before `--execute` (the numbers are the acceptance test).
