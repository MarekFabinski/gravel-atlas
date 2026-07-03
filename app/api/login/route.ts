import { NextResponse } from 'next/server';
import { sessionToken } from '@/lib/authToken';

export async function POST(req: Request) {
  const pw = process.env.APP_PASSWORD;
  const form = await req.formData();
  // Fail closed: an unset APP_PASSWORD must never let a login through.
  if (pw && form.get('password') === pw) {
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
