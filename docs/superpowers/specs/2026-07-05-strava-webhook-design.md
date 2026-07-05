# Strava Webhook Auto-Import — Design Spec

**Date:** 2026-07-05
**Status:** Approved design, pending implementation plan
**Extends:** `2026-07-02-gravel-atlas-design.md` (v1.5 backlog item)

## What it is

Rides appear in Gravel Atlas automatically minutes after finishing, without tapping **Sync rides**. Strava pushes an event to a webhook endpoint; the endpoint triggers the existing sync pipeline. The manual Sync button remains as a fallback.

## Goals & non-goals

**Goals**
- Zero-touch import: finish ride → Strava uploads → map paints within minutes.
- Reuse the existing sync pipeline unchanged (idempotency, cursor, rate-limit handling).
- No new attack surface: the webhook payload is never trusted as data.

**Non-goals**
- No reaction to activity updates or deletes (`aspect_type` ≠ `create` is ACKed and ignored). Decision: paint is permanent ("once claimed, always claimed"); deleted Strava rides keep their XP and claims.
- No multi-athlete support (single-user app; events for unknown athletes are ignored by the sync's own token scoping).
- No retry queue: a missed event self-heals on the next event or manual sync, because sync always works from the watermark, not the event.

## How Strava webhooks work (constraints we design around)

- One push subscription per API application. Managed via `POST/GET/DELETE https://www.strava.com/api/v3/push_subscriptions` with `client_id` + `client_secret`.
- On subscription creation, Strava sends `GET <callback_url>?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>`; the endpoint must respond 200 with JSON `{"hub.challenge": "<challenge>"}` within 2 seconds.
- Events arrive as `POST <callback_url>` with JSON `{object_type, object_id, aspect_type, owner_id, subscription_id, event_time, updates}`. The endpoint must respond 200 within 2 seconds; repeated failures get the subscription disabled.
- Events carry no signature — they are not authenticated. Hence the doorbell principle below.

## Design

### The doorbell principle
The webhook event payload is used ONLY as a trigger signal. On a valid-shaped `create` event for an `activity`, the endpoint runs the same sync routine the manual button uses (fetch new activities after watermark/cursor → import → match → score). The payload's `object_id` is not fetched directly, not stored, and not trusted. A forged POST triggers the same sync loop against the Strava API using our own token — no data injection is possible; see Security for how repeated spam is bounded.

### Components

1. **`lib/syncRunner.ts`** — extract the body of `POST /api/sync` into `runSync(): Promise<{imported: number; skipped: number; more: boolean} | {rateLimited: true}>`. Pure refactor; `app/api/sync/route.ts` becomes a thin wrapper (auth stays with the route; response shape unchanged; `RATE_LIMITED` maps to HTTP 429 in the route as today). The webhook calls `runSync()` in a loop while `more` is true, stopping on `rateLimited` (next event or manual sync resumes).

2. **`app/api/strava/webhook/route.ts`**
   - `GET`: subscription validation. If `hub.verify_token` equals env `STRAVA_VERIFY_TOKEN` (and `hub.mode=subscribe`), respond `{"hub.challenge": <challenge>}`; otherwise 401. Constant-time comparison reusing `lib/authToken.ts` helpers.
   - `POST`: parse JSON body; if `object_type === 'activity' && aspect_type === 'create'`, schedule `runSyncLoop()` via `waitUntil` (from `@vercel/functions`; falls back to fire-and-forget locally) and immediately return 200 `{}`. All other bodies (updates, deletes, athlete events, malformed JSON): 200 `{}` with no action. Never returns non-200 for parseable requests — protects the subscription from being disabled.
   - Runtime: Node (default), `maxDuration = 60` for the background sync.

3. **`scripts/strava-webhook.ts`** — CLI run locally with `.env.local`: `npm run webhook:create` / `webhook:view` / `webhook:delete`. `create` posts callback_url = `${APP_URL}/api/strava/webhook` and `verify_token = STRAVA_VERIFY_TOKEN`, then prints the subscription id. `view` lists the current subscription; `delete` removes it by id.

4. **`proxy.ts`** — add `api/strava/webhook(?:/|$)` to the matcher's exclusions (segment-anchored, same style as login), since Strava calls without the app-lock cookie.

5. **Env:** new `STRAVA_VERIFY_TOKEN` (random hex string) in `.env.example`, `.env.local`, and Vercel production env.

### Data flow
Strava event → `POST /api/strava/webhook` → 200 ACK → (background) `runSync()` loop → existing import/match/score path → map + character sheet update on next page load.

## Error handling
- Webhook POST always ACKs 200 for parseable requests, even when the background sync later fails — sync failures surface in the ride log exactly as today.
- Rate limiting mid-backfill: `runSync` returns `rateLimited`; the loop stops silently. Recovery is automatic (next event or manual sync resumes from watermark/cursor).
- Malformed JSON body: 200 with no action (Strava is the only intended caller; anything else is noise).
- Validation GET with wrong/missing verify token: 401 (this is pre-subscription, so no disable risk).
- `waitUntil` unavailability (local dev): the sync promise is started without awaiting; acceptable for dev.

## Security
- Endpoint is public (excluded from app lock) but: GET requires the verify token (and `hub.mode=subscribe`); POST triggers only an API poll with our own credentials and never ingests payload data (doorbell principle). `STRAVA_VERIFY_TOKEN` never appears in responses.
- A forged POST starts a sync loop (bounded by the single-flight lease + the 45s background time budget); repeated spam can at worst burn Strava API quota, which self-heals in 15 minutes (Strava's rate-limit window).

## Testing
- Unit tests (`tests/webhook.test.ts`, mocked `lib/syncRunner`): GET echoes challenge with correct token; GET 401s with wrong/missing token; POST `activity`/`create` → 200 and runner invoked once; POST update/delete/athlete/malformed → 200 and runner not invoked.
- Refactor regression: full existing suite (51 tests) must stay green after the `runSync` extraction — the sync-route integration tests already cover the extracted logic end-to-end.
- Manual at deploy: `npm run webhook:create` against production, confirm validation handshake succeeds and a real ride (or a Strava "test event") triggers auto-import.

## Decisions log
- Deletes/updates ignored — paint is permanent (user choice, Option A).
- Doorbell principle — event payload never trusted or stored.
- Sync loop runs post-ACK via Vercel `waitUntil`; no queue infrastructure (YAGNI for one rider).
- Manual Sync button retained as fallback.
- Single-flight lease (`strava_tokens.sync_lock_until`) serializes all sync entry points; 45s background budget under Vercel's 60s window.
