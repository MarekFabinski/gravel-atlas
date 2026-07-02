import { describe, it, expect } from 'vitest';
import { classifySurface } from '@/lib/network/surface';

describe('classifySurface', () => {
  it('uses the surface tag when present', () => {
    expect(classifySurface({ surface: 'asphalt' })).toBe('paved');
    expect(classifySurface({ surface: 'gravel' })).toBe('unpaved');
    expect(classifySurface({ surface: 'compacted' })).toBe('unpaved');
  });

  it('falls back to highway type when surface is missing', () => {
    expect(classifySurface({ highway: 'track' })).toBe('unpaved');
    expect(classifySurface({ highway: 'path' })).toBe('unpaved');
    expect(classifySurface({ highway: 'residential' })).toBe('paved');
    expect(classifySurface({ highway: 'tertiary' })).toBe('paved');
  });

  it('surface tag beats highway fallback', () => {
    expect(classifySurface({ highway: 'track', surface: 'asphalt' })).toBe('paved');
  });

  it('returns unknown when neither helps', () => {
    expect(classifySurface({ highway: 'service' })).toBe('unknown');
    expect(classifySurface({ highway: 'unclassified' })).toBe('unknown');
    expect(classifySurface({ surface: 'metal' })).toBe('unknown');
  });
});
