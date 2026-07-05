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
