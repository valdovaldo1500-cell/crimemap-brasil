'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { fetchHeatmapMunicipios, fetchHeatmapBairros, fetchHeatmapStates, fetchLocationStats, fetchStateStats } from '@/lib/api';
import { normalizeGeoName } from '@/lib/normalize';
interface Props {
  center:[number,number]; zoom:number; filters:any;
  viewMode?:'dots'|'choropleth'; rateMode?:'rate'|'absolute';
  aggregationOverride?:'auto'|'estados'|'municipios'|'bairros';
  selectedStates?: string[];
  onToggleState?: (sigla: string) => void;
  activeFilter?: { label: string } | null;
  maxGranularity?: 'monthly' | 'yearly';
  availableStates?: { sigla: string; quality: string }[];
  compareMode?: boolean;
  comparisonLocations?: { municipio: string; bairro?: string; state?: string; displayName: string }[];
  onCompareSelect?: (location: { municipio: string; bairro?: string; state?: string; displayName: string }) => void;
  onDetailOpen?: (data: { displayName: string; municipio: string; bairro?: string; state?: string; total: number; population?: number | null; components?: { bairro: string; weight: number }[]; isUnknown?: boolean; loading?: boolean }) => void;
}

// States that have their own municipality GeoJSON files
const STATES_WITH_MUNICIPIO_GEO = ['rs', 'rj', 'mg'];
// States that have bairro-level GeoJSON files
const STATES_WITH_BAIRRO_GEO = ['rs', 'rj', 'mg'];

function formatCount(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// Fix #16: changed #22c55e to #16a34a (darker green, better contrast)
function getColor(intensity: number, purple = false): string {
  if (purple) {
    if (intensity > 0.9) return '#9333ea';  // purple-600
    if (intensity > 0.7) return '#7c3aed';  // violet-600
    if (intensity > 0.4) return '#6d28d9';  // violet-700
    return '#4c1d95';                       // violet-900
  }
  if (intensity > 0.9) return '#ef4444';   // Red (critical) — top 10%
  if (intensity > 0.7) return '#f97316';   // Orange (high) — next 20%
  if (intensity > 0.4) return '#eab308';   // Yellow (medium) — next 30%
  return '#16a34a';                        // Green (low) — bottom 40%
}

function quantileIntensities(values: number[]): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [0.5];
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted[0] === sorted[sorted.length - 1]) return values.map(() => 0.5);
  return values.map(v => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo / (sorted.length - 1);
  });
}


function prettifyCrimeType(s: string): string {
  return s.toLowerCase()
    .replace(/_/g, ' ')
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

function buildBreakdownPopup(displayName: string, stats: any, isRate: boolean): string {
  const pop = stats.population;
  const nonZeroTypes = (stats.crime_types || []).filter((ct: any) => ct.count > 0);
  if (isRate && pop) {
    const totalRate = (stats.total / pop) * 100_000;
    const rateStr = totalRate >= 100 ? totalRate.toFixed(0) : totalRate >= 10 ? totalRate.toFixed(1) : totalRate.toFixed(2);
    const rows = nonZeroTypes.map((ct: any) => {
      const r = (ct.count / pop) * 100_000;
      const rs = r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(1) : r.toFixed(2);
      return `<tr><td>${prettifyCrimeType(ct.tipo_enquadramento)}</td><td style="text-align:right;padding-left:12px">${rs}</td></tr>`;
    }).join('');
    return (
      `<div class="popup-title">${displayName}</div>` +
      `<div class="popup-detail"><strong>${rateStr}</strong> /100K hab.</div>` +
      (rows ? `<table class="popup-breakdown">${rows}</table>` : '')
    );
  }
  const rows = nonZeroTypes.map((ct: any) =>
    `<tr><td>${prettifyCrimeType(ct.tipo_enquadramento)}</td><td style="text-align:right;padding-left:12px">${ct.count.toLocaleString()}</td></tr>`
  ).join('');
  return (
    `<div class="popup-title">${displayName}</div>` +
    `<div class="popup-detail"><strong>${stats.total.toLocaleString()}</strong> ocorrências</div>` +
    (rows ? `<table class="popup-breakdown">${rows}</table>` : '')
  );
}

function displayValue(weight: number, population: number | null | undefined, isRate: boolean): string {
  if (isRate && population && population > 0) {
    const rate = (weight / population) * 100_000;
    if (rate >= 100) return rate.toFixed(0);
    if (rate >= 10) return rate.toFixed(1);
    return rate.toFixed(2);
  }
  if (weight >= 1000000) return (weight / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (weight >= 1000) return (weight / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(weight);
}

function tooltipText(displayName: string, weight: number, population: number | null | undefined, isRate: boolean, hint?: string): string {
  const hintText = hint || 'Clique para detalhes';
  if (isRate && population && population > 0) {
    const rate = (weight / population) * 100_000;
    const rateStr = rate >= 100 ? rate.toFixed(0) : rate >= 10 ? rate.toFixed(1) : rate.toFixed(2);
    return `<b>${displayName}</b><br>${rateStr} /100K hab.<br><span style="font-size:10px;color:#64748b">${hintText}</span>`;
  }
  return `<b>${displayName}</b><br>${weight.toLocaleString()} ocorrências<br><span style="font-size:10px;color:#64748b">${hintText}</span>`;
}

function initialPopupHtml(displayName: string, weight: number, population: number | null | undefined, isRate: boolean): string {
  if (isRate && population && population > 0) {
    const rate = (weight / population) * 100_000;
    const rateStr = rate >= 100 ? rate.toFixed(0) : rate >= 10 ? rate.toFixed(1) : rate.toFixed(2);
    return (
      `<div class="popup-title">${displayName}</div>` +
      `<div class="popup-detail"><strong>${rateStr}</strong> /100K hab.</div>` +
      `<div class="popup-detail" style="margin-top:6px;font-size:10px;color:#64748b">Clique para detalhes...</div>`
    );
  }
  return (
    `<div class="popup-title">${displayName}</div>` +
    `<div class="popup-detail"><strong>${weight.toLocaleString()}</strong> ocorrências</div>` +
    `<div class="popup-detail" style="margin-top:6px;font-size:10px;color:#64748b">Clique para detalhes...</div>`
  );
}

export default function CrimeMap({ center, zoom, filters, viewMode = 'dots', rateMode = 'rate', aggregationOverride = 'auto', selectedStates = [], onToggleState, activeFilter, maxGranularity = 'monthly', availableStates = [], compareMode = false, comparisonLocations = [], onCompareSelect, onDetailOpen }: Props) {
  const mapRef = useRef<L.Map|null>(null);
  const markersRef = useRef<L.LayerGroup|null>(null);
  const geoJsonRef = useRef<L.GeoJSON|null>(null);
  const brazilOutlineRef = useRef<L.GeoJSON|null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Multi-state GeoJSON: keyed by state sigla lowercase
  const geoDataRefs = useRef<Record<string, any>>({});
  const geoDataRef = useRef<any>(null);  // RS municipios (legacy compat)
  const bairroGeoDataRef = useRef<any>(null);  // RS bairros (legacy compat)
  const bairroGeoDataRefs = useRef<Record<string, any>>({});  // Multi-state bairro GeoJSON
  const statesGeoDataRef = useRef<any>(null);
  const filtersRef = useRef(filters);
  const [currentZoom, setCurrentZoom] = useState(zoom);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [loadingMsgVisible, setLoadingMsgVisible] = useState(false);
  const [mapVersion, setMapVersion] = useState(0);
  const [nonRsInfo, setNonRsInfo] = useState(false);
  const [bairroMixedInfo, setBairroMixedInfo] = useState(false);
  // Fix #10: track empty data state
  const [emptyResult, setEmptyResult] = useState(false);
  // Fix #18: track GeoJSON load errors
  const [geoError, setGeoError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  const loadIdRef = useRef(0);
  const popupOpenRef = useRef(false);
  const boundsAtPopupOpenRef = useRef<string|null>(null);
  const pendingPopupRef = useRef<{municipio:string, bairro?:string, displayName:string, latlng:[number,number]}|null>(null);
  const cachedDataRef = useRef<{level: string, data: any[]} | null>(null);
  const heatmapAbortRef = useRef<AbortController | null>(null);
  const rateModeRef = useRef(rateMode);
  const compareModeRef = useRef(compareMode);
  const onCompareSelectRef = useRef(onCompareSelect);
  const onDetailOpenRef = useRef(onDetailOpen);

  useEffect(() => {
    rateModeRef.current = rateMode;
    // Fix #17: rateMode change is purely client-side — re-render from cache, no re-fetch
    setMapVersion(v => v + 1);
  }, [rateMode]);
  useEffect(() => {
    compareModeRef.current = compareMode;
    if (mapRef.current) {
      const tilePane = mapRef.current.getPane('tilePane');
      if (tilePane) {
        tilePane.style.filter = compareMode ? 'hue-rotate(220deg) saturate(1.4)' : '';
      }
    }
  }, [compareMode]);
  const comparisonLocationsRef = useRef(comparisonLocations);
  useEffect(() => { comparisonLocationsRef.current = comparisonLocations; }, [comparisonLocations]);
  useEffect(() => { onCompareSelectRef.current = onCompareSelect; }, [onCompareSelect]);
  useEffect(() => { onDetailOpenRef.current = onDetailOpen; }, [onDetailOpen]);
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
    // Initial view: frame the 3 interactive states (RS, RJ, MG)
    map.fitBounds(L.latLngBounds([-33.8, -57.7], [-14.2, -40.9]), { padding: [20, 20] });

    // Fix #18: GeoJSON fetch with error handling
    // Load all state municipality GeoJSON files
    for (const stateSigla of STATES_WITH_MUNICIPIO_GEO) {
      fetch(`/geo/${stateSigla}-municipios.geojson`)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then(data => {
          geoDataRefs.current[stateSigla] = data;
          if (stateSigla === 'rs') geoDataRef.current = data; // legacy compat
          setMapVersion(v => v + 1);
        })
        .catch((err) => {
          console.error(`Failed to load ${stateSigla}-municipios.geojson:`, err);
          if (stateSigla === 'rs') setGeoError('rs-municipios');
        });
    }
    for (const stateSigla of STATES_WITH_BAIRRO_GEO) {
      fetch(`/geo/${stateSigla}-bairros.geojson`)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then(data => {
          bairroGeoDataRefs.current[stateSigla] = data;
          if (stateSigla === 'rs') bairroGeoDataRef.current = data;  // legacy compat
          setMapVersion(v => v + 1);
        })
        .catch((err) => {
          console.error(`Failed to load ${stateSigla}-bairros.geojson:`, err);
        });
    }
    fetch('/geo/br-states.geojson')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => {
        statesGeoDataRef.current = data;
        // Add persistent Brazil outline layer for visual distinction
        if (mapRef.current && !brazilOutlineRef.current) {
          brazilOutlineRef.current = L.geoJSON(data, {
            style: () => ({
              fillColor: compareModeRef.current ? '#1a0a2e' : '#0f172a',
              fillOpacity: 0.3,
              color: '#475569',
              weight: 2,
              interactive: false,
            }),
            interactive: false,
          }).addTo(mapRef.current);
          // Ensure outline stays behind other layers
          brazilOutlineRef.current.bringToBack();
        }
        setMapVersion(v => v + 1);
      })
      .catch((err) => {
        console.error('Failed to load br-states.geojson:', err);
        setGeoError('br-states');
      });
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

  const bindInteractions = (layer: L.Layer, displayName: string, count: number, municipio: string, bairro?: string, components?: {bairro: string, weight: number}[], population?: number | null, state?: string) => {
    const l = layer as any;
    const isRate = rateModeRef.current === 'rate';
    l.bindTooltip(tooltipText(displayName, count, population, isRate, compareModeRef.current ? 'Clique para comparar' : undefined), { sticky: true });
    if (!onDetailOpenRef.current) {
      l.bindPopup(initialPopupHtml(displayName, count, population, isRate));
      trackPopup(l);
    }
    l.on('click', async () => {
      // In compare mode, intercept click to select location for comparison
      if (compareModeRef.current && onCompareSelectRef.current) {
        onCompareSelectRef.current({ municipio, bairro, state, displayName });
        return;
      }
      // Use DetailPanel when available
      if (onDetailOpenRef.current) {
        const actionId = `${Date.now()}-${Math.random()}`;
        const isUnknown = bairro === 'Bairro desconhecido';
        onDetailOpenRef.current({ actionId, displayName, municipio, bairro, state, total: count, population, components, isUnknown, loading: !isUnknown });
        if (isUnknown) return; // no stats fetch for unknown bairros
        try {
          const f = filtersRef.current;
          const stats = await fetchLocationStats({
            municipio, bairro, state,
            semestre: f.semestre, ano: f.ano, tipo: f.tipo,
            grupo: f.grupo, sexo: f.sexo, cor: f.cor,
            idade_min: f.idade_min, idade_max: f.idade_max,
            ultimos_meses: f.ultimos_meses,
          });
          onDetailOpenRef.current({ actionId, displayName, municipio, bairro, state, total: count, population: stats.population ?? population, components,
            isUnknown: false, loading: false,
            // pass crime_types via the callback — page.tsx will merge
            ...(stats.crime_types ? { crime_types: stats.crime_types.map((ct: any) => ({ tipo: ct.tipo_enquadramento || ct.tipo, count: ct.count })) } : {}),
          } as any);
        } catch (err) {
          console.error('Failed to load location stats:', err);
        }
        return;
      }
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
          ultimos_meses: f.ultimos_meses,
        });
        l.setPopupContent(buildBreakdownPopup(displayName, stats, rateModeRef.current === 'rate'));
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

  const bindStateInteractions = (layer: L.Layer, stateName: string, sigla: string, weight: number, _feature: any, population?: number | null, crimeTypes?: any[]) => {
    const l = layer as any;
    const isRate = rateModeRef.current === 'rate';
    // Build detailed tooltip with crime type breakdown
    let tip = tooltipText(`${stateName} (${sigla})`, weight, population, isRate, 'Clique para desmarcar');
    if (crimeTypes && crimeTypes.length > 0) {
      const breakdownRows = crimeTypes.map((ct: any) => {
        if (isRate && population && population > 0) {
          const r = (ct.count / population) * 100_000;
          const rs = r >= 100 ? r.toFixed(0) : r >= 10 ? r.toFixed(1) : r.toFixed(2);
          return `<tr><td style="padding-right:8px;font-size:10px;color:#94a3b8">${prettifyCrimeType(ct.tipo)}</td><td style="text-align:right;font-size:10px;color:#cbd5e1">${rs}</td></tr>`;
        }
        return `<tr><td style="padding-right:8px;font-size:10px;color:#94a3b8">${prettifyCrimeType(ct.tipo)}</td><td style="text-align:right;font-size:10px;color:#cbd5e1">${ct.count.toLocaleString()}</td></tr>`;
      }).join('');
      tip = tip.replace('</b><br>', `</b><br>`) +
        `<table style="margin-top:4px;border-top:1px solid #334155;padding-top:3px">${breakdownRows}</table>`;
    }
    l.bindTooltip(tip, { sticky: true });
    l.on('click', async () => {
      console.log('[bindStateInteractions click] sigla=' + sigla);
      if (compareModeRef.current && onCompareSelectRef.current) {
        onCompareSelectRef.current({ municipio: '', state: sigla, displayName: `${stateName} (${sigla})` });
        return;
      }
      if (onToggleState) onToggleState(sigla);
      // Open DetailPanel with state stats
      if (onDetailOpenRef.current) {
        const actionId = `${Date.now()}-${Math.random()}`;
        const displayName2 = `${stateName} (${sigla})`;
        console.log('[bindStateInteractions] calling onDetailOpen phase1 actionId=' + actionId);
        onDetailOpenRef.current({ actionId, displayName: displayName2, municipio: '', state: sigla, total: weight, population, isUnknown: false, loading: true });
        try {
          const f = filtersRef.current;
          const stats = await fetchStateStats({
            state: sigla, semestre: f.semestre, ano: f.ano, tipo: f.tipo,
            grupo: f.grupo, sexo: f.sexo, cor: f.cor,
            idade_min: f.idade_min, idade_max: f.idade_max,
            ultimos_meses: f.ultimos_meses,
            selected_states: selectedStates,
          });
          onDetailOpenRef.current({ actionId, displayName: displayName2, municipio: '', state: sigla,
            total: stats.total ?? weight, population: stats.population ?? population, isUnknown: false, loading: false,
            ...(stats.crime_types ? { crime_types: stats.crime_types.map((ct: any) => ({ tipo: ct.tipo_enquadramento || ct.tipo, count: ct.count })) } : {}),
          } as any);
        } catch (err) {
          console.error('Failed to load state stats:', err);
        }
      }
    });
  };

  const addPolygonHover = (layer: L.Layer) => {
    layer.on('mouseover', () => (layer as any).setStyle({ fillOpacity: 0.85, weight: 2, color: compareModeRef.current ? '#7c3aed' : '#3b82f6' }));
    layer.on('mouseout', () => geoJsonRef.current?.resetStyle(layer as L.Path));
  };

  const autoLevel = currentZoom < 7 ? 'states' : currentZoom < 11 ? 'municipios' : 'bairros';
  const zoomLevel = aggregationOverride === 'auto' ? autoLevel
    : aggregationOverride === 'estados' ? 'states'
    : aggregationOverride === 'municipios' ? 'municipios'
    : aggregationOverride === 'bairros' ? 'bairros'
    : autoLevel;

  // Fix #17: rateMode is intentionally NOT in this dependency list.
  // Rate display is a pure client-side calculation; toggling it re-renders
  // from cachedDataRef without triggering a new fetch.
  const loadData = useCallback(async () => {
    if (!mapRef.current) return;
    const thisLoadId = ++loadIdRef.current;
    setLoading(true);
    setEmptyResult(false);
    if (heatmapAbortRef.current) heatmapAbortRef.current.abort();
    const ac = new AbortController();
    heatmapAbortRef.current = ac;
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
    if (filters.selected_states) params.selected_states = filters.selected_states;
    if (filters.ultimos_meses) params.ultimos_meses = filters.ultimos_meses;
    if (zoomLevel === 'bairros') {
      const latPad = (params.north - params.south) * 0.15;
      const lngPad = (params.east - params.west) * 0.15;
      params.south -= latPad;
      params.north += latPad;
      params.west -= lngPad;
      params.east += lngPad;
    }
    const isRate = rateModeRef.current === 'rate';
    // Cache key based on fetch-relevant params (excludes rateMode — Fix #17)
    const cacheKey = JSON.stringify({ zoomLevel, ...params, filters });
    let useCache = false;
    if (cachedDataRef.current && cachedDataRef.current.level === cacheKey) {
      useCache = true;
    }

    try {
      if (zoomLevel === 'states') {
        // State-level view
        setBairroMixedInfo(false);
        const data = useCache ? cachedDataRef.current!.data : await fetchHeatmapStates(params, ac.signal);
        if (!useCache) {
          if (thisLoadId !== loadIdRef.current) return; // stale request
          cachedDataRef.current = { level: cacheKey, data };
        }
        if (markersRef.current) markersRef.current.clearLayers();
        if (geoJsonRef.current) { mapRef.current.removeLayer(geoJsonRef.current); geoJsonRef.current = null; }
        if (!data || data.length === 0) {
          // Fix #10: show empty state message
          setEmptyResult(true);
          if (statesGeoDataRef.current && viewMode === 'choropleth') {
            geoJsonRef.current = L.geoJSON(statesGeoDataRef.current, {
              style: () => ({ fillColor: compareModeRef.current ? '#2d1f4e' : '#1e293b', fillOpacity: 0.2, color: compareModeRef.current ? '#2d1f4e' : '#1e293b', weight: 0.5 }),
              onEachFeature: (feature, layer) => {
                const sigla = feature?.properties?.sigla || '';
                const name = feature?.properties?.name || '';
                layer.bindTooltip(`<b>${name} (${sigla})</b><br>Sem dados`, { sticky: true });
              }
            }).addTo(mapRef.current!);
          }
          return;
        }
        const displayValues = data.map((d:any) => {
          if (isRate && d.population) return (d.weight / d.population) * 100_000;
          return d.weight;
        });
        const intensities = quantileIntensities(displayValues);
        const stateLookup: Record<string, {weight:number, intensity:number, population:number|null, crime_types?:any[]}> = {};
        data.forEach((d:any, i:number) => {
          stateLookup[d.state] = { weight: d.weight, intensity: intensities[i], population: d.population || null, crime_types: d.crime_types };
        });

        // Build quality lookup from availableStates (used by both choropleth and dot mode)
        const qualityMap: Record<string, string> = {};
        availableStates.forEach(s => { qualityMap[s.sigla] = s.quality; });

        if (statesGeoDataRef.current && viewMode === 'choropleth') {
          const hasSelection = selectedStates.length > 0;
          geoJsonRef.current = L.geoJSON(statesGeoDataRef.current, {
            style: (feature) => {
              const sigla = feature?.properties?.sigla || '';
              const info = stateLookup[sigla];
              const quality = qualityMap[sigla] || 'none';
              const isSelected = hasSelection && selectedStates.includes(sigla);
              const usePurple = compareModeRef.current && (comparisonLocationsRef.current?.length ?? 0) < 2;
              // States without detailed data (basic/none): render same as world background
              if (quality !== 'full' && quality !== 'partial') {
                return { fillColor: '#0f172a', fillOpacity: 0.12, color: '#1e293b', weight: 0.3, interactive: false, className: 'state-disabled' };
              }
              const isCompareSelected = compareModeRef.current && comparisonLocationsRef.current?.some(l => !l.municipio && l.state === sigla);
              if (isCompareSelected) {
                return info
                  ? { fillColor: getColor(info.intensity, usePurple), fillOpacity: 0.6, color: '#a78bfa', weight: 3 }
                  : { fillColor: '#3d2160', fillOpacity: 0.5, color: '#a78bfa', weight: 3 };
              }
              if (info && isSelected) {
                return { fillColor: getColor(info.intensity, usePurple), fillOpacity: 0.45, color: '#475569', weight: 1.5 };
              }
              // Available states: muted blue to signal interactivity
              return { fillColor: usePurple ? '#3d2160' : '#2563eb', fillOpacity: hasSelection && !isSelected ? 0.20 : 0.45, color: usePurple ? '#6d28d9' : '#3b82f6', weight: 1.5 };
            },
            onEachFeature: (feature, layer) => {
              const sigla = feature?.properties?.sigla || '';
              const name = feature?.properties?.name || '';
              const info = stateLookup[sigla];
              const quality = qualityMap[sigla] || 'none';
              const isSelected = hasSelection && selectedStates.includes(sigla);
              // States without detailed data (basic/none): not interactive
              if (quality !== 'full' && quality !== 'partial') {
                return;
              }
              if (info && isSelected) {
                bindStateInteractions(layer, name, sigla, info.weight, feature, info.population, info.crime_types);
                addPolygonHover(layer);
                const ctr = L.geoJSON(feature).getBounds().getCenter();
                const lbl = L.marker(ctr, {
                  icon: L.divIcon({
                    className: 'choropleth-label',
                    html: `<span style="color:#fff;font-size:12px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.9)">${sigla}<br>${displayValue(info.weight, info.population, isRate)}</span>`,
                    iconSize: [50, 30], iconAnchor: [25, 15],
                  }), interactive: false
                });
                markersRef.current?.addLayer(lbl);
              } else {
                // Clickable to toggle state selection — hover highlight
                layer.bindTooltip(`<b>${name} (${sigla})</b><br>${compareMode ? 'Clique para comparar' : 'Clique para filtrar'}`, { sticky: true });
                layer.on('mouseover', () => {
                  const usePurple = compareModeRef.current && (comparisonLocationsRef.current?.length ?? 0) < 2;
                  (layer as any).setStyle({ fillOpacity: 0.55, color: usePurple ? '#7c3aed' : '#60a5fa', weight: 2.5 });
                });
                layer.on('mouseout', () => {
                  const usePurple = compareModeRef.current && (comparisonLocationsRef.current?.length ?? 0) < 2;
                  (layer as any).setStyle({ fillOpacity: hasSelection && !isSelected ? 0.20 : 0.45, color: usePurple ? '#6d28d9' : '#3b82f6', weight: 1.5 });
                });
                layer.on('click', async () => {
                  console.log('[unselected state click] sigla=' + sigla);
                  if (compareModeRef.current && onCompareSelectRef.current) {
                    onCompareSelectRef.current({ municipio: '', state: sigla, displayName: `${name} (${sigla})` });
                    return;
                  }
                  if (onToggleState) onToggleState(sigla);
                  if (onDetailOpenRef.current) {
                    const actionId = `${Date.now()}-${Math.random()}`;
                    const dn = `${name} (${sigla})`;
                    console.log('[unselected state] calling onDetailOpen phase1 actionId=' + actionId);
                    onDetailOpenRef.current({ actionId, displayName: dn, municipio: '', state: sigla, total: 0, isUnknown: false, loading: true });
                    try {
                      const f = filtersRef.current;
                      const stats = await fetchStateStats({
                        state: sigla, semestre: f.semestre, ano: f.ano, tipo: f.tipo,
                        grupo: f.grupo, sexo: f.sexo, cor: f.cor,
                        idade_min: f.idade_min, idade_max: f.idade_max,
                        ultimos_meses: f.ultimos_meses,
                        selected_states: selectedStates,
                      });
                      onDetailOpenRef.current({ actionId, displayName: dn, municipio: '', state: sigla,
                        total: stats.total ?? 0, population: stats.population, isUnknown: false, loading: false,
                        ...(stats.crime_types ? { crime_types: stats.crime_types.map((ct: any) => ({ tipo: ct.tipo_enquadramento || ct.tipo, count: ct.count })) } : {}),
                      } as any);
                    } catch (err) {
                      console.error('Failed to load state stats:', err);
                    }
                  }
                });
              }
            }
          }).addTo(mapRef.current!);
        } else {
          // Dot mode for states — only show states with detailed data
          data.filter((d:any) => { const q = qualityMap[d.state]; return q === 'full' || q === 'partial'; }).forEach((d:any) => {
            const intensity = stateLookup[d.state]?.intensity ?? 0;
            const color = getColor(intensity, compareModeRef.current);
            const size = Math.round(36 + intensity * 30);
            const fontSize = Math.round(11 + intensity * 5);
            const icon = L.divIcon({
              className: 'crime-dot-icon',
              iconSize: [size, size],
              iconAnchor: [size / 2, size / 2],
              html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid ${color};opacity:0.85;display:flex;align-items:center;justify-content:center;flex-direction:column"><span style="color:#fff;font-size:${fontSize}px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.7);line-height:1;">${d.state}</span><span style="color:#fff;font-size:${fontSize - 2}px;text-shadow:0 1px 3px rgba(0,0,0,0.7);line-height:1;">${displayValue(d.weight, d.population, isRate)}</span></div>`
            });
            const marker = L.marker([d.latitude, d.longitude], { icon });
            const stateFeature = statesGeoDataRef.current?.features.find(
              (f: any) => f.properties?.sigla === d.state
            );
            bindStateInteractions(marker, d.state, d.state, d.weight, stateFeature || { type: 'Feature', geometry: { type: 'Point', coordinates: [d.longitude, d.latitude] }, properties: {} }, d.population, d.crime_types);
            markersRef.current?.addLayer(marker);
          });
          // Hatching overlay for disabled states in dot mode
          if (statesGeoDataRef.current) {
            const disabledFeatures = statesGeoDataRef.current.features.filter((f: any) => {
              const s = f?.properties?.sigla || '';
              const q = qualityMap[s] || 'none';
              return q !== 'full' && q !== 'partial';
            });
            if (disabledFeatures.length > 0) {
              L.geoJSON({ ...statesGeoDataRef.current, features: disabledFeatures }, {
                style: () => {
                  const usePurple = compareModeRef.current && (comparisonLocationsRef.current?.length ?? 0) < 2;
                  return { fillColor: '#0f172a', fillOpacity: 0.12, color: '#1e293b', weight: 0.3, interactive: false, className: 'state-disabled' };
                },
                interactive: false,
              }).addTo(mapRef.current!);
            }
          }
        }
      } else {
        // Detect if map center is in a state with bairro data
        const center = mapRef.current!.getCenter();
        const STATE_BOUNDS: Record<string, {latMin:number,latMax:number,lngMin:number,lngMax:number}> = {
          rs: { latMin: -34, latMax: -27, lngMin: -58, lngMax: -49 },
          rj: { latMin: -23.5, latMax: -20.5, lngMin: -45, lngMax: -40.5 },
          mg: { latMin: -23, latMax: -14, lngMin: -52, lngMax: -39.5 },
        };
        const hasBairroData = STATES_WITH_BAIRRO_GEO.some(st => {
          const b = STATE_BOUNDS[st];
          return b && bairroGeoDataRefs.current[st] &&
            center.lat >= b.latMin && center.lat <= b.latMax &&
            center.lng >= b.lngMin && center.lng <= b.lngMax;
        });
        const effectiveBairro = zoomLevel === 'bairros' && hasBairroData;
        // Show info banner when at bairro zoom but not for non-detailed states
        setNonRsInfo(zoomLevel === 'bairros' && !hasBairroData);

        // Municipality or Bairro level (existing logic)
        const useChoropleth = viewMode === 'choropleth' && (zoomLevel === 'municipios' || !effectiveBairro);
        const useBubbleChoropleth = viewMode === 'choropleth' && effectiveBairro;
        let data = useCache ? cachedDataRef.current!.data : (!effectiveBairro
          ? await fetchHeatmapMunicipios(params, ac.signal)
          : await fetchHeatmapBairros(params, ac.signal));
        if (!useCache) {
          if (thisLoadId !== loadIdRef.current) return; // stale request
          cachedDataRef.current = { level: cacheKey, data };
        }
        if (markersRef.current) markersRef.current.clearLayers();
        if (geoJsonRef.current) { mapRef.current.removeLayer(geoJsonRef.current); geoJsonRef.current = null; }
        if (!data || data.length === 0) {
          // Fix #10: show empty state message
          setEmptyResult(true);
          return;
        }
        if (zoomLevel === 'bairros') {
          data = data.filter((d: any) => d.weight >= 5);
          if (data.length === 0) {
            // Fix #10: show empty state message when filtered bairro data is empty
            setEmptyResult(true);
            setBairroMixedInfo(false);
            return;
          }
          // Show info banner when we have mixed bairro + municipality-level data
          setBairroMixedInfo(data.some((d: any) => d.level === 'municipio'));
        } else {
          setBairroMixedInfo(false);
        }
        const displayValues2 = data.map((d:any) => {
          if (isRate && d.population) return (d.weight / d.population) * 100_000;
          return d.weight;
        });
        const intensities2 = quantileIntensities(displayValues2);
        // Build a map for quick lookup of intensity by data item
        const dvMap = new Map<any, number>();
        data.forEach((d: any, i: number) => dvMap.set(d, intensities2[i]));
        data.sort((a: any, b: any) => (dvMap.get(b) || 0) - (dvMap.get(a) || 0));

        // Build centroids from all loaded state GeoJSON files
        const centroids: Record<string, [number, number]> = {};
        for (const [, stateGeo] of Object.entries(geoDataRefs.current)) {
          if (!stateGeo) continue;
          stateGeo.features.forEach((f: any) => {
            const name = normalizeGeoName(f.properties?.name || '');
            try {
              const center = L.geoJSON(f).getBounds().getCenter();
              centroids[name] = [center.lat, center.lng];
            } catch { /* skip invalid geometry */ }
          });
        }

        // Build bairro centroid lookup from all bairro GeoJSON files for dot placement
        const bairroCentroids: Record<string, [number, number]> = {};
        if (zoomLevel === 'bairros') {
          for (const [, bairroGeo] of Object.entries(bairroGeoDataRefs.current)) {
            if (!bairroGeo?.features) continue;
            bairroGeo.features.forEach((f: any) => {
              const props = f.properties || {};
              const key = (props.municipio_normalized || '') + '|' + (props.name_normalized || '');
              try {
                const center = L.geoJSON(f).getBounds().getCenter();
                bairroCentroids[key] = [center.lat, center.lng];
              } catch { /* skip invalid geometry */ }
            });
          }
        }

        if (useChoropleth) {
          // Merge features from all loaded state GeoJSON files
          const mergedFeatures: any[] = [];
          for (const [, stateGeo] of Object.entries(geoDataRefs.current)) {
            if (!stateGeo?.features) continue;
            mergedFeatures.push(...stateGeo.features);
          }
          const mergedGeoData = mergedFeatures.length > 0 ? { type: 'FeatureCollection', features: mergedFeatures } : geoDataRef.current;
          if (!mergedGeoData) { setLoading(false); return; }

          const lookup: Record<string, {weight:number, intensity:number, municipio:string, population:number|null}> = {};
          data.forEach((d:any) => {
            const key = normalizeGeoName(d.municipio || '');
            const intensity = dvMap.get(d) ?? 0.5;
            lookup[key] = { weight: d.weight, intensity, municipio: d.municipio, population: d.population || null };
          });

          geoJsonRef.current = L.geoJSON(mergedGeoData, {
            style: (feature) => {
              const name = normalizeGeoName(feature?.properties?.name || '');
              const info = lookup[name];
              if (info) {
                const usePurple = compareModeRef.current && (comparisonLocationsRef.current?.length ?? 0) < 2;
                const isCompareSelected = compareModeRef.current && comparisonLocationsRef.current?.some(l => l.municipio && normalizeGeoName(l.municipio) === name && !l.bairro);
                return { fillColor: getColor(info.intensity, usePurple), fillOpacity: isCompareSelected ? 0.6 : 0.45, color: isCompareSelected ? '#a78bfa' : (usePurple ? '#2d1f4e' : '#1e293b'), weight: isCompareSelected ? 3 : 1 };
              }
              const usePurpleNoData = compareModeRef.current && (comparisonLocationsRef.current?.length ?? 0) < 2;
              return { fillColor: usePurpleNoData ? '#2d1f4e' : '#1e293b', fillOpacity: 0.2, color: usePurpleNoData ? '#2d1f4e' : '#1e293b', weight: 1 };
            },
            onEachFeature: (feature, layer) => {
              const name = normalizeGeoName(feature?.properties?.name || '');
              const displayName = feature?.properties?.name || '';
              const info = lookup[name];
              if (info) {
                bindInteractions(layer, displayName, info.weight, info.municipio, undefined, undefined, info.population);
                addPolygonHover(layer);
                const ctr = L.geoJSON(feature).getBounds().getCenter();
                const lbl = L.marker(ctr, {
                  icon: L.divIcon({
                    className: 'choropleth-label',
                    html: `<span style="color:#fff;font-size:11px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.9)">${displayValue(info.weight, info.population, isRate)}</span>`,
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
          // Split data into bairro-level (RS) and municipality-level (RJ/MG staging fallback)
          const bairroData = data.filter((d: any) => d.level !== 'municipio');
          const muniData = data.filter((d: any) => d.level === 'municipio');

          const bairroLookup: Record<string, {weight:number, intensity:number, municipio:string, bairro:string, population:number|null}> = {};
          bairroData.forEach((d:any) => {
            const munKey = normalizeGeoName(d.municipio || '');
            const bairroKey = normalizeGeoName(d.bairro || '');
            const key = munKey + '|' + bairroKey;
            const intensity = dvMap.get(d) ?? 0.5;
            bairroLookup[key] = { weight: d.weight, intensity, municipio: d.municipio, bairro: d.bairro, population: d.population || null };
          });

          // Municipality-level lookup for RJ/MG polygon rendering
          const muniLookup: Record<string, {weight:number, intensity:number, municipio:string, population:number|null}> = {};
          muniData.forEach((d:any) => {
            const key = normalizeGeoName(d.municipio || '');
            const intensity = dvMap.get(d) ?? 0.5;
            muniLookup[key] = { weight: d.weight, intensity, municipio: d.municipio, population: d.population || null };
          });

          const matchedKeys = new Set<string>();
          const matchedMuniKeys = new Set<string>();

          // --- Layer 1: Municipality polygons for RJ/MG data ---
          if (Object.keys(muniLookup).length > 0) {
            const muniFeatures: any[] = [];
            for (const [, stateGeo] of Object.entries(geoDataRefs.current)) {
              if (!stateGeo?.features) continue;
              muniFeatures.push(...stateGeo.features);
            }
            if (muniFeatures.length > 0) {
              const mapBounds = mapRef.current!.getBounds();
              const filteredMuniGeo = {
                type: 'FeatureCollection' as const,
                features: muniFeatures.filter((f: any) => {
                  try {
                    const featureBounds = L.geoJSON(f).getBounds();
                    return mapBounds.intersects(featureBounds);
                  } catch { return false; }
                })
              };
              const muniLayer = L.geoJSON(filteredMuniGeo, {
                style: (feature) => {
                  const name = normalizeGeoName(feature?.properties?.name || '');
                  const info = muniLookup[name];
                  if (info) {
                    const usePurple = compareModeRef.current && (comparisonLocationsRef.current?.length ?? 0) < 2;
                    const isCompareSelected = compareModeRef.current && comparisonLocationsRef.current?.some(l => l.municipio && normalizeGeoName(l.municipio) === name && !l.bairro);
                    return { fillColor: getColor(info.intensity, usePurple), fillOpacity: isCompareSelected ? 0.55 : 0.35, color: isCompareSelected ? '#a78bfa' : (usePurple ? '#2d1f4e' : '#1e293b'), weight: isCompareSelected ? 3 : 1 };
                  }
                  return { fillColor: 'transparent', fillOpacity: 0, color: 'transparent', weight: 0, interactive: false };
                },
                onEachFeature: (feature, layer) => {
                  const name = normalizeGeoName(feature?.properties?.name || '');
                  const displayName = feature?.properties?.name || '';
                  const info = muniLookup[name];
                  if (info) {
                    matchedMuniKeys.add(name);
                    bindInteractions(layer, displayName, info.weight, info.municipio, undefined, undefined, info.population);
                    addPolygonHover(layer);
                    const ctr = L.geoJSON(feature).getBounds().getCenter();
                    const lbl = L.marker(ctr, {
                      icon: L.divIcon({
                        className: 'choropleth-label',
                        html: `<span style="color:#fff;font-size:11px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.9)">${displayValue(info.weight, info.population, isRate)}</span>`,
                        iconSize: [40, 16], iconAnchor: [20, 8],
                      }), interactive: false
                    });
                    markersRef.current?.addLayer(lbl);
                  }
                }
              }).addTo(mapRef.current!);
            }
          }

          // --- Layer 2: Bairro polygons for RS data ---
          const allBairroFeatures: any[] = [];
          for (const [, bairroGeo] of Object.entries(bairroGeoDataRefs.current)) {
            if (!bairroGeo?.features) continue;
            allBairroFeatures.push(...bairroGeo.features);
          }
          if (allBairroFeatures.length > 0) {
            const mapBounds = mapRef.current!.getBounds();
            const filteredGeoData = {
              type: 'FeatureCollection' as const,
              features: allBairroFeatures.filter((f: any) => {
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
                  const usePurple = compareModeRef.current && (comparisonLocationsRef.current?.length ?? 0) < 2;
                  const isCompareSelected = compareModeRef.current && comparisonLocationsRef.current?.some(l => l.bairro && normalizeGeoName(l.municipio || '') === (props.municipio_normalized || '') && normalizeGeoName(l.bairro || '') === (props.name_normalized || ''));
                  return { fillColor: getColor(info.intensity, usePurple), fillOpacity: isCompareSelected ? 0.55 : 0.35, color: isCompareSelected ? '#a78bfa' : (usePurple ? '#2d1f4e' : '#1e293b'), weight: isCompareSelected ? 3 : 1 };
                }
                const usePurpleNoData = compareModeRef.current && (comparisonLocationsRef.current?.length ?? 0) < 2;
                return { fillColor: usePurpleNoData ? '#2d1f4e' : '#1e293b', fillOpacity: 0.1, color: usePurpleNoData ? '#2d1f4e' : '#1e293b', weight: 0.5, interactive: false };
              },
              onEachFeature: (feature, layer) => {
                const props = feature?.properties || {};
                const key = (props.municipio_normalized || '') + '|' + (props.name_normalized || '');
                const info = bairroLookup[key];
                const displayName = props.name || '';
                const municipio = props.municipio || '';
                if (info) {
                  matchedKeys.add(key);
                  bindInteractions(layer, `${displayName}, ${municipio}`, info.weight, municipio, displayName, undefined, info.population);
                  addPolygonHover(layer);
                  const ctr = L.geoJSON(feature).getBounds().getCenter();
                  const lbl = L.marker(ctr, {
                    icon: L.divIcon({
                      className: 'choropleth-label',
                      html: `<span style="color:#fff;font-size:11px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.9)">${displayValue(info.weight, info.population, isRate)}</span>`,
                      iconSize: [40, 16], iconAnchor: [20, 8],
                    }), interactive: false
                  });
                  markersRef.current?.addLayer(lbl);
                }
              }
            }).addTo(mapRef.current!);
          }

          // Fallback: circleMarkers for unmatched bairros and unmatched municipalities
          data.forEach((d:any) => {
            if (d.level === 'municipio') {
              const munKey = normalizeGeoName(d.municipio || '');
              if (matchedMuniKeys.has(munKey)) return;
            } else {
              const munKey = normalizeGeoName(d.municipio || '');
              const bairroKey = normalizeGeoName(d.bairro || '');
              const key = munKey + '|' + bairroKey;
              if (matchedKeys.has(key)) return;
            }
            const intensity = dvMap.get(d) ?? 0.5;
            const color = getColor(intensity, compareModeRef.current);
            const label = d.bairro ? d.bairro + ', ' + d.municipio : d.municipio;
            const zoom = mapRef.current?.getZoom() || 13;
            const zoomScale = Math.max(0.4, Math.min(1.0, (zoom - 10) / 5));
            const radius = Math.round((30 + intensity * 40) * zoomScale);
            const circle = L.circleMarker([d.latitude, d.longitude], {
              radius, fillColor: color, fillOpacity: 0.35, color, weight: 2, opacity: 0.3,
            });
            bindInteractions(circle, label, d.weight, d.municipio, d.bairro || undefined, d.components, d.population);
            markersRef.current?.addLayer(circle);
          });
        } else {
          // Dot mode: numbered markers
          data.forEach((d:any) => {
            const intensity = dvMap.get(d) ?? 0.5;
            const color = getColor(intensity, compareModeRef.current);
            const label = d.bairro ? d.bairro + ', ' + d.municipio : d.municipio;
            const geoKey = normalizeGeoName(d.municipio || '');
            // Use bairro GeoJSON centroid when available, then municipality centroid, then raw coords
            let lat = d.latitude, lng = d.longitude;
            if (zoomLevel === 'bairros' && d.bairro && d.level !== 'municipio') {
              const bairroKey = normalizeGeoName(d.municipio || '') + '|' + normalizeGeoName(d.bairro || '');
              const bc = bairroCentroids[bairroKey];
              if (bc) { lat = bc[0]; lng = bc[1]; }
            } else if (d.level === 'municipio' && centroids[geoKey]) {
              // Municipality-level data (RJ/MG) at bairro zoom — use municipality centroid
              lat = centroids[geoKey][0]; lng = centroids[geoKey][1];
            } else if (zoomLevel === 'municipios' && centroids[geoKey]) {
              lat = centroids[geoKey][0]; lng = centroids[geoKey][1];
            }
            const zoom = mapRef.current?.getZoom() || 13;
            const zoomScale = Math.max(0.6, Math.min(1.0, (zoom - 7) / 6));
            const size = Math.round((36 + intensity * 28) * zoomScale);
            const fontSize = Math.round((11 + intensity * 5) * zoomScale);
            const icon = L.divIcon({
              className: 'crime-dot-icon',
              iconSize: [size, size],
              iconAnchor: [size / 2, size / 2],
              html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid ${color};opacity:0.85;display:flex;align-items:center;justify-content:center;"><span style="color:#fff;font-size:${fontSize}px;font-weight:700;text-shadow:0 1px 3px rgba(0,0,0,0.7);line-height:1;">${displayValue(d.weight, d.population, isRate)}</span></div>`
            });
            const marker = L.marker([lat, lng], { icon, zIndexOffset: Math.round((1 - intensity) * 1000) });
            bindInteractions(marker, label, d.weight, d.municipio, d.bairro || undefined, d.components, d.population);
            markersRef.current?.addLayer(marker);
          });
        }
      }
      // Re-open pending popup after reload cleared old layers
      if (pendingPopupRef.current && mapRef.current) {
        const pp = pendingPopupRef.current;
        if (onDetailOpenRef.current) {
          // Use DetailPanel — show loading state then fetch
          const pendingActionId = `${Date.now()}-${Math.random()}`;
          onDetailOpenRef.current({ actionId: pendingActionId, displayName: pp.displayName, municipio: pp.municipio, bairro: pp.bairro, total: 0, isUnknown: false, loading: true });
          (async () => {
            try {
              const f = filtersRef.current;
              const stats = await fetchLocationStats({
                municipio: pp.municipio, bairro: pp.bairro,
                semestre: f.semestre, ano: f.ano, tipo: f.tipo,
                grupo: f.grupo, sexo: f.sexo, cor: f.cor,
                idade_min: f.idade_min, idade_max: f.idade_max,
                ultimos_meses: f.ultimos_meses,
              });
              onDetailOpenRef.current!({ actionId: pendingActionId, displayName: pp.displayName, municipio: pp.municipio, bairro: pp.bairro,
                total: stats.total ?? 0, population: stats.population,
                isUnknown: false, loading: false,
                ...(stats.crime_types ? { crime_types: stats.crime_types.map((ct: any) => ({ tipo: ct.tipo_enquadramento || ct.tipo, count: ct.count })) } : {}),
              } as any);
            } catch {
              // leave panel open with zero data
            }
            pendingPopupRef.current = null;
          })();
        } else {
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
                ultimos_meses: f.ultimos_meses,
              });
              popup.setContent(buildBreakdownPopup(pp.displayName, stats, rateModeRef.current === 'rate'));
            } catch {
              popup.setContent(
                `<div class="popup-title">${pp.displayName}</div>` +
                `<div class="popup-detail">Erro ao carregar detalhes</div>`
              );
            }
            pendingPopupRef.current = null;
          })();
        }
      }
      // Keep Brazil outline behind data layers
      if (brazilOutlineRef.current) brazilOutlineRef.current.bringToBack();
    } catch (e: any) { if (e?.name !== 'AbortError') console.error('Load error:', e); } finally { if (thisLoadId === loadIdRef.current) setLoading(false); }
  // Fix #17: rateMode intentionally excluded from deps — rate is client-side only
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentZoom, zoomLevel, filters, mapVersion, viewMode, aggregationOverride, selectedStates, availableStates, compareMode]);
  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (!loading) { setLoadingMsg(''); setLoadingMsgVisible(false); return; }
    const level = currentZoom < 7 ? 'states' : currentZoom < 11 ? 'municipios' : 'bairros';
    const msgs: Record<string, string[]> = {
      states: ['Consultando registros estaduais...', 'Cruzando dados de RS, RJ e MG...', 'Normalizando ocorrências por população...', 'Calculando índices /100K hab...', 'Aplicando filtros temporais...', 'Agregando fontes SSP, ISP, SEJUSP...', 'Mapeando polígonos estaduais...'],
      municipios: ['Geocodificando municípios...', 'Cruzando crimes com fronteiras municipais...', 'Calculando pesos do mapa de calor...', 'Normalizando nomes de municípios...', 'Consultando 1.437 municípios...', 'Mesclando dados RS + staging...', 'Ordenando por densidade criminal...'],
      bairros: ['Identificando bairros por polígono...', 'Cruzando coordenadas GPS com fronteiras...', 'Consolidando variantes de nomes...', 'Calculando ocorrências por bairro...', 'Processando dados de lat/lng...', 'Aplicando correspondência difusa de nomes...', 'Filtrando bairros com 5+ registros...'],
    };
    const pool = msgs[level];
    let idx = 0;
    setLoadingMsg(pool[0]);
    const showTimer = setTimeout(() => setLoadingMsgVisible(true), 1500);
    const cycleTimer = setInterval(() => { idx = (idx + 1) % pool.length; setLoadingMsg(pool[idx]); }, 2500);
    return () => { clearTimeout(showTimer); clearInterval(cycleTimer); };
  }, [loading, currentZoom]);

  return (
    // Fix #13: aria-label on map container
    <div className="w-full h-full relative" aria-label="Mapa de criminalidade do Brasil">
      <div ref={containerRef} className="w-full h-full" />
      {loading && <div className="absolute inset-0 z-[999] bg-black/30 pointer-events-none transition-opacity" />}
      {loading && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[1000] pointer-events-none">
          <div className="bg-[#111827]/90 backdrop-blur-sm rounded-xl px-5 py-2.5 flex items-center gap-2 shadow-lg border border-[#1e293b]">
            <div className="w-4 h-4 border-2 border-[#3b82f6] border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-[#94a3b8]">{loadingMsgVisible ? loadingMsg : 'Carregando...'}</span>
          </div>
        </div>
      )}
      {/* Fix #10: empty result overlay */}
      {emptyResult && !loading && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[1000] pointer-events-none">
          <div className="bg-[#111827]/90 backdrop-blur-sm rounded-xl px-6 py-3 shadow-lg border border-[#1e293b] text-center">
            <span className="text-sm text-[#94a3b8]">Nenhum resultado encontrado</span>
          </div>
        </div>
      )}
      {/* Fix #18: GeoJSON load error overlay */}
      {geoError && !loading && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[1000]">
          <div className="bg-[#111827]/90 backdrop-blur-sm rounded-xl px-6 py-4 shadow-lg border border-red-500/40 text-center flex flex-col items-center gap-3">
            <span className="text-sm text-red-400">Erro ao carregar mapa</span>
            <button
              className="px-4 py-1.5 rounded-lg bg-[#3b82f6] text-white text-sm hover:bg-[#2563eb] transition-colors"
              onClick={() => { setGeoError(null); setMapVersion(v => v + 1); }}
            >
              Tentar novamente
            </button>
          </div>
        </div>
      )}
      <div className="absolute top-4 left-4 z-[1000] flex flex-col gap-1">
        <div className="bg-[#111827]/90 backdrop-blur-xl rounded-lg border border-[#1e293b] px-3 py-1.5">
          <span className="text-[10px] text-[#94a3b8] uppercase tracking-wider">
            {zoomLevel === 'states' ? 'Estados' : zoomLevel === 'municipios' ? 'Municípios' : 'Bairros'}
          </span>
        </div>
        {/* Fix #16: updated legend green from #22c55e to #16a34a */}
        <div className="flex gap-1">
          {[{c:'#16a34a',l:'Baixo'},{c:'#eab308',l:'Médio'},{c:'#f97316',l:'Alto'},{c:'#ef4444',l:'Crítico'}].map(i=>(
            <div key={i.l} className="flex items-center gap-1 bg-[#111827]/90 backdrop-blur-xl rounded-lg border border-[#1e293b] px-2 py-1">
              <div className="w-2 h-2 rounded-full" style={{background:i.c}} />
              <span className="text-[10px] text-[#94a3b8]">{i.l}</span>
            </div>
          ))}
        </div>
      </div>
      {(nonRsInfo || bairroMixedInfo || activeFilter || compareMode) && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none flex flex-col items-center gap-2">
          {nonRsInfo && (
            <div className="bg-[#111827]/90 backdrop-blur-sm rounded-xl px-5 py-2 shadow-lg border border-amber-500/30">
              <span className="text-xs text-amber-400">Dados por bairro disponíveis apenas para RS. RJ e MG exibem dados por município.</span>
            </div>
          )}
          {bairroMixedInfo && !nonRsInfo && (
            <div className="bg-[#111827]/90 backdrop-blur-sm rounded-xl px-5 py-2 shadow-lg border border-amber-500/30">
              <span className="text-xs text-amber-400">Dados por bairro disponíveis apenas para RS. RJ e MG exibem dados por município.</span>
            </div>
          )}
          {activeFilter && (
            <div className="bg-[#111827]/90 backdrop-blur-sm rounded-xl px-5 py-2 shadow-lg border border-amber-500/30">
              <span className="text-xs text-amber-400">{activeFilter.label}</span>
            </div>
          )}
          {compareMode && (
            <div className="bg-[#111827]/90 backdrop-blur-sm rounded-xl px-5 py-2 shadow-lg border border-[#7c3aed]/40">
              <span className="text-xs text-[#7c3aed]">
                {comparisonLocations.length === 0 ? 'Modo comparação — clique em um local' :
                 comparisonLocations.length === 1 ? 'Selecione outro local para comparar' :
                 'Comparação completa'}
              </span>
            </div>
          )}
        </div>
      )}
      {selectedStates.length === 0 && zoomLevel === 'states' && !loading && !emptyResult && !compareMode && (
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[1000] pointer-events-none">
          <div className="bg-[#111827]/90 backdrop-blur-sm rounded-xl px-5 py-2 shadow-lg border border-blue-500/30">
            <span className="text-xs text-[#94a3b8]">Clique em um estado para começar</span>
          </div>
        </div>
      )}

      {/* Hidden SVG with hatch pattern for disabled states */}
      <svg width="0" height="0" style={{ position: 'absolute' }}>
        <defs>
          <pattern id="disabled-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="#334155" strokeWidth="0.5" />
          </pattern>
        </defs>
      </svg>
    </div>
  );
}
