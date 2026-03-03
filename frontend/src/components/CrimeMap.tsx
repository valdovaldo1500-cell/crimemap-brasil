'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { fetchHeatmapMunicipios, fetchHeatmapBairros } from '@/lib/api';
// @ts-ignore
import 'leaflet.heat';
interface Props { center:[number,number]; zoom:number; filters:any; }
export default function CrimeMap({ center, zoom, filters }: Props) {
  const mapRef = useRef<L.Map|null>(null);
  const heatRef = useRef<any>(null);
  const markersRef = useRef<L.LayerGroup|null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentZoom, setCurrentZoom] = useState(zoom);
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
    map.on("zoomend", () => setCurrentZoom(map.getZoom()));
    mapRef.current = map;
    markersRef.current = L.layerGroup().addTo(map);
    return () => { map.remove(); mapRef.current = null; };
  }, []);
  useEffect(() => {
    if (mapRef.current) mapRef.current.setView(center, zoom);
  }, [center, zoom]);
  const loadData = useCallback(async () => {
    if (!mapRef.current) return;
    const params: any = {};
    if (filters.tipo) filters.tipo.forEach((t:string) => { params['tipo'] = t; });
    if (filters.municipio) params.municipio = filters.municipio;
    try {
      if (heatRef.current) mapRef.current.removeLayer(heatRef.current);
      if (markersRef.current) markersRef.current.clearLayers();
      const data = currentZoom < 10
        ? await fetchHeatmapMunicipios(params)
        : await fetchHeatmapBairros(params);
      if (!data || data.length === 0) return;
      const maxW = Math.max(...data.map((d:any) => d.weight));
      const pts = data.map((d:any) => [d.latitude, d.longitude, d.weight/maxW]);
      // @ts-ignore
      heatRef.current = L.heatLayer(pts, {
        radius: currentZoom < 10 ? 35 : 25,
        blur: currentZoom < 10 ? 20 : 15,
        maxZoom: 17, max: 1.0,
        gradient: {
          0.0: '#1a1a2e', 0.15: '#16213e', 0.3: '#0f3460',
          0.45: '#533483', 0.6: '#e94560', 0.75: '#f59e0b',
          0.9: '#ef4444', 1.0: '#dc2626'
        }
      }).addTo(mapRef.current);
      data.forEach((d:any) => {
        const intensity = d.weight / maxW;
        let color = '#22c55e';
        if (intensity > 0.7) color = '#ef4444';
        else if (intensity > 0.4) color = '#f59e0b';
        else if (intensity > 0.2) color = '#3b82f6';
        const label = d.bairro ? d.bairro + ', ' + d.municipio : d.municipio;
        const marker = L.circleMarker([d.latitude, d.longitude], {
          radius: Math.max(4, Math.min(20, intensity * 20)),
          fillColor: color, color: color, weight: 1,
          opacity: 0.8, fillOpacity: 0.4
        });
        marker.bindPopup(
          '<div class="popup-title">' + label + '</div>' +
          '<div class="popup-detail"><strong>' + d.weight.toLocaleString() +
          '</strong> ocorrencias</div>'
        );
        markersRef.current?.addLayer(marker);
      });
    } catch (e) { console.error('Load error:', e); }
  }, [currentZoom, filters]);
  useEffect(() => { loadData(); }, [loadData]);
  return (
    <div className="w-full h-full relative">
      <div ref={containerRef} className="w-full h-full" />
      <div className="absolute top-4 left-4 z-[1000] bg-[#111827]/90 backdrop-blur-xl rounded-xl border border-[#1e293b] px-3 py-2">
        <p className="text-[10px] text-[#94a3b8] uppercase tracking-wider">
          {currentZoom < 10 ? 'Vista por municipio' : 'Vista por bairro'}
        </p>
      </div>
      <div className="absolute top-4 right-16 z-[1000] flex gap-1">
        {[{c:'#22c55e',l:'Baixo'},{c:'#3b82f6',l:'Medio'},{c:'#f59e0b',l:'Alto'},{c:'#ef4444',l:'Critico'}].map(i=>(
          <div key={i.l} className="flex items-center gap-1 bg-[#111827]/90 backdrop-blur-xl rounded-lg border border-[#1e293b] px-2 py-1">
            <div className="w-2 h-2 rounded-full" style={{background:i.c}} />
            <span className="text-[10px] text-[#94a3b8]">{i.l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}