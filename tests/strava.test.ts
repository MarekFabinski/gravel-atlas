import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refreshTokens, fetchActivities, RATE_LIMITED, authorizeUrl } from '@/lib/strava';

describe('strava client', () => {
  beforeEach(() => {
    process.env.STRAVA_CLIENT_ID = 'cid';
    process.env.STRAVA_CLIENT_SECRET = 'csecret';
    process.env.APP_URL = 'https://example.test';
  });
  afterEach(() => vi.unstubAllGlobals());

  it('authorizeUrl targets the callback with activity:read_all', () => {
    const url = new URL(authorizeUrl());
    expect(url.origin + url.pathname).toBe('https://www.strava.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.test/api/strava/callback');
    expect(url.searchParams.get('scope')).toBe('activity:read_all');
  });

  it('refreshTokens posts the refresh grant and returns tokens', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new-at', refresh_token: 'new-rt', expires_at: 1750000000,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const t = await refreshTokens('old-rt');
    expect(t.access_token).toBe('new-at');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://www.strava.com/oauth/token');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      client_id: 'cid', client_secret: 'csecret',
      refresh_token: 'old-rt', grant_type: 'refresh_token',
    });
  });

  it('throws the RATE_LIMITED sentinel on 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    await expect(fetchActivities('tok', 0)).rejects.toBe(RATE_LIMITED);
  });
});
