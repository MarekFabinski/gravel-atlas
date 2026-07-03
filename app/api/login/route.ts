import { NextResponse } from 'next/server';
import { sessionToken, tokensMatch } from '@/lib/authToken';

export async function POST(req: Request) {
  const pw = process.env.APP_PASSWORD;
  const form = await req.formData();
  // Fail closed: an unset APP_PASSWORD must never let a login through.
  // Compare via HMAC digests with a constant-time check (rather than
  // plain === on the submitted password) so login can't be timed to leak
  // information about APP_PASSWORD — mirrors proxy.ts's cookie check.
  if (pw && tokensMatch(sessionToken(String(form.get('password') ?? '')), sessionToken(pw))) {
    const res = NextResponse.redirect(new URL('/', req.url), 303);
    res.cookies.set('atlas_key', sessionToken(pw), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
      // Plain `secure: true` would break http://localhost dev logins.
      secure: process.env.NODE_ENV === 'production',
    });
    return res;
  }
  return NextResponse.redirect(new URL('/login?error=1', req.url), 303);
}
