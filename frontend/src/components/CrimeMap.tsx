'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { fetchHeatmapMunicipios, fetchHeatmapBairros } from '@/lib/api';
interface Props { center:[number,number]; zoom:number; filters:any; }
export default function CrimeMap({ center, zoom, filters }: Props) {
  const mapRef = useRef<L.Map|null>(null);
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
      if (markersRef.current) markersRef.current.clearLayers();
      const data = currentZoom < 10
        ? await fetchHeatmapMunicipios(params)
        : await fetchHeatmapBairros(params);
      if (!data || data.length === 0) return;
      const maxW = Math.max(...data.map((d:any) => d.weight));
      data.forEach((d:any) => {
        const intensity = d.weight / maxW;
        let color = '#22c55e';
        if (intensity > 0.75) color = '#ef4444';
        else if (intensity > 0.5) color = '#f97316';
        else if (intensity > 0.25) color = '#eab308';
        const label = d.bairro ? d.bairro + ', ' + d.municipio : d.municipio;
        const marker = L.circleMarker([d.latitude, d.longitude], {
          radius: Math.max(4, Math.min(20, intensity * 20)),
          fillColor: color, color: color, weight: 2,
          opacity: 0.8, fillOpacity: 0.7
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
