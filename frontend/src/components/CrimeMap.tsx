'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { fetchHeatmapMunicipios, fetchHeatmapBairros, fetchHeatmapStates, fetchLocationStats } from '@/lib/api';
import { normalizeGeoName } from '@/lib/normalize';
interface Props { center:[number,number]; zoom:number; filters:any; viewMode?:'dots'|'choropleth'; aggregationOverride?:'auto'|'municipios'|'bairros'; }

const DATA_SOURCES = [
  { state: 'RS', name: 'Secretaria da Segurança Pública - SSP/RS' },
  { state: 'SP', name: 'Secretaria da Segurança Pública - SSP/SP (em breve)' },
  { state: 'SINESP', name: 'Sistema Nacional de Estatísticas de Segurança Pública (em breve)' },
];

function formatCount(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function getColor(intensity: number): string {
  if (intensity > 0.75) return '#ef4444';
  if (intensity > 0.5) return '#f472b6';
  if (intensity > 0.25) return '#a78bfa';
  return '#60a5fa';
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

export default function CrimeMap({ center, zoom, filters, viewMode = 'dots', aggregationOverride = 'auto' }: Props) {
  const mapRef = useRef<L.Map|null>(null);
  const markersRef = useRef<L.LayerGroup|null>(null);
  const geoJsonRef = useRef<L.GeoJSON|null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const geoDataRef = useRef<any>(null);
  const bairroGeoDataRef = useRef<any>(null);
  const statesGeoDataRef = useRef<any>(null);
  const filtersRef = useRef(filters);
  const [currentZoom, setCurrentZoom] = useState(zoom);
  const [loading, setLoading] = useState(false);
  const [mapVersion, setMapVersion] = useState(0);
  const [showSources, setShowSources] = useState(false);
  const [nonRsInfo, setNonRsInfo] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  const loadIdRef = useRef(0);
  const popupOpenRef = useRef(false);
  const boundsAtPopupOpenRef = useRef<string|null>(null);
  const pendingPopupRef = useRef<{municipio:string, bairro?:string, displayName:string, latlng:[number,number]}|null>(null);

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
      if (popupOpenRef.current) return; // don't reload while popup is open
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
    fetch('/geo/br-states.geojson')
      .then(r => r.json())
      .then(data => { statesGeoDataRef.current = data; setMapVersion(v => v + 1); })
      .catch(() => {});
    return () => { map.remove(); mapRef.current = null; };
  }, []);
  useEffect(() => {
    if (mapRef.current) mapRef.current.setView(center, zoom);
  }, [center, zoom]);

  const trackPopup = (l: any) => {
    l.on('popupopen', () => {
      popupOpenRef.current = true;
      if (mapRef.current) {
        const b = mapRef.current.getBounds();
        boundsAtPopupOpenRef.current = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
      }
    });
    l.on('popupclose', () => {
      popupOpenRef.current = false;
      if (mapRef.current) {
        const b = mapRef.current.getBounds();
        const currentBounds = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
        if (currentBounds !== boundsAtPopupOpenRef.current) {
          setMapVersion(v => v + 1);
        }
      }
      boundsAtPopupOpenRef.current = null;
    });
  };

  const bindInteractions = (layer: L.Layer, displayName: string, count: number, municipio: string, bairro?: string, components?: {bairro: string, weight: number}[]) => {
    const l = layer as any;
    l.bindTooltip(`<b>${displayName}</b><br>${count.toLocaleString()} ocorrências<br><span style="font-size:10px;color:#64748b">Clique para detalhes</span>`, { sticky: true });
    l.bindPopup(
      `<div class="popup-title">${displayName}</div>` +
      `<div class="popup-detail"><strong>${count.toLocaleString()}</strong> ocorrências</div>` +
      `<div class="popup-detail" style="margin-top:6px;font-size:10px;color:#64748b">Clique para detalhes...</div>`
    );
    trackPopup(l);
    l.on('click', async () => {
      popupOpenRef.current = true;
      if (bairro === 'Bairro desconhecido' && components) {
        const rows = components.map(c =>
          `<tr><td>${c.bairro}</td><td style="text-align:right;padding-left:12px">${c.weight.toLocaleString()}</td></tr>`
        ).join('');
        l.setPopupContent(
          `<div class="popup-title">${displayName}</div>` +
          `<div class="popup-detail"><strong>${count.toLocaleString()}</strong> ocorrências</div>` +
          `<div class="popup-detail" style="margin-top:4px;font-size:11px;color:#94a3b8">` +
          `Bairros com poucas ocorrências ou localização imprecisa:</div>` +
          (rows ? `<table class="popup-breakdown">${rows}</table>` : '')
        );
        l.openPopup();
        return;
      }
      // Store pending popup info so it can be re-opened after a reload
      const latlng: [number, number] = l.getLatLng ? [l.getLatLng().lat, l.getLatLng().lng] : [0, 0];
      pendingPopupRef.current = { municipio, bairro, displayName, latlng };
      const loadingHtml = '<div style="display:flex;align-items:center;gap:8px;padding:4px 0">' +
        '<div style="width:16px;height:16px;border:2px solid #3b82f6;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite"></div>' +
        '<span style="color:#94a3b8;font-size:13px">Carregando...</span></div>' +
        '<style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
      l.setPopupContent(loadingHtml);
      l.openPopup();
      try {
        const f = filtersRef.current;
        const stats = await fetchLocationStats({
          municipio, bairro,
          semestre: f.semestre, ano: f.ano, tipo: f.tipo,
          grupo: f.grupo, sexo: f.sexo, cor: f.cor,
          idade_min: f.idade_min, idade_max: f.idade_max,
        });
        l.setPopupContent(buildBreakdownPopup(displayName, stats));
        pendingPopupRef.current = null;
      } catch (err) {
        console.error('Failed to load location stats:', err);
        l.setPopupContent(
          `<div class="popup-title">${displayName}</div>` +
          `<div class="popup-detail">Erro ao carregar detalhes</div>`
        );
        pendingPopupRef.current = null;
      }
    });
  };

  const bindStateInteractions = (layer: L.Layer, stateName: string, sigla: string, weight: number, feature: any) => {
    const l = layer as any;
    l.bindTooltip(`<b>${stateName} (${sigla})</b><br>${weight.toLocaleString()} ocorrências<br><span style="font-size:10px;color:#64748b">Clique para detalhes</span>`, { sticky: true });
    l.bindPopup(
      `<div class="popup-title">${stateName} (${sigla})</div>` +
      `<div class="popup-detail"><strong>${weight.toLocaleString()}</strong> ocorrências</div>` +
      `<div class="popup-detail" style="margin-top:6px;font-size:11px;color:#94a3b8">Zoom para ver municípios</div>`
    );
    trackPopup(l);
    l.on('click', () => {
      l.openPopup();
      const bounds = L.geoJSON(feature).getBounds();
      mapRef.current?.fitBounds(bounds, { padding: [20, 20] });
    });
  };

  const addPolygonHover = (layer: L.Layer) => {
    layer.on('mouseover', () => (layer as any).setStyle({ fillOpacity: 0.85, weight: 2, color: '#3b82f6' }));
    layer.on('mouseout', () => geoJsonRef.current?.resetStyle(layer as L.Path));
  };

  const autoLevel = currentZoom < 7 ? 'states' : currentZoom < 11 ? 'municipios' : 'bairros';
  const zoomLevel = aggregationOverride === 'auto' ? autoLevel
    : aggregationOverride === 'bairros' && currentZoom >= 7 ? 'bairros'
    : aggregationOverride === 'municipios' && currentZoom >= 7 ? 'municipios'
    : autoLevel;

  const loadData = useCallback(async () => {
    if (!mapRef.current) return;
    const thisLoadId = ++loadIdRef.current;
    setLoading(true);
    const bounds = mapRef.current.getBounds();
    const params: any = {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
    };
    if (filters.tipo) params.tipo = filters.tipo;
    if (filters.grupo) params.grupo = filters.grupo;
    if (filters.semestre) params.semestre = filters.semestre;
    if (filters.ano) params.ano = filters.ano;
    if (filters.sexo) params.sexo = filters.sexo;
    if (filters.cor) params.cor = filters.cor;
    if (filters.idade_min !== undefined) params.idade_min = filters.idade_min;
    if (filters.idade_max !== undefined) params.idade_max = filters.idade_max;
    if (filters.state) params.state = filters.state;
    if (zoomLevel === 'bairros') {
      const latPad = (params.north - params.south) * 1.0;
      const lngPad = (params.east - params.west) * 1.0;
      params.south -= latPad;
      params.north += latPad;
      params.west -= lngPad;
      params.east += lngPad;
    }
    try {
      if (zoomLevel === 'states') {
        // State-level view
        const data = await fetchHeatmapStates(params);
        if (thisLoadId !== loadIdRef.current) return; // stale request
        if (markersRef.current) markersRef.current.clearLayers();
        if (geoJsonRef.current) { mapRef.current.removeLayer(geoJsonRef.current); geoJsonRef.current = null; }
        if (!data || data.length === 0) {
          // Show empty state GeoJSON
          if (statesGeoDataRef.current && viewMode === 'choropleth') {
            geoJsonRef.current = L.geoJSON(statesGeoDataRef.current, {
              style: () => ({ fillColor: '#1e293b', fillOpacity: 0.2, color: '#1e293b', weight: 1 }),
              onEachFeature: (feature, layer) => {
                const sigla = feature?.properties?.sigla || '';
                const name = feature?.properties?.name || '';
                layer.bindTooltip(`<b>${name} (${sigla})</b><br>Sem dados`, { sticky: true });
              }
            }).addTo(mapRef.current!);
          }
          return;
        }
        const weights = data.map((d:any) => d.weight);
        const maxW = Math.max(...weights);
        const minW = Math.min(...weights);
        const range = maxW - minW || 1;
        const stateLookup: Record<string, {weight:number, intensity:number}> = {};
        data.forEach((d:any) => {
          const intensity = (d.weight - minW) / range;
          stateLookup[d.state] = { weight: d.weight, intensity };
        });

        if (statesGeoDataRef.current && viewMode === 'choropleth') {
          geoJsonRef.current = L.geoJSON(statesGeoDataRef.current, {
            style: (feature) => {
              const sigla = feature?.properties?.sigla || '';
              const info = stateLookup[sigla];
              if (info) {
                return { fillColor: getColor(info.intensity), fillOpacity: 0.45, color: '#1e293b', weight: 1 };
              }
              return { fillColor: '#1e293b', fillOpacity: 0.2, color: '#1e293b', weight: 1 };
            },
            onEachFeature: (feature, layer) => {
              const sigla = feature?.properties?.sigla || '';
              const name = feature?.properties?.name || '';
              const info = stateLookup[sigla];
              if (info) {
                bindStateInteractions(layer, name, sigla, info.weight, feature);
                addPolygonHover(layer);
                const ctr = L.geoJSON(feature).getBounds().getCenter();
                const lbl = L.marker(ctr, {
                  icon: L.divIcon({
                    className: 'choropleth-label',
                    html: `<span style="color:#fff;font-size:12px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.9)">${sigla}<br>${formatCount(info.weight)}</span>`,
                    iconSize: [50, 30], iconAnchor: [25, 15],
                  }), interactive: false
                });
                markersRef.current?.addLayer(lbl);
              } else {
                layer.bindTooltip(`<b>${name} (${sigla})</b><br>Sem dados`, { sticky: true });
              }
            }
          }).addTo(mapRef.current!);
        } else {
          // Dot mode for states
          data.forEach((d:any) => {
            const intensity = (d.weight - minW) / range;
            const color = getColor(intensity);
            const size = Math.round(36 + intensity * 30);
            const fontSize = Math.round(11 + intensity * 5);
            const icon = L.divIcon({
              className: 'crime-dot-icon',
              iconSize: [size, size],
              iconAnchor: [size / 2, size / 2],
              html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid ${color};opacity:0.85;display:flex;align-items:center;justify-content:center;flex-direction:column"><span style="color:#fff;font-size:${fontSize}px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.7);line-height:1;">${d.state}</span><span style="color:#fff;font-size:${fontSize - 2}px;text-shadow:0 1px 3px rgba(0,0,0,0.7);line-height:1;">${formatCount(d.weight)}</span></div>`
            });
            const marker = L.marker([d.latitude, d.longitude], { icon });
            const stateFeature = statesGeoDataRef.current?.features.find(
              (f: any) => f.properties?.sigla === d.state
            );
            bindStateInteractions(marker, d.state, d.state, d.weight, stateFeature || { type: 'Feature', geometry: { type: 'Point', coordinates: [d.longitude, d.latitude] }, properties: {} });
            markersRef.current?.addLayer(marker);
          });
        }
      } else {
        // Detect if map center is outside RS (lat ~-27 to -34, lng ~-49 to -58)
        const center = mapRef.current!.getCenter();
        const isRS = center.lat >= -34 && center.lat <= -27 && center.lng >= -58 && center.lng <= -49;
        const effectiveBairro = zoomLevel === 'bairros' && isRS;
        setNonRsInfo(zoomLevel === 'bairros' && !isRS);

        // Municipality or Bairro level (existing logic)
        const useChoropleth = viewMode === 'choropleth' && (zoomLevel === 'municipios' || !effectiveBairro);
        const useBubbleChoropleth = viewMode === 'choropleth' && effectiveBairro;
        let data = !effectiveBairro
          ? await fetchHeatmapMunicipios(params)
          : await fetchHeatmapBairros(params);
        if (thisLoadId !== loadIdRef.current) return; // stale request
        if (markersRef.current) markersRef.current.clearLayers();
        if (geoJsonRef.current) { mapRef.current.removeLayer(geoJsonRef.current); geoJsonRef.current = null; }
        if (!data || data.length === 0) return;
        if (zoomLevel === 'bairros') {
          data = data.filter((d: any) => d.weight >= 5);
          if (data.length === 0) return;
        }
        const weights = data.map((d:any) => d.weight);
        const maxW = Math.max(...weights);
        const minW = Math.min(...weights);
        const range = maxW - minW || 1;
        data.sort((a: any, b: any) => b.weight - a.weight);

        const centroids: Record<string, [number, number]> = {};
        if (geoDataRef.current) {
          geoDataRef.current.features.forEach((f: any) => {
            const name = normalizeGeoName(f.properties?.name || '');
            const center = L.geoJSON(f).getBounds().getCenter();
            centroids[name] = [center.lat, center.lng];
          });
        }

        // Build bairro centroid lookup from bairro GeoJSON for dot placement
        const bairroCentroids: Record<string, [number, number]> = {};
        if (bairroGeoDataRef.current && zoomLevel === 'bairros') {
          bairroGeoDataRef.current.features.forEach((f: any) => {
            const props = f.properties || {};
            const key = (props.municipio_normalized || '') + '|' + (props.name_normalized || '');
            try {
              const center = L.geoJSON(f).getBounds().getCenter();
              bairroCentroids[key] = [center.lat, center.lng];
            } catch { /* skip invalid geometry */ }
          });
        }

        if (useChoropleth && geoDataRef.current) {
          const lookup: Record<string, {weight:number, intensity:number, municipio:string}> = {};
          data.forEach((d:any) => {
            const key = normalizeGeoName(d.municipio || '');
            const intensity = (d.weight - minW) / range;
            lookup[key] = { weight: d.weight, intensity, municipio: d.municipio };
          });

          geoJsonRef.current = L.geoJSON(geoDataRef.current, {
            style: (feature) => {
              const name = normalizeGeoName(feature?.properties?.name || '');
              const info = lookup[name];
              if (info) {
                return { fillColor: getColor(info.intensity), fillOpacity: 0.45, color: '#1e293b', weight: 1 };
              }
              return { fillColor: '#1e293b', fillOpacity: 0.2, color: '#1e293b', weight: 1 };
            },
            onEachFeature: (feature, layer) => {
              const name = normalizeGeoName(feature?.properties?.name || '');
              const displayName = feature?.properties?.name || '';
              const info = lookup[name];
              if (info) {
                bindInteractions(layer, displayName, info.weight, info.municipio);
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
                  return { fillColor: getColor(info.intensity), fillOpacity: 0.35, color: '#1e293b', weight: 1 };
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
            const radius = 30 + intensity * 40;
            const circle = L.circleMarker([d.latitude, d.longitude], {
              radius, fillColor: color, fillOpacity: 0.35, color, weight: 2, opacity: 0.3,
            });
            bindInteractions(circle, label, d.weight, d.municipio, d.bairro || undefined, d.components);
            markersRef.current?.addLayer(circle);
          });
        } else {
          // Dot mode: numbered markers
          data.forEach((d:any) => {
            const intensity = (d.weight - minW) / range;
            const color = getColor(intensity);
            const label = d.bairro ? d.bairro + ', ' + d.municipio : d.municipio;
            const geoKey = normalizeGeoName(d.municipio || '');
            // Use bairro GeoJSON centroid when available, then municipality centroid, then raw coords
            let lat = d.latitude, lng = d.longitude;
            if (zoomLevel === 'bairros' && d.bairro) {
              const bairroKey = normalizeGeoName(d.municipio || '') + '|' + normalizeGeoName(d.bairro || '');
              const bc = bairroCentroids[bairroKey];
              if (bc) { lat = bc[0]; lng = bc[1]; }
            } else if (zoomLevel === 'municipios' && centroids[geoKey]) {
              lat = centroids[geoKey][0]; lng = centroids[geoKey][1];
            }
            const size = Math.round(28 + intensity * 28);
            const fontSize = Math.round(10 + intensity * 6);
            const icon = L.divIcon({
              className: 'crime-dot-icon',
              iconSize: [size, size],
              iconAnchor: [size / 2, size / 2],
              html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid ${color};opacity:0.85;display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:${fontSize}px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.7);line-height:1;">${formatCount(d.weight)}</span></div>`
            });
            const marker = L.marker([lat, lng], { icon, zIndexOffset: Math.round((1 - intensity) * 1000) });
            bindInteractions(marker, label, d.weight, d.municipio, d.bairro || undefined, d.components);
            markersRef.current?.addLayer(marker);
          });
        }
      }
      // Re-open pending popup after reload cleared old layers
      if (pendingPopupRef.current && mapRef.current) {
        const pp = pendingPopupRef.current;
        const loadingHtml = '<div style="display:flex;align-items:center;gap:8px;padding:4px 0">' +
          '<div style="width:16px;height:16px;border:2px solid #3b82f6;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite"></div>' +
          '<span style="color:#94a3b8;font-size:13px">Carregando...</span></div>' +
          '<style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
        const popup = L.popup({ closeOnClick: true }).setLatLng(pp.latlng).setContent(loadingHtml).openOn(mapRef.current);
        popupOpenRef.current = true;
        popup.on('remove', () => { popupOpenRef.current = false; });
        (async () => {
          try {
            const f = filtersRef.current;
            const stats = await fetchLocationStats({
              municipio: pp.municipio, bairro: pp.bairro,
              semestre: f.semestre, ano: f.ano, tipo: f.tipo,
              grupo: f.grupo, sexo: f.sexo, cor: f.cor,
              idade_min: f.idade_min, idade_max: f.idade_max,
            });
            popup.setContent(buildBreakdownPopup(pp.displayName, stats));
          } catch {
            popup.setContent(
              `<div class="popup-title">${pp.displayName}</div>` +
              `<div class="popup-detail">Erro ao carregar detalhes</div>`
            );
          }
          pendingPopupRef.current = null;
        })();
      }
    } catch (e) { console.error('Load error:', e); } finally { if (thisLoadId === loadIdRef.current) setLoading(false); }
  }, [currentZoom, zoomLevel, filters, mapVersion, viewMode, aggregationOverride]);
  useEffect(() => { loadData(); }, [loadData]);
  return (
    <div className="w-full h-full relative">
      <div ref={containerRef} className="w-full h-full" />
      {loading && <div className="absolute inset-0 z-[999] bg-black/30 pointer-events-none transition-opacity" />}
      {loading && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none">
          <div className="bg-[#111827]/90 backdrop-blur-sm rounded-xl px-5 py-2.5 flex items-center gap-2 shadow-lg border border-[#1e293b]">
            <div className="w-4 h-4 border-2 border-[#3b82f6] border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-[#94a3b8]">Carregando...</span>
          </div>
        </div>
      )}
      <div className="absolute top-4 left-4 z-[1000] flex flex-col gap-1">
        <div className="bg-[#111827]/90 backdrop-blur-xl rounded-lg border border-[#1e293b] px-3 py-1.5">
          <span className="text-[10px] text-[#94a3b8] uppercase tracking-wider">
            {zoomLevel === 'states' ? 'Estados' : zoomLevel === 'municipios' ? 'Municípios' : 'Bairros'}
          </span>
        </div>
        <div className="flex gap-1">
          {[{c:'#60a5fa',l:'Baixo'},{c:'#a78bfa',l:'Médio'},{c:'#f472b6',l:'Alto'},{c:'#ef4444',l:'Crítico'}].map(i=>(
            <div key={i.l} className="flex items-center gap-1 bg-[#111827]/90 backdrop-blur-xl rounded-lg border border-[#1e293b] px-2 py-1">
              <div className="w-2 h-2 rounded-full" style={{background:i.c}} />
              <span className="text-[10px] text-[#94a3b8]">{i.l}</span>
            </div>
          ))}
        </div>
      </div>
      {nonRsInfo && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none">
          <div className="bg-[#111827]/90 backdrop-blur-sm rounded-xl px-5 py-2 shadow-lg border border-amber-500/30">
            <span className="text-xs text-amber-400">Dados por bairro disponíveis apenas para RS. Exibindo municípios.</span>
          </div>
        </div>
      )}
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
            <div key={s.state} className="text-sm text-[#94a3b8] mb-1">{s.name}</div>
          ))}
        </div>
      )}
    </div>
  );
}
