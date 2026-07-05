# Strava Webhook Auto-Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rides import automatically minutes after finishing — Strava pushes an event, the app ACKs and runs the existing sync pipeline in the background.

**Architecture:** The sync loop is extracted from `app/api/sync/route.ts` into `lib/syncRunner.ts` (pure refactor). A new public webhook endpoint answers Strava's validation handshake (GET) and ACKs events (POST) within 2 seconds, scheduling the sync via Vercel `waitUntil`. The event payload is never trusted — it's only a doorbell. A CLI script manages the one-per-app push subscription.

**Tech Stack:** Next.js 16 route handlers (Node runtime), `@vercel/functions` (waitUntil), existing `lib/authToken.ts` for constant-time token comparison, Vitest with `vi.mock`.

**Spec:** `docs/superpowers/specs/2026-07-05-strava-webhook-design.md`

## Global Constraints

- **Doorbell principle:** the webhook payload is never fetched-by-id, stored, or trusted — a valid-shaped `create` event only triggers the same sync routine the manual button uses.
- Webhook POST always returns **200 for any parseable request** (including updates/deletes/athlete events/malformed JSON) — repeated non-200s get the subscription disabled by Strava. Only the pre-subscription validation GET may return 401.
- `aspect_type !== 'create'` and `object_type !== 'activity'` events are ACKed and ignored (spec decision: deletes/updates never touch data; paint is permanent).
- Validation GET verify-token comparison must be constant-time via existing `sessionToken`/`tokensMatch` from `lib/authToken.ts` (they compare arbitrary strings by HMAC-digesting both sides first).
- `runSync()` return contract: `Promise<SyncResult>` where `SyncResult = { imported: number; skipped: number; more: boolean } | { rateLimited: true }` — the runner catches the `RATE_LIMITED` sentinel internally; it never throws it.
- Behavior of `POST /api/sync` must be byte-identical after the refactor: same JSON shape, 429 mapping, batching, cursor semantics. The existing 51-test suite (esp. `tests/sync-route.test.ts`) must stay green untouched except where stated.
- New env var `STRAVA_VERIFY_TOKEN` (random hex, no default); missing/empty token → validation GET always 401 (fail closed).
- proxy.ts matcher exclusion must be segment-anchored like the existing ones: `api/strava/webhook(?:/|$)`.
- Tests must skip-not-fail without `TEST_DATABASE_URL` (webhook unit tests need no DB at all).
- Full gate for every task: `TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npx vitest run` green, `npx tsc --noEmit` clean, `npm run build` clean.

## File Structure

```
lib/syncRunner.ts                    # runSync() + runSyncLoop() — extracted sync pipeline (new)
app/api/sync/route.ts                # becomes a thin wrapper over runSync() (modify)
app/api/strava/webhook/route.ts      # GET validation + POST doorbell (new)
scripts/strava-webhook.ts            # create/view/delete push subscription CLI (new)
proxy.ts                             # matcher exclusion for the webhook path (modify)
tests/webhook.test.ts                # unit tests, mocked syncRunner, no DB (new)
.env.example                         # + STRAVA_VERIFY_TOKEN (modify)
package.json                         # + @vercel/functions dep, webhook:* scripts (modify)
README.md                            # webhook section in runbook (modify)
```

---

### Task 1: Extract the sync runner (pure refactor)

**Files:**
- Create: `lib/syncRunner.ts`
- Modify: `app/api/sync/route.ts` (replace entirely with the thin wrapper below)
- Test: existing `tests/sync-route.test.ts` must pass **unmodified** — that is the regression gate proving the refactor changed nothing observable.

**Interfaces:**
- Consumes: everything `app/api/sync/route.ts` imports today (`sql`, strava client, `latlngToLineString`/`isImportable`, `matchRide`, `rideXp`).
- Produces (Task 2 depends on these exact names):
  - `type SyncOutcome = { imported: number; skipped: number; more: boolean }`
  - `type SyncResult = SyncOutcome | { rateLimited: true }`
  - `runSync(): Promise<SyncResult>` — one batched sync pass; catches `RATE_LIMITED` internally and returns `{ rateLimited: true }`; never throws the sentinel.
  - `runSyncLoop(maxRounds?: number): Promise<void>` — calls `runSync()` until `more` is false, `rateLimited`, or `maxRounds` (default 20) reached; logs each round; never throws (catches and logs).

- [ ] **Step 1: Create `lib/syncRunner.ts`**

Move the ENTIRE body of the current `POST` handler in `app/api/sync/route.ts` (git HEAD version) into `runSync()`, with exactly these mechanical changes and nothing else:
- The function signature becomes `export async function runSync(): Promise<SyncResult>`.
- The final `return NextResponse.json({ imported, skipped, more });` becomes `return { imported, skipped, more };`.
- The outer `catch` becomes: `if (e === RATE_LIMITED) return { rateLimited: true }; throw e;`.
- The module-level constants `BATCH`, `MAX_PAGES`, `epoch`, and all comments move along with the code (comments must survive the move verbatim — they encode reviewed invariants like the `pageStalled` rule).
- `export const maxDuration = 60;` does NOT move — it stays a route-segment config (both routes declare their own).

Top of the new file:

```ts
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
```

And appended after `runSync`:

```ts
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
```

- [ ] **Step 2: Replace `app/api/sync/route.ts` with the thin wrapper**

```ts
import { NextResponse } from 'next/server';
import { runSync } from '@/lib/syncRunner';

export const maxDuration = 60;

export async function POST() {
  const result = await runSync();
  if ('rateLimited' in result) {
    return NextResponse.json({ rateLimited: true }, { status: 429 });
  }
  return NextResponse.json(result);
}
```

- [ ] **Step 3: Run the regression gate**

Run: `TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npx vitest run`
Expected: 51/51 pass — `tests/sync-route.test.ts` (which imports the route and asserts DB state, response shapes, cursor behavior, and 429 mapping) passes with ZERO modifications. If any sync-route test fails, the refactor changed behavior — fix the refactor, never the test.

Also: `npx tsc --noEmit` clean; `npm run build` clean.

- [ ] **Step 4: Commit**

```bash
git add lib/syncRunner.ts app/api/sync/route.ts
git commit -m "refactor: extract sync pipeline into lib/syncRunner for webhook reuse"
```

---

### Task 2: Webhook endpoint

**Files:**
- Create: `app/api/strava/webhook/route.ts`
- Test: `tests/webhook.test.ts`
- Modify: `package.json` (add dependency `@vercel/functions`)

**Interfaces:**
- Consumes: `runSyncLoop` from `lib/syncRunner` (Task 1); `sessionToken`, `tokensMatch` from `lib/authToken`; `waitUntil` from `@vercel/functions`.
- Produces: `GET /api/strava/webhook` (validation echo) and `POST /api/strava/webhook` (doorbell ACK). Task 3 excludes this path from the app lock; Task 4 registers it with Strava.

- [ ] **Step 1: Install the waitUntil package**

Run: `npm install @vercel/functions`

- [ ] **Step 2: Write the failing tests**

Create `tests/webhook.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The webhook must invoke the sync loop exactly once per create-event and
// never for anything else — mock the runner, no DB needed for these tests.
vi.mock('@/lib/syncRunner', () => ({
  runSyncLoop: vi.fn(async () => {}),
}));

import { runSyncLoop } from '@/lib/syncRunner';
import { GET, POST } from '@/app/api/strava/webhook/route';

const URL_BASE = 'http://test.local/api/strava/webhook';

function validationReq(params: Record<string, string>): Request {
  const qs = new URLSearchParams(params).toString();
  return new Request(`${URL_BASE}?${qs}`);
}

function eventReq(body: unknown): Request {
  return new Request(URL_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.STRAVA_VERIFY_TOKEN = 'test-verify-token';
  vi.mocked(runSyncLoop).mockClear();
});

describe('GET /api/strava/webhook (subscription validation)', () => {
  it('echoes hub.challenge for the correct verify token', async () => {
    const res = await GET(validationReq({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'test-verify-token',
      'hub.challenge': 'challenge-123',
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ 'hub.challenge': 'challenge-123' });
  });

  it('rejects a wrong verify token with 401', async () => {
    const res = await GET(validationReq({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong',
      'hub.challenge': 'challenge-123',
    }));
    expect(res.status).toBe(401);
  });

  it('rejects a missing verify token with 401', async () => {
    const res = await GET(validationReq({ 'hub.mode': 'subscribe', 'hub.challenge': 'x' }));
    expect(res.status).toBe(401);
  });

  it('fails closed when STRAVA_VERIFY_TOKEN is unset', async () => {
    delete process.env.STRAVA_VERIFY_TOKEN;
    const res = await GET(validationReq({
      'hub.mode': 'subscribe',
      'hub.verify_token': '',
      'hub.challenge': 'x',
    }));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/strava/webhook (events)', () => {
  it('ACKs an activity create event and triggers the sync loop once', async () => {
    const res = await POST(eventReq({
      object_type: 'activity', object_id: 123, aspect_type: 'create',
      owner_id: 456, subscription_id: 1, event_time: 1700000000,
    }));
    expect(res.status).toBe(200);
    expect(runSyncLoop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['activity update', { object_type: 'activity', aspect_type: 'update', updates: { title: 'x' } }],
    ['activity delete', { object_type: 'activity', aspect_type: 'delete' }],
    ['athlete event', { object_type: 'athlete', aspect_type: 'update' }],
  ])('ACKs %s without triggering sync', async (_label, body) => {
    const res = await POST(eventReq(body));
    expect(res.status).toBe(200);
    expect(runSyncLoop).not.toHaveBeenCalled();
  });

  it('ACKs malformed JSON without triggering sync', async () => {
    const res = await POST(eventReq('{not json'));
    expect(res.status).toBe(200);
    expect(runSyncLoop).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — cannot resolve `@/app/api/strava/webhook/route`.

- [ ] **Step 4: Implement the route**

Create `app/api/strava/webhook/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { runSyncLoop } from '@/lib/syncRunner';
import { sessionToken, tokensMatch } from '@/lib/authToken';

export const maxDuration = 60;

/**
 * Keeps the sync running after the 200 ACK is sent. On Vercel, waitUntil
 * extends the function's lifetime; locally (npm run dev, vitest) there is no
 * request context, so we fall back to fire-and-forget — the promise is
 * already running either way, and it never rejects (runSyncLoop catches).
 */
function scheduleBackground(work: Promise<void>) {
  try {
    waitUntil(work);
  } catch {
    // no Vercel request context (local dev/tests) — promise runs unattached
  }
}

/** Subscription validation handshake (sent by Strava once, at create time). */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const expected = process.env.STRAVA_VERIFY_TOKEN;
  const provided = params.get('hub.verify_token');
  // Fail closed on unset/missing token; constant-time compare via HMAC
  // digests (sessionToken maps arbitrary strings to fixed-length hex).
  if (!expected || provided === null ||
      !tokensMatch(sessionToken(provided), sessionToken(expected))) {
    return NextResponse.json({ error: 'verification failed' }, { status: 401 });
  }
  return NextResponse.json({ 'hub.challenge': params.get('hub.challenge') ?? '' });
}

/**
 * Event doorbell. The payload is deliberately untrusted and unstored: a
 * create-event only triggers the same sync pipeline as the manual button,
 * so a forged POST can at worst cause one poll of the Strava API. Always
 * ACK 200 — repeated non-200s would get the subscription disabled.
 */
export async function POST(req: Request) {
  let event: { object_type?: string; aspect_type?: string } = {};
  try {
    event = await req.json();
  } catch {
    // malformed body — ACK and ignore
  }
  if (event.object_type === 'activity' && event.aspect_type === 'create') {
    scheduleBackground(runSyncLoop());
  }
  return NextResponse.json({});
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/webhook.test.ts`
Expected: 9 passed.

Then the full gate: `TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npx vitest run` (now 60 tests), `npx tsc --noEmit`, `npm run build` — all clean. In the build output, `/api/strava/webhook` appears as `ƒ` (dynamic).

- [ ] **Step 6: Commit**

```bash
git add app/api/strava/webhook tests/webhook.test.ts package.json package-lock.json
git commit -m "feat: Strava webhook endpoint — validation handshake and create-event doorbell"
```

---

### Task 3: App-lock exclusion, env, subscription CLI, docs

**Files:**
- Modify: `proxy.ts` (matcher), `.env.example`, `package.json` (scripts), `README.md`
- Create: `scripts/strava-webhook.ts`

**Interfaces:**
- Consumes: env `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `APP_URL`, `STRAVA_VERIFY_TOKEN`.
- Produces: `npm run webhook:create` / `webhook:view` / `webhook:delete`; webhook path reachable without the app-lock cookie.

- [ ] **Step 1: Exclude the webhook path from the app lock**

In `proxy.ts`, change the matcher line to (segment-anchored, matching the existing style):

```ts
  matcher: ['/((?!login(?:/|$)|api/login(?:/|$)|api/strava/webhook(?:/|$)|_next|favicon.ico).*)'],
```

Update the comment above it to mention the webhook exclusion (Strava calls it without a cookie; the endpoint has its own verify-token/doorbell protections).

- [ ] **Step 2: Verify the exclusion**

Run `npm run dev`, then WITHOUT any cookie:
- `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{"object_type":"athlete","aspect_type":"update"}' http://localhost:3000/api/strava/webhook` → expected `200` (not 307).
- `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/strava/webhookx` → expected `307` (anchor works).
Kill the dev server.

- [ ] **Step 3: Subscription CLI**

Create `scripts/strava-webhook.ts`:

```ts
const BASE = 'https://www.strava.com/api/v3/push_subscriptions';

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
}

const creds = () => ({
  client_id: env('STRAVA_CLIENT_ID'),
  client_secret: env('STRAVA_CLIENT_SECRET'),
});

async function view(): Promise<{ id: number; callback_url: string }[]> {
  const qs = new URLSearchParams(creds());
  const res = await fetch(`${BASE}?${qs}`);
  if (!res.ok) throw new Error(`view failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function create() {
  const body = new URLSearchParams({
    ...creds(),
    callback_url: `${env('APP_URL')}/api/strava/webhook`,
    verify_token: env('STRAVA_VERIFY_TOKEN'),
  });
  const res = await fetch(BASE, { method: 'POST', body });
  if (!res.ok) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  console.log('subscription created:', await res.json());
}

async function del() {
  const subs = await view();
  if (!subs.length) { console.log('no subscription to delete'); return; }
  for (const sub of subs) {
    const qs = new URLSearchParams(creds());
    const res = await fetch(`${BASE}/${sub.id}?${qs}`, { method: 'DELETE' });
    if (res.status !== 204) throw new Error(`delete failed: ${res.status} ${await res.text()}`);
    console.log(`subscription ${sub.id} deleted`);
  }
}

const command = process.argv[2];
const run = command === 'create' ? create
  : command === 'view' ? () => view().then((s) => console.log(s.length ? s : 'no subscription'))
  : command === 'delete' ? del
  : null;

if (!run) {
  console.error('usage: strava-webhook.ts <create|view|delete>');
  process.exit(1);
}
run().catch((e) => { console.error(e); process.exit(1); });
```

Note: Strava's `callback_url` must be publicly reachable when `create` runs — the validation GET happens synchronously. `create` is therefore run against the PRODUCTION `APP_URL` (Task 4), never localhost.

- [ ] **Step 4: Wire up scripts and env**

In `package.json` scripts, add:

```json
"webhook:create": "tsx --env-file=.env.local scripts/strava-webhook.ts create",
"webhook:view": "tsx --env-file=.env.local scripts/strava-webhook.ts view",
"webhook:delete": "tsx --env-file=.env.local scripts/strava-webhook.ts delete"
```

In `.env.example`, add under the Strava lines:

```bash
STRAVA_VERIFY_TOKEN=
```

In `.env.local`, add `STRAVA_VERIFY_TOKEN=<output of: openssl rand -hex 16>`.

- [ ] **Step 5: README**

In `README.md`: add `STRAVA_VERIFY_TOKEN` to the env-var table ("webhook validation handshake secret"), and append to the deployment runbook:

```markdown
5. **Webhook (auto-import):** set `STRAVA_VERIFY_TOKEN` (random hex) in `.env.local` and Vercel production env, deploy, then `npm run webhook:create` with `APP_URL` pointing at production. Verify with `npm run webhook:view`. Rides now import automatically minutes after upload; the Sync button remains as fallback. `npm run webhook:delete` unsubscribes.
```

- [ ] **Step 6: Full gate + commit**

`TEST_DATABASE_URL=postgres://postgres:dev@localhost:5432/gravel_test npx vitest run` green; `npx tsc --noEmit` clean; `npm run build` clean.

```bash
git add proxy.ts scripts/strava-webhook.ts package.json .env.example README.md
git commit -m "feat: webhook app-lock exclusion, verify token, and subscription CLI"
```

---

### Task 4: Deploy and register the subscription (production)

**Files:** none (configuration + one-off commands).

**Interfaces:**
- Consumes: everything above; Vercel project `gravel-atlas` (already linked, GitHub auto-deploy connected); production domain `https://gravel-atlas-two.vercel.app`.

- [ ] **Step 1: Production env var**

```bash
openssl rand -hex 16   # use output as <TOKEN>; must equal STRAVA_VERIFY_TOKEN in .env.local
printf '%s' '<TOKEN>' | npx vercel env add STRAVA_VERIFY_TOKEN production
```

(If a different token was already written to `.env.local` in Task 3, reuse that exact value — the CLI sends `.env.local`'s token and production must match it.)

- [ ] **Step 2: Deploy**

`git push` triggers the GitHub→Vercel auto-deploy of main. Wait for it (`npx vercel ls gravel-atlas 2>&1 | head -5` shows the latest deployment Ready), or run `npx vercel deploy --prod --yes` directly.

- [ ] **Step 3: Pre-registration smoke test on production**

```bash
BASE=https://gravel-atlas-two.vercel.app
# validation handshake (with the real token from .env.local):
curl -s "$BASE/api/strava/webhook?hub.mode=subscribe&hub.verify_token=<TOKEN>&hub.challenge=ping"
# expected: {"hub.challenge":"ping"}
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/strava/webhook?hub.verify_token=wrong&hub.challenge=x"
# expected: 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{"object_type":"athlete","aspect_type":"update"}' "$BASE/api/strava/webhook"
# expected: 200 (public, no cookie)
```

- [ ] **Step 4: Register the subscription**

Run: `APP_URL=https://gravel-atlas-two.vercel.app npm run webhook:create`
Expected: `subscription created: { id: <number>, ... }` (Strava performed the validation GET against production during this call).
Then: `npm run webhook:view` → shows one subscription with `callback_url` = the production webhook URL.

- [ ] **Step 5: End-to-end verification (human)**

The real test is the next ride: upload a ride to Strava (or wait for one), and within ~2 minutes the ride appears in the app's ride log and paints the map without touching Sync. Check `npx vercel logs` for the `webhook sync round …` log lines if curious.

- [ ] **Step 6: Ledger + memory**

Record completion in `.superpowers/sdd/progress.md`.

---

## Post-plan backlog (unchanged)

Vector tiles for the segments payload · optional `service`-road exclusion · quests/bounties/regions (spec v2).
