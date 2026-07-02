import type postgres from 'postgres';

const BASE = 'https://www.strava.com';
export const PER_PAGE = 50;
export const RATE_LIMITED = new Error('strava_rate_limited');

export type TokenSet = { access_token: string; refresh_token: string; expires_at: number };
export type SummaryActivity = {
  id: number;
  name: string;
  sport_type: string;
  start_date: string;
  distance: number;
  total_elevation_gain: number;
};

export function authorizeUrl(): string {
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID!,
    redirect_uri: `${process.env.APP_URL}/api/strava/callback`,
    response_type: 'code',
    scope: 'activity:read_all',
  });
  return `${BASE}/oauth/authorize?${params}`;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      ...params,
    }),
  });
  if (!res.ok) throw new Error(`strava token request failed: ${res.status}`);
  return res.json();
}

export const exchangeCode = (code: string) =>
  tokenRequest({ code, grant_type: 'authorization_code' });
export const refreshTokens = (refreshToken: string) =>
  tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });

export async function saveTokens(sql: postgres.Sql, t: TokenSet) {
  await sql`
    INSERT INTO strava_tokens (id, access_token, refresh_token, expires_at)
    VALUES (1, ${t.access_token}, ${t.refresh_token}, to_timestamp(${t.expires_at}))
    ON CONFLICT (id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      expires_at = EXCLUDED.expires_at`;
}

export async function getValidToken(sql: postgres.Sql): Promise<string> {
  const [row] = await sql`
    SELECT access_token, refresh_token, expires_at FROM strava_tokens WHERE id = 1`;
  if (!row) throw new Error('Strava not connected — visit /api/strava/connect');
  if (new Date(row.expires_at).getTime() - Date.now() > 5 * 60 * 1000) {
    return row.access_token;
  }
  const t = await refreshTokens(row.refresh_token);
  await saveTokens(sql, t);
  return t.access_token;
}

async function api(token: string, path: string) {
  const res = await fetch(`${BASE}/api/v3${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) throw RATE_LIMITED;
  if (!res.ok) throw new Error(`strava api ${path}: ${res.status}`);
  return res.json();
}

export const fetchActivities = (token: string, afterEpoch: number): Promise<SummaryActivity[]> =>
  api(token, `/athlete/activities?after=${afterEpoch}&per_page=${PER_PAGE}`);

export const fetchStreams = (
  token: string,
  id: number
): Promise<{ latlng?: { data: [number, number][] } }> =>
  api(token, `/activities/${id}/streams?keys=latlng&key_by_type=true`);
