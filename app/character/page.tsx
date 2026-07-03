import { getStats } from '@/lib/stats';
import Radar from '@/components/Radar';

export const dynamic = 'force-dynamic';

export default async function CharacterPage() {
  const s = await getStats();
  const levelPct = Math.min(
    100,
    ((s.xp - s.levelStartXp) / (s.nextLevelXp - s.levelStartXp)) * 100
  );

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <h1 style={{ marginBottom: 0 }}>Level {s.level} — {s.title}</h1>
      <div style={{ background: '#eee', borderRadius: 6, height: 14, margin: '12px 0' }}>
        <div style={{
          width: `${levelPct}%`, height: '100%', background: '#e8590c', borderRadius: 6,
        }} />
      </div>
      <p style={{ color: '#666', marginTop: 0 }}>
        {s.xp} XP — {s.nextLevelXp - s.xp} to level {s.level + 1}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }}>
        <Radar axes={s.radar} />
        <ul style={{ lineHeight: 2, listStyle: 'none', padding: 0 }}>
          <li>🧭 <strong>Explorer</strong> — {s.explorer} segments claimed</li>
          <li>🔋 <strong>Endurance</strong> — {Math.round(s.enduranceKm)} pts</li>
          <li>🪨 <strong>Grit</strong> — {Math.round(s.gritKm)} unpaved km</li>
          <li>⛰️ <strong>Climber</strong> — {Math.round(s.climberM)} m climbed</li>
        </ul>
      </div>

      <h2>Gmina completion</h2>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd' }}>
            <th style={{ padding: 6 }}>Gmina</th><th style={{ padding: 6 }}>Painted</th>
            <th style={{ padding: 6 }}>%</th>
          </tr>
        </thead>
        <tbody>
          {s.gminas.map((g) => (
            <tr key={g.gmina} style={{ borderBottom: '1px solid #eee' }}>
              <td style={{ padding: 6 }}>{g.gmina}</td>
              <td style={{ padding: 6 }}>
                {(g.claimedM / 1000).toFixed(1)} / {(g.totalM / 1000).toFixed(0)} km
              </td>
              <td style={{ padding: 6 }}>{g.pct.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
