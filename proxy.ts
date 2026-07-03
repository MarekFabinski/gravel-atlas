import { NextRequest, NextResponse } from 'next/server';

export function proxy(req: NextRequest) {
  if (req.cookies.get('atlas_key')?.value === process.env.APP_PASSWORD) {
    return NextResponse.next();
  }
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = {
  matcher: ['/((?!login|api/login|_next|favicon.ico).*)'],
};
