import sql from './db';
import { levelForXp, xpForLevel, titleForLevel, sat } from './game';

export type GminaCompletion = { gmina: string; claimedM: number; totalM: number; pct: number };
export type Stats = {
  completion: { claimedM: number; totalM: number; pct: number };
  gminas: GminaCompletion[];
  xp: number; level: number; title: string;
  levelStartXp: number; nextLevelXp: number;
  explorer: number; enduranceKm: number; gritKm: number; climberM: number;
  radar: { label: string; norm: number }[];
};

const pct = (claimed: number, total: number) => (total > 0 ? (claimed / total) * 100 : 0);

// Some gminas legitimately come in both a city (e.g. "Ustka") and a
// surrounding rural ("gmina Ustka") flavor — two distinct administrative
// units, verified against the dev DB (Ustka/gmina Ustka, Darłowo/gmina
// Darłowo, Sławno/gmina Sławno all exist as separate raw names). Stripping
// the "gmina " prefix before GROUP BY would silently merge their totals, so
// grouping happens on the raw name; this only *displays* the stripped form,
// and only when it's unambiguous.
const GMINA_PREFIX = /^[Gg]mina\s+(.+)$/;

function displayGmina(raw: string, rawNames: Set<string>): string {
  const m = GMINA_PREFIX.exec(raw);
  if (!m) return raw;
  const stripped = m[1];
  // A same-named city bucket already exists as its own raw entry — keep
  // both distinguishable rather than colliding their labels.
  return rawNames.has(stripped) ? `${stripped} (gmina)` : stripped;
}

export async function getStats(): Promise<Stats> {
  const [overall] = await sql`
    SELECT COALESCE(SUM(s.length_m) FILTER (WHERE c.segment_id IS NOT NULL), 0)::float AS claimed_m,
           COALESCE(SUM(s.length_m), 0)::float AS total_m
    FROM segments s LEFT JOIN claims c ON c.segment_id = s.id`;

  const gminaRows = await sql`
    SELECT COALESCE(s.gmina, '(unknown)') AS gmina,
           COALESCE(SUM(s.length_m) FILTER (WHERE c.segment_id IS NOT NULL), 0)::float AS claimed_m,
           COALESCE(SUM(s.length_m), 0)::float AS total_m
    FROM segments s LEFT JOIN claims c ON c.segment_id = s.id
    GROUP BY 1 ORDER BY 1`;

  const rawGminaNames = new Set(gminaRows.map((g) => g.gmina as string));

  const [rides] = await sql`
    SELECT COALESCE(SUM(xp), 0)::int AS xp,
           COALESCE(SUM(distance_m), 0)::float AS dist_m,
           COALESCE(SUM(elevation_m), 0)::float AS elev_m,
           COALESCE(SUM(unpaved_m), 0)::float AS unpaved_m,
           COALESCE(SUM(GREATEST(distance_m / 1000.0 - 50, 0)), 0)::float AS bonus_km
    FROM rides WHERE status = 'imported'`;

  const [{ explorer }] = await sql`SELECT COUNT(*)::int AS explorer FROM claims`;

  const level = levelForXp(rides.xp);
  const enduranceKm = rides.dist_m / 1000 + rides.bonus_km;
  const gritKm = rides.unpaved_m / 1000;

  return {
    completion: { claimedM: overall.claimed_m, totalM: overall.total_m, pct: pct(overall.claimed_m, overall.total_m) },
    gminas: gminaRows.map((g) => ({
      gmina: displayGmina(g.gmina, rawGminaNames), claimedM: g.claimed_m, totalM: g.total_m,
      pct: pct(g.claimed_m, g.total_m),
    })),
    xp: rides.xp,
    level,
    title: titleForLevel(level),
    levelStartXp: xpForLevel(level),
    nextLevelXp: xpForLevel(level + 1),
    explorer,
    enduranceKm,
    gritKm,
    climberM: rides.elev_m,
    radar: [
      { label: 'Explorer', norm: sat(explorer, 150) },
      { label: 'Endurance', norm: sat(enduranceKm, 1000) },
      { label: 'Grit', norm: sat(gritKm, 500) },
      { label: 'Climber', norm: sat(rides.elev_m, 5000) },
    ],
  };
}
