import { NextResponse } from 'next/server';
import { authorizeUrl } from '@/lib/strava';

export async function GET() {
  return NextResponse.redirect(authorizeUrl());
}
