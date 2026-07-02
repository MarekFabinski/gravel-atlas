import { classifySurface } from './surface';

export type OsmNode = { id: number; lat: number; lon: number };
export type OsmWay = { id: number; nodes: number[]; tags: Record<string, string> };
export type Segment = {
  osmWayId: number;
  partIndex: number;
  name: string | null;
  surfaceClass: 'paved' | 'unpaved' | 'unknown';
  coords: [number, number][]; // [lon, lat]
};

/** Split ways into segments at intersection nodes (nodes used by >1 way). */
export function splitWays(ways: OsmWay[], nodes: Map<number, OsmNode>): Segment[] {
  const usage = new Map<number, number>();
  for (const way of ways) {
    for (const n of new Set(way.nodes)) usage.set(n, (usage.get(n) ?? 0) + 1);
  }

  const segments: Segment[] = [];
  for (const way of ways) {
    let partIndex = 0;
    let current: number[] = [way.nodes[0]];
    for (let i = 1; i < way.nodes.length; i++) {
      current.push(way.nodes[i]);
      const isLast = i === way.nodes.length - 1;
      const isIntersection = (usage.get(way.nodes[i]) ?? 0) >= 2;
      if (!isLast && !isIntersection) continue;

      const coords = current
        .map((id) => nodes.get(id))
        .filter((n): n is OsmNode => n !== undefined)
        .map((n) => [n.lon, n.lat] as [number, number]);
      if (coords.length >= 2) {
        segments.push({
          osmWayId: way.id,
          partIndex: partIndex++,
          name: way.tags.name ?? null,
          surfaceClass: classifySurface(way.tags),
          coords,
        });
      }
      current = [way.nodes[i]];
    }
  }
  return segments;
}

export function toWkt(coords: [number, number][]): string {
  return `LINESTRING(${coords.map(([lon, lat]) => `${lon} ${lat}`).join(', ')})`;
}
