import { NextResponse } from 'next/server';
import sql from '@/lib/db';
import { exchangeCode, saveTokens } from '@/lib/strava';

export async function GET(req: Request) {
  const code = new URL(req.url).searchParams.get('code');
  if (!code) {
    return NextResponse.redirect(new URL('/?strava=denied', process.env.APP_URL));
  }
  try {
    const tokens = await exchangeCode(code);
    await saveTokens(sql, tokens);
  } catch (e) {
    console.error('strava oauth callback failed:', e);
    return NextResponse.redirect(new URL('/?strava=error', process.env.APP_URL));
  }
  return NextResponse.redirect(new URL('/?strava=connected', process.env.APP_URL));
}
