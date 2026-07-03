import sql from '@/lib/db';

export const dynamic = 'force-dynamic';

type RideRow = {
  id: number; name: string; started_at: string; distance_m: number;
  new_segments: number; xp: number; status: string;
};

export default async function RidesPage() {
  const rides = await sql<RideRow[]>`
    SELECT id, name, started_at, distance_m, new_segments, xp, status
    FROM rides ORDER BY started_at DESC LIMIT 200`;

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <h1>Ride log</h1>
      {rides.length === 0 && <p>No rides yet — hit “Sync rides” after your next gravel adventure.</p>}
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd' }}>
            <th style={{ padding: 6 }}>Date</th><th style={{ padding: 6 }}>Ride</th>
            <th style={{ padding: 6 }}>km</th><th style={{ padding: 6 }}>New segments</th>
            <th style={{ padding: 6 }}>XP</th>
          </tr>
        </thead>
        <tbody>
          {rides.map((r) => (
            <tr key={r.id} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{new Date(r.started_at).toLocaleDateString('en-GB')}</td>
              <td style={{ padding: 6 }}>
                {r.name}
                {r.status === 'skipped_no_gps' && ' ⚠️ (no GPS — skipped)'}
                {r.status === 'failed' && ' ❌ (matching failed)'}
              </td>
              <td style={{ padding: 6 }}>{(r.distance_m / 1000).toFixed(1)}</td>
              <td style={{ padding: 6 }}>{r.status === 'imported' ? r.new_segments : '—'}</td>
              <td style={{ padding: 6 }}>{r.status === 'imported' ? `+${r.xp}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
