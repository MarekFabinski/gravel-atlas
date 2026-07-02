'use client';

import { useState } from 'react';

type State = 'idle' | 'syncing' | 'rate_limited' | 'error';

export default function SyncButton() {
  const [state, setState] = useState<State>('idle');
  const [count, setCount] = useState(0);

  async function run() {
    setState('syncing');
    let total = 0;
    for (;;) {
      const res = await fetch('/api/sync', { method: 'POST' });
      if (res.status === 429) { setState('rate_limited'); return; }
      if (!res.ok) { setState('error'); return; }
      const j = await res.json();
      total += j.imported + j.skipped;
      setCount(total);
      if (!j.more) break;
    }
    setState('idle');
    location.reload();
  }

  const label =
    state === 'syncing' ? `Syncing… ${count}` :
    state === 'rate_limited' ? 'Strava limit — retry in 15 min' :
    state === 'error' ? 'Sync failed — retry' :
    'Sync rides';

  return (
    <button onClick={run} disabled={state === 'syncing'} style={{ padding: '6px 14px' }}>
      {label}
    </button>
  );
}
