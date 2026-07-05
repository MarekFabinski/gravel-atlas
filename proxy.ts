import { NextRequest, NextResponse } from 'next/server';
import { sessionToken, tokensMatch } from '@/lib/authToken';

export function proxy(req: NextRequest) {
  // Fail closed: an unset APP_PASSWORD must never leave the app unlocked.
  // (Without this guard, an unset env var makes both sides of the cookie
  // check `undefined`, which "matches".)
  const pw = process.env.APP_PASSWORD;
  const cookie = req.cookies.get('atlas_key')?.value;
  if (pw && cookie && tokensMatch(cookie, sessionToken(pw))) {
    return NextResponse.next();
  }
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = {
  // Segment-anchored exclusions: `login(?:/|$)` matches "login" and
  // "login/…" but not "loginout", so lookalike paths still go through the
  // lock instead of being accidentally excluded by a bare prefix match.
  // `api/strava/webhook` is excluded too: Strava calls it without a
  // cookie, and the endpoint has its own verify-token/doorbell protections.
  matcher: ['/((?!login(?:/|$)|api/login(?:/|$)|api/strava/webhook(?:/|$)|_next|favicon.ico).*)'],
};
