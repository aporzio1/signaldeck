import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';

export type MapPoint = {
  id: string;
  lat: number;
  lon: number;
  label?: string;
  detail?: string;
  tone?: 'self' | 'node' | 'weak' | 'hit';
};

const COLORS: Record<string, string> = {
  self: '#2dd4bf',
  node: '#60a5fa',
  weak: '#a78bfa',
  hit: '#fbbf24',
};

export function MapView({
  points,
  track,
  height = 320,
  follow = false,
}: {
  points: MapPoint[];
  track?: Array<{ lat: number; lon: number }>;
  height?: number;
  follow?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerLayer = useRef<L.LayerGroup | null>(null);
  const trackLine = useRef<L.Polyline | null>(null);
  const centered = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
      preferCanvas: true,
    }).setView([20, 0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '&copy; OpenStreetMap &copy; CARTO',
    }).addTo(map);
    markerLayer.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 120);
    return () => {
      map.remove();
      mapRef.current = null;
      markerLayer.current = null;
      centered.current = false;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = markerLayer.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const valid = points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
    for (const point of valid) {
      const color = COLORS[point.tone || 'node'];
      const isSelf = point.tone === 'self';
      const marker = L.circleMarker([point.lat, point.lon], {
        radius: isSelf ? 8 : 6,
        color,
        weight: isSelf ? 2.5 : 1.5,
        fillColor: color,
        fillOpacity: isSelf ? 0.85 : 0.35,
      });
      marker.bindPopup(
        `<div style="font-family:ui-sans-serif,system-ui;font-size:12px;color:#0b1017"><strong>${point.label || point.id}</strong>${
          point.detail ? `<br/>${point.detail}` : ''
        }<br/><span style="opacity:.65">${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}</span></div>`,
      );
      marker.addTo(layer);
    }

    if (track && track.length > 1) {
      if (!trackLine.current) {
        trackLine.current = L.polyline(track.map((point) => [point.lat, point.lon] as [number, number]), {
          color: '#2dd4bf',
          weight: 2,
          opacity: 0.55,
        }).addTo(map);
      } else {
        trackLine.current.setLatLngs(track.map((point) => [point.lat, point.lon] as [number, number]));
      }
    } else if (trackLine.current) {
      trackLine.current.remove();
      trackLine.current = null;
    }

    if (valid.length && (follow || !centered.current)) {
      centered.current = true;
      map.setView([valid[0].lat, valid[0].lon], follow ? 14 : 11, { animate: false });
    }
  }, [points, track, follow]);

  return (
    <div className="map" style={{ height }} ref={containerRef}>
      {!points.length && (
        <div className="empty" style={{ position: 'absolute', inset: 0, zIndex: 400, pointerEvents: 'none' }}>
          No position yet
        </div>
      )}
    </div>
  );
}
