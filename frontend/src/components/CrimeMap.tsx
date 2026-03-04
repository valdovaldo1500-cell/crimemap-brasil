'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { fetchHeatmapMunicipios, fetchHeatmapBairros, fetchLocationStats } from '@/lib/api';
import { normalizeGeoName } from '@/lib/normalize';
interface Props { center:[number,number]; zoom:number; filters:any; viewMode?:'dots'|'choropleth'; }

const DATA_SOURCES = [
  { state: 'RS', name: 'Secretaria da Segurança Pública - SSP/RS', url: 'https://www.ssp.rs.gov.br/dados-abertos' },
];

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

function prettifyCrimeType(s: string): string {
  return s.toLowerCase()
    .replace(/\bacao\b/g, 'ação').replace(/acoes\b/g, 'ações')
    .replace(/ameaca/g, 'ameaça').replace(/anca\b/g, 'ança')
    .replace(/encia\b/g, 'ência').replace(/ancia\b/g, 'ância')
    .replace(/icao\b/g, 'ição').replace(/ucao\b/g, 'ução')
    .replace(/ecao\b/g, 'eção')
    .replace(/omica/g, 'ômica').replace(/omico/g, 'ômico')
    .replace(/orcao/g, 'orção')
    .replace(/\bcrianca/g, 'criança')
    .replace(/prostituicao/g, 'prostituição')
    .replace(/corrupcao/g, 'corrupção')
    .replace(/(^|\s)\S/g, c => c.toUpperCase());
}

function buildBreakdownPopup(displayName: string, stats: any): string {
  const rows = (stats.crime_types || []).map((ct: any) =>
    `<tr><td>${prettifyCrimeType(ct.tipo_enquadramento)}</td><td style="text-align:right;padding-left:12px">${ct.count.toLocaleString()}</td></tr>`
  ).join('');
  return (
    `<div class="popup-title">${displayName}</div>` +
    `<div class="popup-detail"><strong>${stats.total.toLocaleString()}</strong> ocorrências</div>` +
    (rows ? `<table class="popup-breakdown">${rows}</table>` : '')
  );
}

export default function CrimeMap({ center, zoom, filters, viewMode = 'dots' }: Props) {
  const mapRef = useRef<L.Map|null>(null);
  const markersRef = useRef<L.LayerGroup|null>(null);
  const geoJsonRef = useRef<L.GeoJSON|null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const geoDataRef = useRef<any>(null);
  const bairroGeoDataRef = useRef<any>(null);
  const filtersRef = useRef(filters);
  const [currentZoom, setCurrentZoom] = useState(zoom);
  const [loading, setLoading] = useState(false);
  const [mapVersion, setMapVersion] = useState(0);
  const [showSources, setShowSources] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>|null>(null);

  useEffect(() => { filtersRef.current = filters; }, [filters]);

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
    fetch('/geo/rs-municipios.geojson')
      .then(r => r.json())
      .then(data => { geoDataRef.current = data; setMapVersion(v => v + 1); })
      .catch(() => {});
    fetch('/geo/rs-bairros.geojson')
      .then(r => r.json())
      .then(data => { bairroGeoDataRef.current = data; setMapVersion(v => v + 1); })
      .catch(() => {});
    return () => { map.remove(); mapRef.current = null; };
  }, []);
  useEffect(() => {
    if (mapRef.current) mapRef.current.setView(center, zoom);
  }, [center, zoom]);

  const bindInteractions = (layer: L.Layer, displayName: string, count: number, municipio: string, bairro?: string) => {
    const l = layer as any;
    l.bindTooltip(`<b>${displayName}</b><br>${count.toLocaleString()} ocorrências<br><span style="font-size:10px;color:#64748b">Clique para detalhes</span>`, { sticky: true });
    l.bindPopup(
      `<div class="popup-title">${displayName}</div>` +
      `<div class="popup-detail"><strong>${count.toLocaleString()}</strong> ocorrências</div>` +
      `<div class="popup-detail" style="margin-top:6px;font-size:10px;color:#64748b">Clique para detalhes...</div>`
    );
    l.on('click', async () => {
      l.setPopupContent('Carregando...');
      try {
        const f = filtersRef.current;
        const stats = await fetchLocationStats({
          municipio, bairro,
          semestre: f.semestre, ano: f.ano, tipo: f.tipo,
        });
        l.setPopupContent(buildBreakdownPopup(displayName, stats));
      } catch {
        l.setPopupContent(
          `<div class="popup-title">${displayName}</div>` +
          `<div class="popup-detail">Erro ao carregar detalhes</div>`
        );
      }
    });
  };

  const addPolygonHover = (layer: L.Layer) => {
    layer.on('mouseover', () => (layer as any).setStyle({ fillOpacity: 0.85, weight: 2, color: '#3b82f6' }));
    layer.on('mouseout', () => geoJsonRef.current?.resetStyle(layer as L.Path));
  };

  const loadData = useCallback(async () => {
    if (!mapRef.current) return;
    setLoading(true);
    const bounds = mapRef.current.getBounds();
    const params: any = {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
    };
    if (filters.tipo) params.tipo = filters.tipo;
    if (filters.municipio) params.municipio = filters.municipio;
    if (filters.semestre) params.semestre = filters.semestre;
    if (filters.ano) params.ano = filters.ano;
    if (currentZoom >= 13) {
      const latPad = (params.north - params.south) * 0.5;
      const lngPad = (params.east - params.west) * 0.5;
      params.south -= latPad;
      params.north += latPad;
      params.west -= lngPad;
      params.east += lngPad;
    }
    try {
      const useChoropleth = viewMode === 'choropleth' && currentZoom < 13;
      const useBubbleChoropleth = viewMode === 'choropleth' && currentZoom >= 13;
      let data = currentZoom < 13
        ? await fetchHeatmapMunicipios(params)
        : await fetchHeatmapBairros(params);
      // Clear old layers AFTER data arrives (prevents blank flash)
      if (markersRef.current) markersRef.current.clearLayers();
      if (geoJsonRef.current) { mapRef.current.removeLayer(geoJsonRef.current); geoJsonRef.current = null; }
      if (!data || data.length === 0) return;
      if (currentZoom >= 13) {
        data = data.filter((d: any) => d.weight >= 10);
        if (data.length === 0) return;
      }
      const weights = data.map((d:any) => d.weight);
      const maxW = Math.max(...weights);
      const minW = Math.min(...weights);
      const range = maxW - minW || 1;
      data.sort((a: any, b: any) => b.weight - a.weight);

      // Build centroid lookup from GeoJSON for municipality positioning
      const centroids: Record<string, [number, number]> = {};
      if (geoDataRef.current) {
        geoDataRef.current.features.forEach((f: any) => {
          const name = normalizeGeoName(f.properties?.name || '');
          const center = L.geoJSON(f).getBounds().getCenter();
          centroids[name] = [center.lat, center.lng];
        });
      }

      if (useChoropleth && geoDataRef.current) {
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
              bindInteractions(layer, displayName, info.weight, displayName);
              addPolygonHover(layer);
              const ctr = L.geoJSON(feature).getBounds().getCenter();
              const lbl = L.marker(ctr, {
                icon: L.divIcon({
                  className: 'choropleth-label',
                  html: `<span style="color:#fff;font-size:11px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.9)">${formatCount(info.weight)}</span>`,
                  iconSize: [40, 16], iconAnchor: [20, 8],
                }), interactive: false
              });
              markersRef.current?.addLayer(lbl);
            } else {
              layer.bindTooltip(`<b>${displayName}</b><br>Sem dados`, { sticky: true });
            }
          }
        }).addTo(mapRef.current);
      } else if (useBubbleChoropleth) {
        const bairroLookup: Record<string, {weight:number, intensity:number, municipio:string, bairro:string}> = {};
        data.forEach((d:any) => {
          const munKey = normalizeGeoName(d.municipio || '');
          const bairroKey = normalizeGeoName(d.bairro || '');
          const key = munKey + '|' + bairroKey;
          const intensity = (d.weight - minW) / range;
          bairroLookup[key] = { weight: d.weight, intensity, municipio: d.municipio, bairro: d.bairro };
        });

        const matchedKeys = new Set<string>();

        if (bairroGeoDataRef.current) {
          const mapBounds = mapRef.current!.getBounds();

          const filteredGeoData = {
            type: 'FeatureCollection' as const,
            features: bairroGeoDataRef.current.features.filter((f: any) => {
              try {
                const featureBounds = L.geoJSON(f).getBounds();
                return mapBounds.intersects(featureBounds);
              } catch { return false; }
            })
          };

          geoJsonRef.current = L.geoJSON(filteredGeoData, {
            style: (feature) => {
              const props = feature?.properties || {};
              const key = (props.municipio_normalized || '') + '|' + (props.name_normalized || '');
              const info = bairroLookup[key];
              if (info) {
                return {
                  fillColor: getColor(info.intensity),
                  fillOpacity: 0.65,
                  color: '#1e293b',
                  weight: 1,
                };
              }
              return { fillColor: '#1e293b', fillOpacity: 0.1, color: '#1e293b', weight: 0.5 };
            },
            onEachFeature: (feature, layer) => {
              const props = feature?.properties || {};
              const key = (props.municipio_normalized || '') + '|' + (props.name_normalized || '');
              const info = bairroLookup[key];
              const displayName = props.name || '';
              const municipio = props.municipio || '';
              if (info) {
                matchedKeys.add(key);
                bindInteractions(layer, `${displayName}, ${municipio}`, info.weight, municipio, displayName);
                addPolygonHover(layer);
                const ctr = L.geoJSON(feature).getBounds().getCenter();
                const lbl = L.marker(ctr, {
                  icon: L.divIcon({
                    className: 'choropleth-label',
                    html: `<span style="color:#fff;font-size:11px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.9)">${formatCount(info.weight)}</span>`,
                    iconSize: [40, 16], iconAnchor: [20, 8],
                  }), interactive: false
                });
                markersRef.current?.addLayer(lbl);
              }
            }
          }).addTo(mapRef.current!);
        }

        // Fallback: circleMarkers for unmatched bairros
        data.forEach((d:any) => {
          const munKey = normalizeGeoName(d.municipio || '');
          const bairroKey = normalizeGeoName(d.bairro || '');
          const key = munKey + '|' + bairroKey;
          if (matchedKeys.has(key)) return;
          const intensity = (d.weight - minW) / range;
          const color = getColor(intensity);
          const label = d.bairro ? d.bairro + ', ' + d.municipio : d.municipio;
          const displayName = d.bairro || d.municipio;
          const radius = 30 + intensity * 40;
          const circle = L.circleMarker([d.latitude, d.longitude], {
            radius,
            fillColor: color,
            fillOpacity: 0.55,
            color,
            weight: 2,
            opacity: 0.3,
          });
          bindInteractions(circle, label, d.weight, d.municipio, d.bairro || undefined);
          markersRef.current?.addLayer(circle);
        });
      } else {
        // Dot mode: numbered markers
        data.forEach((d:any) => {
          const intensity = (d.weight - minW) / range;
          const color = getColor(intensity);
          const label = d.bairro ? d.bairro + ', ' + d.municipio : d.municipio;
          const geoKey = normalizeGeoName(d.municipio || '');
          const [lat, lng] = (currentZoom < 13 && centroids[geoKey]) ? centroids[geoKey] : [d.latitude, d.longitude];
          const size = Math.round(28 + intensity * 28);
          const fontSize = Math.round(10 + intensity * 6);
          const icon = L.divIcon({
            className: 'crime-dot-icon',
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
            html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid ${color};opacity:0.85;display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:${fontSize}px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.7);line-height:1;">${formatCount(d.weight)}</span></div>`
          });
          const marker = L.marker([lat, lng], { icon, zIndexOffset: Math.round((1 - intensity) * 1000) });
          bindInteractions(marker, label, d.weight, d.municipio, d.bairro || undefined);
          markersRef.current?.addLayer(marker);
        });
      }
    } catch (e) { console.error('Load error:', e); } finally { setLoading(false); }
  }, [currentZoom, filters, mapVersion, viewMode]);
  useEffect(() => { loadData(); }, [loadData]);
  return (
    <div className="w-full h-full relative">
      <div ref={containerRef} className="w-full h-full" />
      {loading && (
        <div className="absolute bottom-4 right-14 z-[1000] pointer-events-none">
          <div className="bg-[#111827]/80 backdrop-blur-sm rounded-lg px-3 py-1.5 flex items-center gap-2">
            <div className="w-3 h-3 border-2 border-[#3b82f6] border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-[#94a3b8]">Carregando...</span>
          </div>
        </div>
      )}
      <div className="absolute top-4 left-4 z-[1000] flex flex-col gap-1">
        <div className="bg-[#111827]/90 backdrop-blur-xl rounded-lg border border-[#1e293b] px-3 py-1.5">
          <span className="text-[10px] text-[#94a3b8] uppercase tracking-wider">
            {currentZoom < 13 ? 'Municípios' : 'Bairros'}
          </span>
        </div>
        <div className="flex gap-1">
          {[{c:'#22c55e',l:'Baixo'},{c:'#eab308',l:'Médio'},{c:'#f97316',l:'Alto'},{c:'#ef4444',l:'Crítico'}].map(i=>(
            <div key={i.l} className="flex items-center gap-1 bg-[#111827]/90 backdrop-blur-xl rounded-lg border border-[#1e293b] px-2 py-1">
              <div className="w-2 h-2 rounded-full" style={{background:i.c}} />
              <span className="text-[10px] text-[#94a3b8]">{i.l}</span>
            </div>
          ))}
        </div>
      </div>
      <button
        className="absolute bottom-4 right-4 z-[1000] bg-[#111827]/80 backdrop-blur-xl border border-[#1e293b] rounded-lg px-2.5 py-1 text-[10px] text-[#94a3b8] hover:text-[#f1f5f9] hover:border-[#3b82f6] transition-colors"
        onClick={() => setShowSources(!showSources)}
      >
        Fontes
      </button>
      {showSources && (
        <div className="absolute bottom-12 right-4 z-[1000] bg-[#111827]/95 backdrop-blur-xl border border-[#1e293b] rounded-xl p-4 max-w-xs">
          <h4 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Fontes de Dados</h4>
          {DATA_SOURCES.map(s => (
            <a key={s.state} href={s.url} target="_blank" rel="noopener noreferrer"
              className="block text-sm text-[#3b82f6] hover:underline mb-1">
              {s.name}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
