import { describe, it, expect, vi } from 'vitest';
import { runSyncLoop } from '@/lib/syncRunner';
import type { SyncResult } from '@/lib/syncRunner';

// Pure unit tests for the loop-control logic in runSyncLoop — no DB, no
// mocked modules. syncFn injection (Fix 5's reason for existing) lets us
// script exact result sequences and assert call counts directly.

function syncFnSequence(results: SyncResult[]) {
  let i = 0;
  return vi.fn(async () => {
    const r = results[Math.min(i, results.length - 1)];
    i++;
    return r;
  });
}

describe('runSyncLoop', () => {
  it('stops once a result reports more:false, calling syncFn exactly N times', async () => {
    const syncFn = syncFnSequence([
      { imported: 1, skipped: 0, more: true },
      { imported: 1, skipped: 0, more: true },
      { imported: 0, skipped: 1, more: false },
    ]);
    await runSyncLoop({ syncFn });
    expect(syncFn).toHaveBeenCalledTimes(3);
  });

  it('stops on a rateLimited result', async () => {
    const syncFn = syncFnSequence([
      { imported: 1, skipped: 0, more: true },
      { rateLimited: true },
      { imported: 99, skipped: 0, more: true }, // must never be reached
    ]);
    await runSyncLoop({ syncFn });
    expect(syncFn).toHaveBeenCalledTimes(2);
  });

  it('stops at maxRounds when every round reports more:true', async () => {
    const syncFn = vi.fn(async (): Promise<SyncResult> => ({ imported: 1, skipped: 0, more: true }));
    await runSyncLoop({ maxRounds: 4, syncFn });
    expect(syncFn).toHaveBeenCalledTimes(4);
  });

  it('stops once the time budget is exceeded, after letting the first round run to completion', async () => {
    // budgetMs: 0 means the deadline is set to "now" at loop start. The
    // check happens *between* rounds (before calling syncFn again), so the
    // first round is always allowed to complete regardless of budget —
    // only the second call is prevented. Drive Date.now() with a spy so
    // the assertion doesn't depend on real elapsed wall-clock time.
    let now = 1_000_000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const syncFn = vi.fn(async (): Promise<SyncResult> => {
        now += 1; // simulate time passing while "in" the sync call
        return { imported: 1, skipped: 0, more: true };
      });
      await runSyncLoop({ budgetMs: 0, syncFn });
      expect(syncFn).toHaveBeenCalledTimes(1);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('never throws when syncFn rejects', async () => {
    const syncFn = vi.fn(async (): Promise<SyncResult> => {
      throw new Error('boom: strava blew up');
    });
    await expect(runSyncLoop({ syncFn })).resolves.toBeUndefined();
    expect(syncFn).toHaveBeenCalledTimes(1);
  });
});
