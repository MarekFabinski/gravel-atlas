import { NextResponse } from 'next/server';
import sql from '@/lib/db';
import { exchangeCode, saveTokens } from '@/lib/strava';

export async function GET(req: Request) {
  const code = new URL(req.url).searchParams.get('code');
  if (!code) {
    return NextResponse.redirect(new URL('/?strava=denied', process.env.APP_URL));
  }
  const tokens = await exchangeCode(code);
  await saveTokens(sql, tokens);
  return NextResponse.redirect(new URL('/?strava=connected', process.env.APP_URL));
}
