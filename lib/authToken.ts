import { createHmac, timingSafeEqual } from 'node:crypto';

// Fixed context string the HMAC is bound to. It doesn't need to be secret —
// APP_PASSWORD is the key — it just keeps the digest specific to this cookie's
// purpose so it can't be reused/confused with a digest computed elsewhere.
const CONTEXT = 'atlas-session-v1';

/**
 * Derives the session-cookie value from APP_PASSWORD. The cookie must never
 * carry the plaintext password (proxy.ts + app/api/login/route.ts both use
 * this so they can't drift), so we hand the browser this HMAC-SHA256 digest
 * instead — it authenticates the session without exposing the password
 * itself, even if the cookie leaks.
 */
export function sessionToken(password: string): string {
  return createHmac('sha256', password).update(CONTEXT).digest('hex');
}

/**
 * Constant-time comparison of two hex digests. Guards length first because
 * timingSafeEqual throws (rather than returning false) on a length mismatch,
 * and comparing unequal-length buffers is never a match anyway.
 */
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
