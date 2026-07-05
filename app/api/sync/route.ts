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
