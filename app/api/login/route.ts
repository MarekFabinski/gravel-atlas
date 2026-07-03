import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  const form = await req.formData();
  if (form.get('password') === process.env.APP_PASSWORD) {
    const res = NextResponse.redirect(new URL('/', req.url), 303);
    res.cookies.set('atlas_key', process.env.APP_PASSWORD!, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    });
    return res;
  }
  return NextResponse.redirect(new URL('/login', req.url), 303);
}
