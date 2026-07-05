import { describe, it, expect } from 'vitest';
import { RIDEABLE_HIGHWAYS } from '@/lib/config';

describe('RIDEABLE_HIGHWAYS', () => {
  it('excludes service roads (driveways/parking aisles are not part of the game board)', () => {
    expect(RIDEABLE_HIGHWAYS).not.toContain('service');
  });

  it('keeps the v1 rideable set otherwise', () => {
    expect([...RIDEABLE_HIGHWAYS].sort()).toEqual([
      'bridleway', 'cycleway', 'living_street', 'path', 'residential',
      'secondary', 'tertiary', 'track', 'unclassified',
    ]);
  });
});
