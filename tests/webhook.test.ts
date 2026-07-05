import { describe, it, expect, vi, beforeEach } from 'vitest';

// The webhook must invoke the sync loop exactly once per create-event and
// never for anything else — mock the runner, no DB needed for these tests.
vi.mock('@/lib/syncRunner', () => ({
  runSyncLoop: vi.fn(async () => {}),
}));

import { runSyncLoop } from '@/lib/syncRunner';
import { GET, POST } from '@/app/api/strava/webhook/route';

const URL_BASE = 'http://test.local/api/strava/webhook';

function validationReq(params: Record<string, string>): Request {
  const qs = new URLSearchParams(params).toString();
  return new Request(`${URL_BASE}?${qs}`);
}

function eventReq(body: unknown): Request {
  return new Request(URL_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.STRAVA_VERIFY_TOKEN = 'test-verify-token';
  vi.mocked(runSyncLoop).mockClear();
});

describe('GET /api/strava/webhook (subscription validation)', () => {
  it('echoes hub.challenge for the correct verify token', async () => {
    const res = await GET(validationReq({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'test-verify-token',
      'hub.challenge': 'challenge-123',
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ 'hub.challenge': 'challenge-123' });
  });

  it('rejects a wrong verify token with 401', async () => {
    const res = await GET(validationReq({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong',
      'hub.challenge': 'challenge-123',
    }));
    expect(res.status).toBe(401);
  });

  it('rejects a missing verify token with 401', async () => {
    const res = await GET(validationReq({ 'hub.mode': 'subscribe', 'hub.challenge': 'x' }));
    expect(res.status).toBe(401);
  });

  it('rejects a correct token with missing/wrong hub.mode with 401', async () => {
    const resMissing = await GET(validationReq({
      'hub.verify_token': 'test-verify-token',
      'hub.challenge': 'x',
    }));
    expect(resMissing.status).toBe(401);

    const resWrong = await GET(validationReq({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': 'test-verify-token',
      'hub.challenge': 'x',
    }));
    expect(resWrong.status).toBe(401);
  });

  it('fails closed when STRAVA_VERIFY_TOKEN is unset', async () => {
    delete process.env.STRAVA_VERIFY_TOKEN;
    const res = await GET(validationReq({
      'hub.mode': 'subscribe',
      'hub.verify_token': '',
      'hub.challenge': 'x',
    }));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/strava/webhook (events)', () => {
  it('ACKs an activity create event and triggers the sync loop once', async () => {
    const res = await POST(eventReq({
      object_type: 'activity', object_id: 123, aspect_type: 'create',
      owner_id: 456, subscription_id: 1, event_time: 1700000000,
    }));
    expect(res.status).toBe(200);
    expect(runSyncLoop).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['activity update', { object_type: 'activity', aspect_type: 'update', updates: { title: 'x' } }],
    ['activity delete', { object_type: 'activity', aspect_type: 'delete' }],
    ['athlete event', { object_type: 'athlete', aspect_type: 'update' }],
  ])('ACKs %s without triggering sync', async (_label, body) => {
    const res = await POST(eventReq(body));
    expect(res.status).toBe(200);
    expect(runSyncLoop).not.toHaveBeenCalled();
  });

  it('ACKs malformed JSON without triggering sync', async () => {
    const res = await POST(eventReq('{not json'));
    expect(res.status).toBe(200);
    expect(runSyncLoop).not.toHaveBeenCalled();
  });

  it.each([
    ['null primitive', 'null'],
    ['number', '42'],
    ['array', '[1,2]'],
  ])('ACKs non-object JSON (%s) without triggering sync', async (_label, body) => {
    const res = await POST(eventReq(body));
    expect(res.status).toBe(200);
    expect(runSyncLoop).not.toHaveBeenCalled();
  });
});
