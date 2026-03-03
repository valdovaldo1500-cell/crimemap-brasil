'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { fetchHeatmapMunicipios, fetchHeatmapBairros } from '@/lib/api';
import { normalizeGeoName } from '@/lib/normalize';
interface Props { center:[number,number]; zoom:number; filters:any; viewMode?:'dots'|'choropleth'; }

function formatCount(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function getColor(intensity: number): string {
  if (intensity > 0.75) return '#ef4444';
  if (intensity > 0.5) return '#f97316';
  if (intensity > 0.25) return '#eab308';
  return '#22c55e';
}

export default function CrimeMap({ center, zoom, filters, viewMode = 'dots' }: Props) {
  const mapRef = useRef<L.Map|null>(null);
  const markersRef = useRef<L.LayerGroup|null>(null);
  const geoJsonRef = useRef<L.GeoJSON|null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const geoDataRef = useRef<any>(null);
  const [currentZoom, setCurrentZoom] = useState(zoom);
  const [mapVersion, setMapVersion] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center, zoom, zoomControl: false, attributionControl: false
    });
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      { maxZoom: 19 }
    ).addTo(map);
    const onMove = () => {
      setCurrentZoom(map.getZoom());
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setMapVersion(v => v + 1), 300);
    };
    map.on("zoomend", onMove);
    map.on("moveend", onMove);
    mapRef.current = map;
    markersRef.current = L.layerGroup().addTo(map);
    // Preload GeoJSON
    fetch('/geo/rs-municipios.geojson')
      .then(r => r.json())
      .then(data => { geoDataRef.current = data; })
      .catch(() => {});
    return () => { map.remove(); mapRef.current = null; };
  }, []);
  useEffect(() => {
    if (mapRef.current) mapRef.current.setView(center, zoom);
  }, [center, zoom]);
  const loadData = useCallback(async () => {
    if (!mapRef.current) return;
    const bounds = mapRef.current.getBounds();
    const params: any = {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
    };
    if (filters.tipo) params.tipo = filters.tipo;
    if (filters.municipio) params.municipio = filters.municipio;
    try {
      if (markersRef.current) markersRef.current.clearLayers();
      if (geoJsonRef.current) { mapRef.current.removeLayer(geoJsonRef.current); geoJsonRef.current = null; }

      const useChoropleth = viewMode === 'choropleth' && currentZoom < 10;
      const data = currentZoom < 10
        ? await fetchHeatmapMunicipios(params)
        : await fetchHeatmapBairros(params);
      if (!data || data.length === 0) return;
      const weights = data.map((d:any) => d.weight);
      const maxW = Math.max(...weights);
      const minW = Math.min(...weights);
      const range = maxW - minW || 1;

      if (useChoropleth && geoDataRef.current) {
        // Build lookup: normalized municipio name -> {weight, intensity}
        const lookup: Record<string, {weight:number, intensity:number}> = {};
        data.forEach((d:any) => {
          const key = normalizeGeoName(d.municipio || '');
          const intensity = (d.weight - minW) / range;
          lookup[key] = { weight: d.weight, intensity };
        });

        geoJsonRef.current = L.geoJSON(geoDataRef.current, {
          style: (feature) => {
            const name = normalizeGeoName(feature?.properties?.name || '');
            const info = lookup[name];
            if (info) {
              return {
                fillColor: getColor(info.intensity),
                fillOpacity: 0.65,
                color: '#1e293b',
                weight: 1,
              };
            }
            return { fillColor: '#1e293b', fillOpacity: 0.2, color: '#1e293b', weight: 1 };
          },
          onEachFeature: (feature, layer) => {
            const name = normalizeGeoName(feature?.properties?.name || '');
            const displayName = feature?.properties?.name || '';
            const info = lookup[name];
            if (info) {
              layer.bindPopup(
                '<div class="popup-title">' + displayName + '</div>' +
                '<div class="popup-detail"><strong>' + info.weight.toLocaleString() +
                '</strong> ocorrencias</div>'
              );
            } else {
              layer.bindPopup('<div class="popup-title">' + displayName + '</div><div class="popup-detail">Sem dados</div>');
            }
          }
        }).addTo(mapRef.current);
      } else {
        // Dot mode
        data.forEach((d:any) => {
          const intensity = (d.weight - minW) / range;
          const color = getColor(intensity);
          const label = d.bairro ? d.bairro + ', ' + d.municipio : d.municipio;
          const size = Math.round(28 + intensity * 28);
          const fontSize = Math.round(10 + intensity * 6);
          const icon = L.divIcon({
            className: 'crime-dot-icon',
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
            html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid ${color};opacity:0.85;display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:${fontSize}px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.7);line-height:1;">${formatCount(d.weight)}</span></div>`
          });
          const marker = L.marker([d.latitude, d.longitude], { icon });
          marker.bindPopup(
            '<div class="popup-title">' + label + '</div>' +
            '<div class="popup-detail"><strong>' + d.weight.toLocaleString() +
            '</strong> ocorrencias</div>'
          );
          markersRef.current?.addLayer(marker);
        });
      }
    } catch (e) { console.error('Load error:', e); }
  }, [currentZoom, filters, mapVersion, viewMode]);
  useEffect(() => { loadData(); }, [loadData]);
  return (
    <div className="w-full h-full relative">
      <div ref={containerRef} className="w-full h-full" />
      <div className="absolute top-4 right-16 z-[1000] flex gap-1">
        {[{c:'#22c55e',l:'Baixo'},{c:'#eab308',l:'Medio'},{c:'#f97316',l:'Alto'},{c:'#ef4444',l:'Critico'}].map(i=>(
          <div key={i.l} className="flex items-center gap-1 bg-[#111827]/90 backdrop-blur-xl rounded-lg border border-[#1e293b] px-2 py-1">
            <div className="w-2 h-2 rounded-full" style={{background:i.c}} />
            <span className="text-[10px] text-[#94a3b8]">{i.l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
