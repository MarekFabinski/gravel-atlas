import { describe, it, expect } from 'vitest';
import { splitWays, toWkt, type OsmNode, type OsmWay } from '@/lib/network/split';

function nodeMap(...nodes: [number, number, number][]): Map<number, OsmNode> {
  return new Map(nodes.map(([id, lon, lat]) => [id, { id, lat, lon }]));
}

describe('splitWays', () => {
  it('keeps a way with no shared nodes as one segment', () => {
    const nodes = nodeMap([1, 16.90, 54.40], [2, 16.91, 54.40], [3, 16.92, 54.40]);
    const ways: OsmWay[] = [{ id: 100, nodes: [1, 2, 3], tags: { highway: 'track' } }];
    const segs = splitWays(ways, nodes);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ osmWayId: 100, partIndex: 0, surfaceClass: 'unpaved' });
    expect(segs[0].coords).toEqual([[16.90, 54.40], [16.91, 54.40], [16.92, 54.40]]);
  });

  it('splits a way at a node shared with another way', () => {
    const nodes = nodeMap(
      [1, 16.90, 54.40], [2, 16.91, 54.40], [3, 16.92, 54.40],
      [4, 16.91, 54.41],
    );
    const ways: OsmWay[] = [
      { id: 100, nodes: [1, 2, 3], tags: { highway: 'track', name: 'A' } },
      { id: 200, nodes: [4, 2], tags: { highway: 'track' } },
    ];
    const segs = splitWays(ways, nodes);
    const partsOf100 = segs.filter((s) => s.osmWayId === 100);
    expect(partsOf100).toHaveLength(2);
    expect(partsOf100[0].coords).toEqual([[16.90, 54.40], [16.91, 54.40]]);
    expect(partsOf100[1].coords).toEqual([[16.91, 54.40], [16.92, 54.40]]);
    expect(partsOf100.map((s) => s.partIndex)).toEqual([0, 1]);
    expect(partsOf100[0].name).toBe('A');
    expect(segs.filter((s) => s.osmWayId === 200)).toHaveLength(1);
  });

  it('drops references to missing nodes and skips degenerate pieces', () => {
    const nodes = nodeMap([1, 16.90, 54.40], [3, 16.92, 54.40]);
    const ways: OsmWay[] = [{ id: 100, nodes: [1, 2, 3], tags: { highway: 'track' } }];
    const segs = splitWays(ways, nodes);
    expect(segs).toHaveLength(1);
    expect(segs[0].coords).toEqual([[16.90, 54.40], [16.92, 54.40]]);
  });
});

describe('toWkt', () => {
  it('formats lon lat pairs', () => {
    expect(toWkt([[16.90, 54.40], [16.91, 54.41]]))
      .toBe('LINESTRING(16.9 54.4, 16.91 54.41)');
  });
});
