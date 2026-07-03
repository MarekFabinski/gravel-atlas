'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { REGION } from '@/lib/region';

const GREY = '#9aa0a6';
const PAINT = '#e8590c';

type StatsLite = { completion: { pct: number } };

export default function MapPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [unpavedOnly, setUnpavedOnly] = useState(false);
  const [stats, setStats] = useState<StatsLite | null>(null);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
      center: [REGION.lon, REGION.lat],
      zoom: 10,
    });
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('segments', { type: 'geojson', data: '/api/segments' });
      map.addLayer({
        id: 'seg-grey', type: 'line', source: 'segments',
        filter: ['==', ['get', 'claimed'], false],
        paint: { 'line-color': GREY, 'line-width': 1.5 },
      });
      map.addLayer({
        id: 'seg-claimed', type: 'line', source: 'segments',
        filter: ['==', ['get', 'claimed'], true],
        paint: { 'line-color': PAINT, 'line-width': 2.5 },
      });
      for (const layer of ['seg-grey', 'seg-claimed']) {
        map.on('click', layer, (e) => {
          const p = e.features?.[0]?.properties;
          if (!p) return;
          new maplibregl.Popup()
            .setLngLat(e.lngLat)
            .setHTML(
              `<strong>${p.name || 'Unnamed'}</strong><br/>` +
              `${p.surface} · ${p.length_m} m · ${p.claimed === true || p.claimed === 'true' ? 'claimed ✅' : 'unclaimed'}`
            )
            .addTo(map);
        });
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      }
    });

    fetch('/api/stats').then((r) => r.json()).then(setStats);
    return () => map.remove();
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer('seg-grey')) return;
    const withSurface = (claimed: boolean): maplibregl.FilterSpecification =>
      unpavedOnly
        ? ['all', ['==', ['get', 'claimed'], claimed], ['==', ['get', 'surface'], 'unpaved']]
        : ['==', ['get', 'claimed'], claimed];
    map.setFilter('seg-grey', withSurface(false));
    map.setFilter('seg-claimed', withSurface(true));
  }, [unpavedOnly]);

  return (
    <main style={{ position: 'relative', height: 'calc(100vh - 45px)' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <div style={{
        position: 'absolute', top: 12, left: 12, zIndex: 1, background: 'white',
        padding: '8px 12px', borderRadius: 8, boxShadow: '0 1px 4px rgba(0,0,0,.3)',
      }}>
        <div style={{ fontSize: 22, fontWeight: 700 }}>
          {stats ? `${stats.completion.pct.toFixed(2)}%` : '…'}
        </div>
        <div style={{ fontSize: 12, color: '#666' }}>of the atlas painted</div>
        <label style={{ fontSize: 13, display: 'block', marginTop: 6 }}>
          <input
            type="checkbox"
            checked={unpavedOnly}
            onChange={(e) => setUnpavedOnly(e.target.checked)}
          /> unpaved only
        </label>
      </div>
    </main>
  );
}
