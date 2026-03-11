'use client';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { fetchStats, fetchCrimeTypes, fetchSemesters, fetchAutocomplete, fetchSexoValues, fetchCorValues, fetchGrupoValues, fetchFilterOptions, submitBugReport, fetchAvailableStates, fetchStateFilterInfo, fetchLocationStats, fetchStateStats, fetchSystemInfo, fetchDataAvailability } from '@/lib/api';
import { calcRate, formatRate } from '@/lib/rates';
import DetailPanel from '@/components/DetailPanel';
const CrimeMap = dynamic(() => import('@/components/CrimeMap'), { ssr: false });

const DATA_SOURCES = [
  { state: 'RS', name: 'SSP/RS', quality: 'full' as const },
  { state: 'RJ', name: 'ISP/RJ', quality: 'full' as const },
  { state: 'MG', name: 'SEJUSP/MG', quality: 'partial' as const, caveat: 'Apenas crimes violentos' },
  { state: 'SINESP', name: 'Ministério da Justiça e Segurança Pública', quality: 'basic' as const },
];

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

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function prettifyGrupo(s: string): string {
  const map: Record<string, string> = {
    'CRIMES': 'Crimes',
    'CONTRAVENCOES': 'Contravenções',
  };
  return map[s] || s.charAt(0) + s.slice(1).toLowerCase();
}

function formatCount(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function formatSemester(sem: string): string {
  const [year, s] = sem.split('-');
  return s === 'S1' ? `Jan-Jun ${year}` : `Jul-Dez ${year}`;
}

export default function Home() {
  const [stats, setStats] = useState<any>(null);
  const [crimeTypes, setCrimeTypes] = useState<any[]>([]);
  const [semesters, setSemesters] = useState<string[]>([]);
  const [selectedYear, setSelectedYear] = useState('');
  const [selectedPeriod, setSelectedPeriod] = useState<'ano' | 'S1' | 'S2' | '12m'>('12m');
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [center, setCenter] = useState<[number,number]>([-24,-47]);
  const [zoom, setZoom] = useState(5);
  const [showFilters, setShowFilters] = useState(false);
  const [filterLoading, setFilterLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'dots' | 'choropleth'>('choropleth');
  const [rateMode, setRateMode] = useState<'rate' | 'absolute'>('rate');
  const [aggregationOverride, setAggregationOverride] = useState<'auto'|'estados'|'municipios'|'bairros'>('auto');
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Victim demographic filters
  const [sexoValues, setSexoValues] = useState<any[]>([]);
  const [corValues, setCorValues] = useState<any[]>([]);
  const [grupoValues, setGrupoValues] = useState<any[]>([]);
  const [selectedGrupo, setSelectedGrupo] = useState<string[]>([]);
  const [selectedSexo, setSelectedSexo] = useState<string[]>([]);
  const [selectedCor, setSelectedCor] = useState<string[]>([]);
  const [idadeMin, setIdadeMin] = useState('');
  const [idadeMax, setIdadeMax] = useState('');

  // Bug report state
  const [showBugReport, setShowBugReport] = useState(false);
  const [bugDesc, setBugDesc] = useState('');
  const [bugEmail, setBugEmail] = useState('');
  const [bugImage, setBugImage] = useState('');
  const [hcaptchaToken, setHcaptchaToken] = useState('');
  const [bugSubmitting, setBugSubmitting] = useState(false);
  const [bugSuccess, setBugSuccess] = useState(false);
  const [bugError, setBugError] = useState('');
  const [crimeTypeSearch, setCrimeTypeSearch] = useState('');
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [detailPanels, setDetailPanels] = useState<any[]>([]);

  // State selection
  const [selectedStates, setSelectedStates] = useState<string[]>([]);
  const [availableStates, setAvailableStates] = useState<any[]>([]);
  const [activeFilter, setActiveFilter] = useState<{ label: string } | null>(null);
  const [maxGranularity, setMaxGranularity] = useState<'monthly' | 'yearly'>('monthly');
  const [showMgWarning, setShowMgWarning] = useState(false);
  const [pendingMgToggle, setPendingMgToggle] = useState<string | null>(null);

  const [showChangelog, setShowChangelog] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [dataSourcesApi, setDataSourcesApi] = useState<any[] | null>(null);

  // Comparison mode
  const [compareMode, setCompareMode] = useState(false);
  const [comparisonLocations, setComparisonLocations] = useState<any[]>([]);
  const [comparisonStats, setComparisonStats] = useState<any[]>([]);
  const [comparePos, setComparePos] = useState<{x: number, y: number} | null>(null);
  const [compareSize, setCompareSize] = useState({ w: 483 });
  const [compareDragging, setCompareDragging] = useState(false);
  const [compareResizing, setCompareResizing] = useState(false);
  const compareDragStart = useRef<{x: number, y: number, px: number, py: number} | null>(null);
  const compareResizeStart = useRef<{x: number, y: number, w: number} | null>(null);

  // System-wide static info
  const [systemInfo, setSystemInfo] = useState<any>(null);

  // Data availability warnings
  const [dataWarnings, setDataWarnings] = useState<string[]>([]);

  const CHANGELOG = [
    {
      date: '2026-03-11',
      title: 'Comparação aprimorada e melhorias de UI',
      items: [
        'Painel comparativo exibe população ("Hab.") de cada local lado a lado',
        'Modo /100K no comparativo unifica o "Total" na taxa per capita e oculta linha redundante',
        'Aviso de dados parciais quando MG é comparada com outro estado',
        'Cabeçalho "Tipos de crime" indica "/100K" quando taxa per capita está ativa',
        'Botão "Reportar Problema" agora exibe ícone e texto em destaque vermelho',
      ],
    },
    {
      date: '2026-03-06',
      title: 'Modo comparação e visualização por bairros',
      items: [
        'Modo comparação lado a lado entre dois estados, cidades ou bairros',
        'Painel de detalhes flutuante e arrastável ao clicar em qualquer região',
        'Visualização por bairros disponível para RS, RJ e MG (zoom aproximado)',
        'Filtro automático de compatibilidade ao comparar RS/RJ com MG',
      ],
    },
    {
      date: '2026-03-01',
      title: 'Taxa per capita, coropleto e filtros avançados',
      items: [
        'Taxa por 100 mil habitantes com escala de cores fixa',
        'Modo regiões (coropleto) como alternativa aos pontos',
        'Filtros por tipo de crime, grupo, sexo, cor da vítima e faixa etária',
        'Busca por cidade ou bairro com autocomplete',
        'Filtros em cascata: opções disponíveis se atualizam automaticamente',
      ],
    },
    {
      date: '2026-02-01',
      title: 'Lançamento',
      items: [
        'Mapa interativo com dados oficiais de segurança pública',
        'Dados de RS, RJ, MG e todos os 27 estados via SINESP',
        'Visualização por estado, município e bairro',
        'Filtros por tipo de crime e período',
      ],
    },
  ];

  const [initialLoading, setInitialLoading] = useState(true);
  useEffect(() => {
    Promise.all([
      fetchStats().then(setStats),
      fetchSemesters().then((s: string[]) => { setSemesters(s); if (s.length > 0) { setSelectedYear(s[0].split('-')[0]); setSelectedPeriod('12m'); } }),
      fetchFilterOptions({}).then((opts: any) => {
        const VALID_GRUPOS = ['CRIMES', 'CONTRAVENCOES'];
        setCrimeTypes((opts.tipo || []).map((t: any) => ({ tipo_enquadramento: t.value, count: t.count })));
        setGrupoValues((opts.grupo || []).filter((g: any) => VALID_GRUPOS.includes(g.value)));
        setSexoValues(opts.sexo || []);
        setCorValues(opts.cor || []);
      }),
      fetchAvailableStates().then(setAvailableStates).catch(() => {}),
      fetchSystemInfo().then(setSystemInfo).catch(() => {}),
    ]).finally(() => setInitialLoading(false));
  }, []);

  // Dynamic cascading filters: re-fetch options when any filter changes
  const filterDebounceRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(() => {
    if (initialLoading) return;
    if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    filterDebounceRef.current = setTimeout(() => {
      setFilterLoading(true);
      const params: any = {};
      if (selectedTypes.length) params.tipo = selectedTypes;
      if (selectedGrupo.length) params.grupo = selectedGrupo[0];
      if (selectedPeriod === '12m') params.ultimos_meses = 12;
      else if (selectedPeriod !== 'ano') params.semestre = `${selectedYear}-${selectedPeriod}`;
      else if (selectedYear) params.ano = selectedYear;
      if (selectedSexo.length) params.sexo = selectedSexo;
      if (selectedCor.length) params.cor = selectedCor;
      if (idadeMin) params.idade_min = Number(idadeMin);
      if (idadeMax) params.idade_max = Number(idadeMax);
      if (selectedStates.length) params.selected_states = selectedStates;
      fetchFilterOptions(params).then((opts: any) => {
        const VALID_GRUPOS = ['CRIMES', 'CONTRAVENCOES'];
        setCrimeTypes((opts.tipo || []).map((t: any) => ({ tipo_enquadramento: t.value, count: t.count })));
        setGrupoValues((opts.grupo || []).filter((g: any) => VALID_GRUPOS.includes(g.value)));
        setSexoValues(opts.sexo || []);
        setCorValues(opts.cor || []);
        if (opts.total !== undefined) {
          setStats((prev: any) => prev ? { ...prev, total_crimes: opts.total } : prev);
        }
      }).catch((e) => console.error('Filter options fetch failed:', e)).finally(() => setFilterLoading(false));
    }, 300);
  }, [selectedTypes, selectedGrupo, selectedYear, selectedPeriod, selectedSexo, selectedCor, idadeMin, idadeMax, initialLoading, selectedStates]);

  const onSearchChange = (val: string) => {
    setSearchQ(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();
    if (val.trim().length < 3) { setSuggestions([]); setShowSuggestions(false); setSearchLoading(false); return; }
    setSearchLoading(true);
    debounceRef.current = setTimeout(async () => {
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const results = await fetchAutocomplete(val.trim(), ac.signal);
        if (!ac.signal.aborted) {
          setSuggestions(results);
          setShowSuggestions(results.length > 0);
          setSearchLoading(false);
        }
      } catch { setSearchLoading(false); /* aborted */ }
    }, 500);
  };

  const onSelect = (item: any) => {
    setCenter([item.latitude, item.longitude]);
    if (item.type === 'state') {
      setZoom(7);
      // Auto-select the state if not already selected
      if (item.sigla && !selectedStates.includes(item.sigla)) {
        setSelectedStates(prev => [...prev, item.sigla]);
      }
    } else {
      setZoom(item.type === 'bairro' ? 14 : 12);
    }
    setSearchQ(item.name);
    setShowSuggestions(false);
    setSuggestions([]);
  };

  const years = useMemo(() => {
    const yrs = Array.from(new Set(semesters.map(s => s.split('-')[0]))).sort().reverse();
    return yrs;
  }, [semesters]);

  const availablePeriods = useMemo(() => {
    const periods: string[] = ['ano'];
    if (semesters.includes(`${selectedYear}-S1`)) periods.push('S1');
    if (semesters.includes(`${selectedYear}-S2`)) periods.push('S2');
    return periods;
  }, [semesters, selectedYear]);

  const onSelectYear = useCallback((yr: string) => {
    setSelectedYear(yr);
    setSelectedPeriod(prev => prev === '12m' ? 'ano' : prev);
  }, []);

  const toggleType = (t:string) => setSelectedTypes(p=>p.includes(t)?p.filter(x=>x!==t):[...p,t]);
  const toggleSexo = (v:string) => setSelectedSexo(p=>p.includes(v)?p.filter(x=>x!==v):[...p,v]);
  const toggleCor = (v:string) => setSelectedCor(p=>p.includes(v)?p.filter(x=>x!==v):[...p,v]);
  const toggleGrupo = (v:string) => setSelectedGrupo(p=>p.includes(v)?p.filter(x=>x!==v):[...p,v]);

  // Partial states that trigger auto-filter warning
  const PARTIAL_STATES = ['MG'];

  const toggleState = useCallback((sigla: string) => {
    const isPartial = PARTIAL_STATES.includes(sigla);
    const isAdding = !selectedStates.includes(sigla);
    if (isAdding && isPartial && selectedStates.length > 0) {
      setPendingMgToggle(sigla);
      setShowMgWarning(true);
      return;
    }
    if (isAdding && selectedStates.some(s => PARTIAL_STATES.includes(s)) && !isPartial) {
      setPendingMgToggle(sigla);
      setShowMgWarning(true);
      return;
    }
    setSelectedStates(prev =>
      prev.includes(sigla) ? prev.filter(s => s !== sigla) : [...prev, sigla]
    );
  }, [selectedStates]);

  const confirmMgWarning = useCallback(() => {
    if (pendingMgToggle) {
      setSelectedStates(prev => [...prev, pendingMgToggle]);
    }
    setShowMgWarning(false);
    setPendingMgToggle(null);
  }, [pendingMgToggle]);

  const cancelMgWarning = useCallback(() => {
    setShowMgWarning(false);
    setPendingMgToggle(null);
  }, []);

  // Fetch filter info when selected states change
  useEffect(() => {
    if (selectedStates.length === 0) {
      setActiveFilter(null);
      setMaxGranularity('monthly');
      return;
    }
    fetchStateFilterInfo(selectedStates).then((info: any) => {
      setActiveFilter(info.active_filter);
      setMaxGranularity(info.max_granularity || 'monthly');
    }).catch(() => {});
  }, [selectedStates]);

  // When granularity becomes yearly, reset period to 'ano' if semester is selected
  useEffect(() => {
    if (maxGranularity === 'yearly' && selectedPeriod !== 'ano' && selectedPeriod !== '12m') {
      setSelectedPeriod('ano');
    }
  }, [maxGranularity, selectedPeriod]);

  // Check data availability when year/period or selected states change
  const STATE_FULL_NAMES: Record<string, string> = { RS: 'Rio Grande do Sul', RJ: 'Rio de Janeiro', MG: 'Minas Gerais' };
  useEffect(() => {
    if (selectedStates.length === 0 || !selectedYear) {
      setDataWarnings([]);
      return;
    }
    const params: any = { selected_states: selectedStates };
    if (selectedPeriod === '12m') params.ultimos_meses = 12;
    else if (selectedPeriod !== 'ano') params.semestre = `${selectedYear}-${selectedPeriod}`;
    else params.ano = selectedYear;
    fetchDataAvailability(params).then((res: any) => {
      const warnings: string[] = [];
      for (const [state, info] of Object.entries(res.states || {})) {
        if (!(info as any).has_data) {
          const periodLabel = selectedPeriod === '12m' ? 'últimos 12 meses' : selectedPeriod !== 'ano' ? `${selectedPeriod === 'S1' ? 'Jan-Jun' : 'Jul-Dez'} ${selectedYear}` : selectedYear;
          const stateName = STATE_FULL_NAMES[state] || state;
          warnings.push(`${stateName} não possui dados para ${periodLabel}.`);
        }
      }
      setDataWarnings(warnings);
    }).catch(() => setDataWarnings([]));
  }, [selectedStates, selectedYear, selectedPeriod]);

  useEffect(() => {
    fetch('/api/data-sources').then(r => r.ok ? r.json() : null).then(d => { if (d) setDataSourcesApi(d); }).catch(() => {});
  }, []);

  // Demographic filters only available for RS detailed data
  const demographicFiltersDisabled = selectedStates.length > 0 && selectedStates.some(s => s !== 'RS');
  useEffect(() => {
    if (demographicFiltersDisabled) {
      setSelectedSexo([]);
      setSelectedCor([]);
      setIdadeMin('');
      setIdadeMax('');
    }
  }, [demographicFiltersDisabled]);

  const filters = useMemo(() => ({
    tipo: selectedTypes.length ? selectedTypes : undefined,
    grupo: selectedGrupo.length ? selectedGrupo[0] : undefined,
    ultimos_meses: selectedPeriod === '12m' ? 12 : undefined,
    semestre: selectedPeriod !== 'ano' && selectedPeriod !== '12m' ? `${selectedYear}-${selectedPeriod}` : undefined,
    ano: selectedPeriod === 'ano' ? selectedYear : undefined,
    sexo: selectedSexo.length ? selectedSexo : undefined,
    cor: selectedCor.length ? selectedCor : undefined,
    idade_min: idadeMin ? Number(idadeMin) : undefined,
    idade_max: idadeMax ? Number(idadeMax) : undefined,
    selected_states: selectedStates.length > 0 ? selectedStates : undefined,
  }), [selectedTypes, selectedGrupo, selectedYear, selectedPeriod, selectedSexo, selectedCor, idadeMin, idadeMax, selectedStates]);

  const onCompareSelect = useCallback(async (location: { municipio: string; bairro?: string; state?: string; displayName: string }) => {
    if (comparisonLocations.length >= 2) return;
    const isDup = comparisonLocations.some(l =>
      l.state === location.state && l.municipio === location.municipio && l.bairro === location.bairro
    );
    if (isDup) return;
    setComparisonLocations(prev => [...prev, location]);
    try {
      let stats;
      if (!location.municipio && location.state) {
        // State-level comparison
        const allStates = [...comparisonLocations.filter(l => l.state && !l.municipio).map(l => l.state!), location.state];
        stats = await fetchStateStats({
          state: location.state,
          selected_states: allStates,
          semestre: filters.semestre, ano: filters.ano, tipo: filters.tipo,
          grupo: filters.grupo, sexo: filters.sexo, cor: filters.cor,
          idade_min: filters.idade_min, idade_max: filters.idade_max,
        });
        // Re-fetch first state with compatible types filter when 2nd state added
        if (comparisonLocations.length === 1 && comparisonLocations[0].state && !comparisonLocations[0].municipio) {
          try {
            const firstStats = await fetchStateStats({
              state: comparisonLocations[0].state,
              selected_states: allStates,
              semestre: filters.semestre, ano: filters.ano, tipo: filters.tipo,
              grupo: filters.grupo, sexo: filters.sexo, cor: filters.cor,
              idade_min: filters.idade_min, idade_max: filters.idade_max,
            });
            setComparisonStats([{ ...firstStats, displayName: comparisonLocations[0].displayName }]);
          } catch {}
        }
      } else {
        stats = await fetchLocationStats({
          municipio: location.municipio,
          bairro: location.bairro,
          state: location.state,
          semestre: filters.semestre, ano: filters.ano, tipo: filters.tipo,
          grupo: filters.grupo, sexo: filters.sexo, cor: filters.cor,
          idade_min: filters.idade_min, idade_max: filters.idade_max,
          ultimos_meses: filters.ultimos_meses,
        });
      }
      setComparisonStats(prev => [...prev, { ...stats, displayName: location.displayName }]);
    } catch {
      setComparisonStats(prev => [...prev, { displayName: location.displayName, total: 0, crime_types: [] }]);
    }
  }, [comparisonLocations, filters]);

  const clearComparison = useCallback(() => {
    setComparisonLocations([]);
    setComparisonStats([]);
  }, []);

  // Compare box drag/resize handlers
  useEffect(() => {
    if (!compareDragging && !compareResizing) return;
    const onMove = (e: MouseEvent) => {
      if (compareDragging && compareDragStart.current) {
        setComparePos({
          x: compareDragStart.current.px + (e.clientX - compareDragStart.current.x),
          y: compareDragStart.current.py + (e.clientY - compareDragStart.current.y),
        });
      } else if (compareResizing && compareResizeStart.current) {
        const newW = Math.max(300, compareResizeStart.current.w + (e.clientX - compareResizeStart.current.x));
        setCompareSize({ w: newW });
      }
    };
    const onEnd = () => { setCompareDragging(false); setCompareResizing(false); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onEnd); };
  }, [compareDragging, compareResizing]);

  const onDetailOpen = useCallback((data: any) => {
    const panelId = data.displayName || String(Date.now());
    setDetailPanels(prev => {
      // Check if panel with same displayName exists (for two-phase merge)
      const existingIdx = prev.findIndex(p => p.displayName === data.displayName);
      if (existingIdx >= 0) {
        // Update existing panel
        const updated = [...prev];
        const existing = updated[existingIdx];
        updated[existingIdx] = {
          ...existing,
          ...data,
          id: existing.id,
          crime_types: data.crime_types || existing.crime_types,
          total: data.total || existing.total || 0,
          population: data.population !== undefined ? data.population : existing.population,
          loading: data.loading ?? false,
        };
        return updated;
      }
      // Add new panel (max 5)
      const newPanel = {
        ...data,
        id: panelId,
        total: data.total || 0,
        loading: data.loading ?? false,
      };
      const newPanels = [...prev, newPanel];
      return newPanels.length > 5 ? newPanels.slice(-5) : newPanels;
    });
  }, []);

  // Re-fetch open DetailPanels when filters change
  const detailPanelsRef = useRef(detailPanels);
  detailPanelsRef.current = detailPanels;
  const prevFiltersRef = useRef(filters);
  useEffect(() => {
    if (prevFiltersRef.current === filters) return;
    prevFiltersRef.current = filters;
    const panels = detailPanelsRef.current;
    if (!panels.length) return;
    panels.forEach(async (panel) => {
      try {
        if (panel.state && !panel.municipio) {
          const stats = await fetchStateStats({
            state: panel.state, ...filters, selected_states: selectedStates,
          });
          setDetailPanels(prev => prev.map(p =>
            p.id === panel.id ? { ...p, total: stats.total ?? p.total, population: stats.population ?? p.population,
              crime_types: stats.crime_types?.map((ct: any) => ({ tipo: ct.tipo_enquadramento || ct.tipo, count: ct.count })) ?? p.crime_types,
              crime_categories: stats.crime_categories ?? p.crime_categories } : p
          ));
        } else if (panel.municipio) {
          const stats = await fetchLocationStats({
            municipio: panel.municipio, bairro: panel.bairro, state: panel.state, ...filters,
          });
          setDetailPanels(prev => prev.map(p =>
            p.id === panel.id ? { ...p, total: stats.total ?? p.total, population: stats.population ?? p.population,
              crime_types: stats.crime_types?.map((ct: any) => ({ tipo: ct.tipo_enquadramento || ct.tipo, count: ct.count })) ?? p.crime_types,
              crime_categories: stats.crime_categories ?? p.crime_categories } : p
          ));
        }
      } catch (err) {
        console.error('Failed to refresh panel:', err);
      }
    });
  }, [filters]);

  const activeFilterCount = selectedTypes.length + selectedGrupo.length + selectedSexo.length + selectedCor.length + (idadeMin ? 1 : 0) + (idadeMax ? 1 : 0);

  const stateResults = suggestions.filter(s => s.type === 'state');
  const municResults = suggestions.filter(s => s.type === 'municipio');
  const bairroResults = suggestions.filter(s => s.type === 'bairro');

  const openBugReport = () => {
    setShowBugReport(true);
    setBugSuccess(false);
    setBugError('');
    setBugDesc('');
    setBugEmail('');
    setBugImage('');
    setHcaptchaToken('');
  };

  useEffect(() => {
    if (!showBugReport || bugSuccess) return;
    const siteKey = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY || '10000000-ffff-ffff-ffff-000000000000';
    const renderWidget = () => {
      const container = document.getElementById('hcaptcha-widget');
      if (container && (window as any).hcaptcha) {
        container.innerHTML = '';
        (window as any).hcaptcha.render('hcaptcha-widget', {
          sitekey: siteKey,
          theme: 'dark',
          callback: (token: string) => setHcaptchaToken(token),
          'expired-callback': () => setHcaptchaToken(''),
        });
      }
    };
    if ((window as any).hcaptcha) {
      // Script already loaded, just render after DOM update
      setTimeout(renderWidget, 0);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://js.hcaptcha.com/1/api.js?render=explicit';
    script.async = true;
    script.onload = () => setTimeout(renderWidget, 100);
    document.head.appendChild(script);
  }, [showBugReport, bugSuccess]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setBugImage(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleBugSubmit = async () => {
    if (!bugDesc.trim()) { setBugError('Descrição é obrigatória'); return; }
    if (!hcaptchaToken) { setBugError('Complete o captcha'); return; }
    setBugSubmitting(true);
    setBugError('');
    try {
      await submitBugReport({
        description: bugDesc,
        email: bugEmail || undefined,
        image: bugImage || undefined,
        hcaptcha_token: hcaptchaToken,
      });
      setBugSuccess(true);
    } catch (err: any) {
      setBugError(err.message || 'Erro ao enviar');
      setHcaptchaToken('');
      if (typeof window !== 'undefined' && (window as any).hcaptcha) {
        (window as any).hcaptcha.reset();
      }
    } finally {
      setBugSubmitting(false);
    }
  };

  return (
    <div className="h-dvh overflow-hidden bg-[#0a0f1a] flex flex-col">
      <header className="border-b border-[#1e293b] bg-[#111827]/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-[1800px] mx-auto px-4 py-2 md:py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 md:gap-3 shrink-0">
            <img src="/logo.svg" alt="Crime Brasil" className="h-8 sm:h-9" />
          </div>
          <div className="flex-1 max-w-md mx-2 md:mx-8 relative" ref={searchRef}>
            <input
              value={searchQ}
              onChange={e => onSearchChange(e.target.value)}
              onFocus={() => { setSearchFocused(true); if (suggestions.length > 0) setShowSuggestions(true); }}
              onBlur={() => { setSearchFocused(false); setTimeout(() => setShowSuggestions(false), 200); }}
              placeholder="Buscar cidade ou bairro (ex: Porto Alegre, Centro)"
              className="w-full bg-[#1a2234] border border-[#1e293b] rounded-xl px-4 py-2.5 text-sm text-[#f1f5f9] placeholder-[#475569] focus:outline-none focus:border-[#3b82f6]"
            />
            {searchFocused && searchQ.trim().length < 3 && !showSuggestions && !searchLoading && (
              <div className="absolute top-full mt-1 w-full bg-[#1a2234] border border-[#1e293b] rounded-xl overflow-hidden shadow-2xl z-[60] px-4 py-3">
                <span className="text-sm text-[#475569]">Digite pelo menos 3 letras para ver sugestões</span>
              </div>
            )}
            {searchFocused && searchLoading && searchQ.trim().length >= 3 && (
              <div className="absolute top-full mt-1 w-full bg-[#1a2234] border border-[#1e293b] rounded-xl overflow-hidden shadow-2xl z-[60] px-4 py-3">
                <span className="text-sm text-[#475569]">Buscando...</span>
              </div>
            )}
            {showSuggestions && (
              <div className="absolute top-full mt-1 w-full bg-[#1a2234] border border-[#1e293b] rounded-xl overflow-hidden shadow-2xl z-[60] max-h-80 overflow-y-auto">
                {stateResults.length > 0 && (
                  <>
                    <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-[#94a3b8] bg-[#111827]">Estados</div>
                    {stateResults.map((r, i) => (
                      <button key={'s'+i} onMouseDown={() => onSelect(r)} className="w-full px-4 py-2 text-left text-sm hover:bg-[#111827] flex justify-between items-center">
                        <span>{r.name}</span>
                        <span className="text-[#475569]">&rarr;</span>
                      </button>
                    ))}
                  </>
                )}
                {municResults.length > 0 && (
                  <>
                    <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-[#94a3b8] bg-[#111827]">Cidades</div>
                    {municResults.map((r, i) => (
                      <button key={'m'+i} onMouseDown={() => onSelect(r)} className="w-full px-4 py-2 text-left text-sm hover:bg-[#111827] flex justify-between items-center">
                        <span>{r.name}</span>
                        <span className="flex items-center gap-2">
                          <span className="text-[10px] text-[#94a3b8] font-mono">{formatCount(r.count)}</span>
                          <span className="text-[#475569]">&rarr;</span>
                        </span>
                      </button>
                    ))}
                  </>
                )}
                {bairroResults.length > 0 && (
                  <>
                    <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-[#94a3b8] bg-[#111827]">Bairros</div>
                    {bairroResults.map((r, i) => (
                      <button key={'b'+i} onMouseDown={() => onSelect(r)} className="w-full px-4 py-2 text-left text-sm hover:bg-[#111827] flex justify-between items-center">
                        <span>{r.name}</span>
                        <span className="flex items-center gap-2">
                          <span className="text-[10px] text-[#94a3b8] font-mono">{formatCount(r.count)}</span>
                          <span className="text-[#475569]">&rarr;</span>
                        </span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
          <div className="hidden sm:flex items-center gap-1.5">
            {years.length > 0 && (
              <div className="flex items-center gap-1">
                <div className="flex rounded-xl border border-[#1e293b] overflow-hidden">
                  <button onClick={() => setSelectedPeriod('12m')}
                    className={`px-2 py-2 text-xs ${selectedPeriod === '12m' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>
                    12m
                  </button>
                  <button onClick={() => setSelectedPeriod('ano')}
                    className={`px-2 py-2 text-xs ${selectedPeriod === 'ano' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>
                    Ano
                  </button>
                  {availablePeriods.includes('S1') && (
                    <button onClick={() => maxGranularity === 'monthly' && setSelectedPeriod('S1')}
                      title={maxGranularity === 'yearly' ? 'Filtro por semestre indisponível — dados do SINESP são anuais' : ''}
                      className={`px-2 py-2 text-xs ${selectedPeriod === 'S1' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'} ${maxGranularity === 'yearly' ? 'opacity-40 cursor-not-allowed' : ''}`}>
                      S1
                    </button>
                  )}
                  {availablePeriods.includes('S2') && (
                    <button onClick={() => maxGranularity === 'monthly' && setSelectedPeriod('S2')}
                      title={maxGranularity === 'yearly' ? 'Filtro por semestre indisponível — dados do SINESP são anuais' : ''}
                      className={`px-2 py-2 text-xs ${selectedPeriod === 'S2' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'} ${maxGranularity === 'yearly' ? 'opacity-40 cursor-not-allowed' : ''}`}>
                      S2
                    </button>
                  )}
                </div>
                {selectedPeriod === '12m' ? (
                  <span className="text-xs text-[#94a3b8] px-2">
                    {(() => {
                      const now = new Date();
                      const from = new Date(now);
                      from.setMonth(from.getMonth() - 12);
                      const fmt = (d: Date) => d.toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' });
                      return `${fmt(from)} – ${fmt(now)}`;
                    })()}
                  </span>
                ) : (
                  <select
                    value={selectedYear}
                    onChange={e => onSelectYear(e.target.value)}
                    className="bg-[#1a2234] border border-[#1e293b] rounded-xl px-2 py-2 text-xs text-[#f1f5f9] cursor-pointer appearance-none pr-6"
                    style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center' }}
                  >
                    {years.map(yr => (
                      <option key={yr} value={yr}>{yr}</option>
                    ))}
                  </select>
                )}
              </div>
            )}
            {/* Fix #13: aria-label on view toggle buttons */}
            <div className="flex rounded-xl border border-[#1e293b] overflow-hidden" role="group" aria-label="Modo de visualização">
              <button onClick={()=>setViewMode('choropleth')} aria-label="Visualização em regiões" className={`px-2 py-2 text-xs ${viewMode==='choropleth'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>Regiões</button>
              <button onClick={()=>setViewMode('dots')} aria-label="Visualização em pontos" className={`px-2 py-2 text-xs ${viewMode==='dots'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>Pontos</button>
            </div>
            <div className="flex rounded-xl border border-[#1e293b] overflow-hidden" role="group" aria-label="Modo de taxa">
              <button onClick={()=>setRateMode('rate')} aria-label="Taxa por 100 mil habitantes" className={`px-2 py-2 text-xs ${rateMode==='rate'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>/100K</button>
              <button onClick={()=>setRateMode('absolute')} aria-label="Total absoluto" className={`px-2 py-2 text-xs ${rateMode==='absolute'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>Total</button>
            </div>
            <div className="flex rounded-xl border border-[#1e293b] overflow-hidden" role="group" aria-label="Nível de agregação">
              {(['auto','estados','municipios','bairros'] as const).map(v=>(
                <button key={v} onClick={()=>setAggregationOverride(v)}
                  aria-label={v==='auto'?'Agregação automática':v==='estados'?'Estados':v==='municipios'?'Municípios':'Bairros'}
                  className={`px-2 py-2 text-xs ${aggregationOverride===v?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>
                  {v==='auto'?'Auto':v==='estados'?'Est.':v==='municipios'?'Mun.':'Bairros'}
                </button>
              ))}
            </div>
            <button onClick={()=>setShowFilters(!showFilters)} className="flex items-center gap-1.5 px-2 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-xs hover:bg-[#1e293b]">Filtros{activeFilterCount>0&&<span className="bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">{activeFilterCount}</span>}</button>
          </div>
          {/* Fix #13: aria-label on hamburger button */}
          <button
            className="sm:hidden p-2 rounded-lg bg-[#1a2234] border border-[#1e293b]"
            onClick={() => setShowMobileMenu(!showMobileMenu)}
            aria-label="Abrir menu de navegação"
          >
            <svg className="w-5 h-5 text-[#94a3b8]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
        </div>
        {showMobileMenu && (
          <div className="sm:hidden border-t border-[#1e293b] p-3 space-y-3 bg-[#111827] max-h-[50vh] overflow-y-auto">
            {years.length > 0 && (
              <div className="space-y-2">
                <span className="text-[10px] text-[#94a3b8] uppercase tracking-wider">Período</span>
                {selectedPeriod !== '12m' && (
                  <select
                    value={selectedYear}
                    onChange={e => onSelectYear(e.target.value)}
                    className="w-full bg-[#1a2234] border border-[#1e293b] rounded-xl px-3 py-2 text-sm text-[#f1f5f9] cursor-pointer"
                  >
                    {years.map(yr => (
                      <option key={yr} value={yr}>{yr}</option>
                    ))}
                  </select>
                )}
                <div className="flex flex-wrap gap-1">
                  <button onClick={() => setSelectedPeriod('12m')} className={`px-2.5 py-1 text-xs rounded-lg ${selectedPeriod === '12m' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8]'}`}>12 meses</button>
                  <button onClick={() => setSelectedPeriod('ano')} className={`px-2.5 py-1 text-xs rounded-lg ${selectedPeriod === 'ano' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8]'}`}>Ano</button>
                  {availablePeriods.includes('S1') && <button onClick={() => setSelectedPeriod('S1')} className={`px-2.5 py-1 text-xs rounded-lg ${selectedPeriod === 'S1' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8]'}`}>Jan-Jun</button>}
                  {availablePeriods.includes('S2') && <button onClick={() => setSelectedPeriod('S2')} className={`px-2.5 py-1 text-xs rounded-lg ${selectedPeriod === 'S2' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8]'}`}>Jul-Dez</button>}
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <div className="flex rounded-xl border border-[#1e293b] overflow-hidden">
                <button onClick={()=>setViewMode('choropleth')} className={`px-3 py-2 text-sm ${viewMode==='choropleth'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8]'}`}>Regiões</button>
                <button onClick={()=>setViewMode('dots')} className={`px-3 py-2 text-sm ${viewMode==='dots'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8]'}`}>Pontos</button>
              </div>
              <div className="flex rounded-xl border border-[#1e293b] overflow-hidden">
                <button onClick={()=>setRateMode('rate')} className={`px-3 py-2 text-sm ${rateMode==='rate'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8]'}`}>/100K</button>
                <button onClick={()=>setRateMode('absolute')} className={`px-3 py-2 text-sm ${rateMode==='absolute'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8]'}`}>Total</button>
              </div>
              <div className="flex rounded-xl border border-[#1e293b] overflow-hidden">
                {(['auto','estados','municipios','bairros'] as const).map(v=>(
                  <button key={v} onClick={()=>setAggregationOverride(v)} className={`px-2.5 py-2 text-xs ${aggregationOverride===v?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8]'}`}>{v==='auto'?'Auto':v==='estados'?'Estados':v==='municipios'?'Municípios':'Bairros'}</button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={()=>{setShowFilters(!showFilters);setShowMobileMenu(false);}} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm">Filtros{activeFilterCount>0&&<span className="bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">{activeFilterCount}</span>}</button>
              <button onClick={()=>{openBugReport();setShowMobileMenu(false);}} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm text-[#b91c1c]"><svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 116 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 014-4h4a4 4 0 014 4v3c0 3.3-2.7 6-6 6z"/><path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M6 17l-4 1M17.47 9c1.93-.2 3.53-1.9 3.53-4M18 13h4M18 17l4 1"/></svg>Reportar Problema</button>
              <button onClick={()=>{setShowHelp(true);setShowMobileMenu(false);}} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm text-[#94a3b8]"><svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r=".5"/></svg>Como usar</button>
              <button onClick={()=>{setShowChangelog(true);setShowMobileMenu(false);}} className="px-3 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm text-[#94a3b8]">Novidades</button>
              <button onClick={()=>{setShowSources(!showSources);setShowMobileMenu(false);}} className="px-3 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm text-[#94a3b8]">Fontes</button>
              <a href="mailto:contato@crimebrasil.com.br" className="px-3 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm text-[#94a3b8]">Contato</a>
              <a href="https://linkedin.com/in/israel-l-b00800116" target="_blank" rel="noopener noreferrer" className="px-3 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm text-[#a78bfa] hover:text-[#c4b5fd]">Designed by I.L.S.</a>
            </div>
          </div>
        )}
        </header>
      {dataWarnings.length > 0 && (
        <div className="bg-amber-900/30 border-b border-amber-500/30 px-4 py-1.5 flex items-center justify-center gap-2">
          <span className="text-xs text-amber-400">{dataWarnings.join(' ')}</span>
          <button onClick={() => setDataWarnings([])} className="text-amber-400/60 hover:text-amber-400 text-xs ml-2">✕</button>
        </div>
      )}
      <div className={`flex ${dataWarnings.length > 0 ? 'h-[calc(100dvh-56px-32px)] md:h-[calc(100dvh-80px-32px)]' : 'h-[calc(100dvh-56px)] md:h-[calc(100dvh-80px)]'}`}>
        {/* Fix #11: backdrop overlay that closes sidebar on mobile click */}
        {showFilters && (
          <div
            className="fixed inset-0 z-40 sm:hidden bg-black/40"
            aria-hidden="true"
            onClick={() => setShowFilters(false)}
          />
        )}
        {showFilters&&(
          /* Fix #13: role="region" and aria-label on sidebar */
          <aside
            className="fixed inset-y-0 left-0 z-50 w-80 sm:relative sm:inset-auto sm:z-0 sm:w-80 border-r border-[#1e293b] bg-[#111827] overflow-y-auto p-4 space-y-4"
            role="region"
            aria-label="Filtros"
            onClick={e => e.stopPropagation()}
          >
          <div className="flex justify-between items-center sm:hidden mb-3">
            <h2 className="text-base font-bold">Filtros</h2>
            {/* Fix #12: min touch target on close button */}
            <button onClick={() => setShowFilters(false)} className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-[#1a2234] border border-[#1e293b] text-[#94a3b8] text-sm" aria-label="Fechar filtros">✕</button>
          </div>
          <div>
            <h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Estados</h3>
            <div className="space-y-0.5 max-h-48 overflow-y-auto">
              {availableStates.filter((s: any) => s.quality === 'full' || s.quality === 'partial').map((s: any) => (
                <label key={s.sigla} className="flex items-center gap-2 px-2 py-1.5 min-h-[36px] rounded-lg hover:bg-[#1a2234] cursor-pointer text-sm">
                  <input type="checkbox" checked={selectedStates.includes(s.sigla)} onChange={() => toggleState(s.sigla)} />
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    s.quality === 'full' ? 'bg-green-500' :
                    s.quality === 'partial' ? 'bg-amber-500' : 'bg-gray-500'
                  }`} />
                  <span className="flex-1 truncate">{s.sigla}</span>
                  <span className="text-[10px] text-[#94a3b8] font-mono">
                    {s.quality === 'full' ? 'Completo' : s.quality === 'partial' ? 'Parcial' : 'SINESP'}
                  </span>
                </label>
              ))}
            </div>
            {selectedStates.length > 0 && (
              <button onClick={() => { setSelectedStates([]); setActiveFilter(null); }} className="mt-1 text-[10px] text-[#3b82f6] hover:text-[#60a5fa]">Limpar seleção</button>
            )}
          </div>
          <div className={filterLoading ? 'opacity-50 pointer-events-none transition-opacity' : 'transition-opacity'}>
          <div>
            <h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Tipo de Crime</h3>
            <input value={crimeTypeSearch} onChange={e=>setCrimeTypeSearch(e.target.value)} placeholder="Buscar tipo..." className="w-full bg-[#1a2234] border border-[#1e293b] rounded-lg px-3 py-1.5 text-sm text-[#f1f5f9] placeholder-[#475569] focus:outline-none focus:border-[#3b82f6] mb-2" />
            {/* Fix #12: py-2 px-1 minimum on filter labels for WCAG 44px touch targets */}
            <div className="space-y-0.5 max-h-64 overflow-y-auto">
              {crimeTypes.filter((ct:any)=>!crimeTypeSearch||stripAccents(prettifyCrimeType(ct.tipo_enquadramento)).toLowerCase().includes(stripAccents(crimeTypeSearch).toLowerCase())).map((ct:any)=>(
                <label key={ct.tipo_enquadramento} className="flex items-center gap-2 px-2 py-2 min-h-[44px] rounded-lg hover:bg-[#1a2234] cursor-pointer text-sm">
                  <input type="checkbox" checked={selectedTypes.includes(ct.tipo_enquadramento)} onChange={()=>toggleType(ct.tipo_enquadramento)} />
                  <span className="flex-1 truncate">{prettifyCrimeType(ct.tipo_enquadramento)}</span>
                  <span className="text-[10px] text-[#94a3b8] font-mono">{ct.count.toLocaleString()}</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Grupo</h3>
            <div className="space-y-0.5">
              {grupoValues.map((gv:any)=>(
                <label key={gv.value} className="flex items-center gap-2 px-2 py-2 min-h-[44px] rounded-lg hover:bg-[#1a2234] cursor-pointer text-sm">
                  <input type="checkbox" checked={selectedGrupo.includes(gv.value)} onChange={()=>toggleGrupo(gv.value)} />
                  <span className="flex-1 truncate">{prettifyGrupo(gv.value)}</span>
                  <span className="text-[10px] text-[#94a3b8] font-mono">{gv.count.toLocaleString()}</span>
                </label>
              ))}
            </div>
          </div>
          <div className={demographicFiltersDisabled ? 'opacity-50 pointer-events-none' : ''}>
            <h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Sexo da Vítima{demographicFiltersDisabled && <span className="ml-1 text-[8px] text-amber-500">(apenas RS)</span>}</h3>
            <div className="space-y-0.5">
              {sexoValues.map((sv:any)=>(
                <label key={sv.value} className="flex items-center gap-2 px-2 py-2 min-h-[44px] rounded-lg hover:bg-[#1a2234] cursor-pointer text-sm">
                  <input type="checkbox" checked={selectedSexo.includes(sv.value)} onChange={()=>toggleSexo(sv.value)} />
                  <span className="flex-1">{sv.value}</span>
                  <span className="text-[10px] text-[#94a3b8] font-mono">{sv.count.toLocaleString()}</span>
                </label>
              ))}
            </div>
          </div>
          <div className={demographicFiltersDisabled ? 'opacity-50 pointer-events-none' : ''}>
            <h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Cor da Vítima{demographicFiltersDisabled && <span className="ml-1 text-[8px] text-amber-500">(apenas RS)</span>}</h3>
            <div className="space-y-0.5">
              {corValues.map((cv:any)=>(
                <label key={cv.value} className="flex items-center gap-2 px-2 py-2 min-h-[44px] rounded-lg hover:bg-[#1a2234] cursor-pointer text-sm">
                  <input type="checkbox" checked={selectedCor.includes(cv.value)} onChange={()=>toggleCor(cv.value)} />
                  <span className="flex-1">{cv.value}</span>
                  <span className="text-[10px] text-[#94a3b8] font-mono">{cv.count.toLocaleString()}</span>
                </label>
              ))}
            </div>
          </div>
          <div className={demographicFiltersDisabled ? 'opacity-50 pointer-events-none' : ''}>
            <h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Idade da Vítima{demographicFiltersDisabled && <span className="ml-1 text-[8px] text-amber-500">(apenas RS)</span>}</h3>
            <div className="flex gap-2">
              <input type="number" placeholder="Mín" value={idadeMin} onChange={e=>setIdadeMin(e.target.value)} min={0} max={120} className="w-1/2 bg-[#1a2234] border border-[#1e293b] rounded-lg px-3 py-2 text-sm" />
              <input type="number" placeholder="Máx" value={idadeMax} onChange={e=>setIdadeMax(e.target.value)} min={0} max={120} className="w-1/2 bg-[#1a2234] border border-[#1e293b] rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>
          </div>
        </aside>)}
        <main className="flex-1 relative z-0">
          <CrimeMap center={center} zoom={zoom} filters={filters} viewMode={viewMode} rateMode={rateMode} aggregationOverride={aggregationOverride} selectedStates={selectedStates} onToggleState={toggleState} activeFilter={activeFilter} maxGranularity={maxGranularity} availableStates={availableStates} compareMode={compareMode} comparisonLocations={comparisonLocations} onCompareSelect={onCompareSelect} onDetailOpen={onDetailOpen} />
          {/* Floating compare toggle on map — visible on all screen sizes */}
          <button
            onClick={() => { const entering = !compareMode; setCompareMode(entering); if (!entering) setComparePos(null); if (entering) setSelectedStates([]); setComparisonLocations([]); setComparisonStats([]); }}
            aria-label={compareMode ? 'Desativar comparação' : 'Ativar comparação'}
            className={`absolute top-[60px] md:top-[116px] left-4 z-[1000] flex items-center gap-2 px-4 py-2.5 rounded-full text-xs font-medium shadow-lg transition-colors ${compareMode ? 'bg-[#7c3aed] text-white border border-[#7c3aed]' : 'bg-[#111827]/90 backdrop-blur-xl border border-[#7c3aed]/60 text-[#c4b5fd] hover:bg-[#7c3aed]/20 hover:text-[#e9d5ff]'}`}
          >
            <span className="relative w-8 h-4 rounded-full bg-[#1e293b] flex-shrink-0">
              <span className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${compareMode ? 'left-[18px] bg-white' : 'left-0.5 bg-[#94a3b8]'}`} />
            </span>
            <span className="hidden sm:inline">Modo comparação</span>
            <span className="sm:hidden">Comparar</span>
          </button>
          {/* Comparison mode panel */}
          {compareMode && (
            <div
              className={comparePos ? '' : 'absolute top-4 right-2 md:right-14 w-[calc(100vw-1rem)] sm:w-[441px]'}
              style={comparePos
                ? { position: 'absolute', left: comparePos.x, top: comparePos.y, width: compareSize.w, zIndex: 1001 }
                : { zIndex: 1001 }}
            >
              <div className="relative bg-[#111827]/95 backdrop-blur-xl border border-[#7c3aed]/40 rounded-xl p-3 shadow-2xl">
                <div
                  className="flex justify-between items-center mb-1 cursor-grab active:cursor-grabbing select-none"
                  onMouseDown={(e) => {
                    const rect = e.currentTarget.closest('.absolute, [style]')?.getBoundingClientRect();
                    const parentRect = (e.currentTarget.closest('.absolute, [style]') as HTMLElement)?.offsetParent?.getBoundingClientRect();
                    const currentX = comparePos ? comparePos.x : (rect && parentRect ? rect.left - parentRect.left : 0);
                    const currentY = comparePos ? comparePos.y : (rect && parentRect ? rect.top - parentRect.top : 4);
                    compareDragStart.current = { x: e.clientX, y: e.clientY, px: currentX, py: currentY };
                    if (!comparePos && rect && parentRect) {
                      setComparePos({ x: rect.left - parentRect.left, y: rect.top - parentRect.top });
                    }
                    setCompareDragging(true);
                  }}
                >
                  <h3 className="text-xs uppercase tracking-wider text-[#7c3aed] font-semibold">Comparar locais</h3>
                  {comparisonLocations.length > 0 && (
                    <button onClick={clearComparison} className="text-[10px] text-[#94a3b8] hover:text-[#f1f5f9]">Limpar</button>
                  )}
                </div>
                <p className="text-[10px] text-[#64748b] mb-2 leading-snug">Compare criminalidade entre dois locais — mesma janela de tempo e filtros ativos.</p>
                {comparisonLocations.length === 0 && (
                  <p className="text-xs text-[#94a3b8]">Clique em um local no mapa para selecionar o primeiro ponto de comparação.</p>
                )}
                {comparisonLocations.length === 1 && comparisonStats.length < 2 && (
                  <p className="text-xs text-[#94a3b8] mt-1">Selecione outro local para comparar.</p>
                )}
                {comparisonStats.length >= 1 && (
                  <div className="mt-2 space-y-2">
                    {comparisonStats.length === 2 ? (
                      // Side-by-side comparison
                      <div>
                        <div className="grid grid-cols-3 gap-1 text-[10px] mb-1">
                          <div className="text-[#94a3b8]"></div>
                          <div className="text-center font-semibold text-[#7c3aed] truncate" title={comparisonStats[0].displayName}>{comparisonStats[0].displayName}</div>
                          <div className="text-center font-semibold text-[#3b82f6] truncate" title={comparisonStats[1].displayName}>{comparisonStats[1].displayName}</div>
                        </div>
                        {/* MG partial-state warning */}
                        {comparisonLocations.some((l: any) => l.state === 'MG') && !comparisonLocations.every((l: any) => l.state === 'MG') && (
                          <div className="flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 mb-1">
                            <span className="text-[10px] text-amber-400 leading-snug">Dados parciais — MG inclui apenas crimes violentos. RS/RJ filtrados para tipos compatíveis.</span>
                          </div>
                        )}
                        <div className="grid grid-cols-3 gap-1 text-xs border-t border-[#1e293b] pt-1">
                          <div className="text-[#94a3b8]">{rateMode === 'rate' && comparisonStats[0].population && comparisonStats[1].population ? 'Total /100K' : 'Total'}</div>
                          <div className="text-center font-mono">
                            {rateMode === 'rate' && comparisonStats[0].population && comparisonStats[1].population
                              ? ((comparisonStats[0].total / comparisonStats[0].population) * 100000).toFixed(1)
                              : (comparisonStats[0].total?.toLocaleString() || 0)}
                          </div>
                          <div className="text-center font-mono">
                            {rateMode === 'rate' && comparisonStats[0].population && comparisonStats[1].population
                              ? ((comparisonStats[1].total / comparisonStats[1].population) * 100000).toFixed(1)
                              : (comparisonStats[1].total?.toLocaleString() || 0)}
                          </div>
                        </div>
                        {/* Hab. row — show when at least one population exists */}
                        {(comparisonStats[0].population || comparisonStats[1].population) && (
                          <div className="grid grid-cols-3 gap-1 text-xs">
                            <div className="text-[#94a3b8]">Hab.</div>
                            <div className="text-center font-mono">{comparisonStats[0].population ? comparisonStats[0].population.toLocaleString('pt-BR') : '—'}</div>
                            <div className="text-center font-mono">{comparisonStats[1].population ? comparisonStats[1].population.toLocaleString('pt-BR') : '—'}</div>
                          </div>
                        )}
                        {/* /100K row — only in absolute mode */}
                        {rateMode === 'absolute' && comparisonStats[0].population && comparisonStats[1].population && (
                          <div className="grid grid-cols-3 gap-1 text-xs">
                            <div className="text-[#94a3b8]">/100K</div>
                            <div className="text-center font-mono">{((comparisonStats[0].total / comparisonStats[0].population) * 100000).toFixed(1)}</div>
                            <div className="text-center font-mono">{((comparisonStats[1].total / comparisonStats[1].population) * 100000).toFixed(1)}</div>
                          </div>
                        )}
                        <div className="grid grid-cols-3 gap-1 text-xs">
                          <div className="text-[#94a3b8]">Diferença</div>
                          {(() => {
                            const useRate = rateMode === 'rate'
                              && comparisonStats[0].population && comparisonStats[1].population;
                            const toVal = (s: any) => useRate
                              ? (s.total / s.population) * 100000
                              : (s.total || 0);
                            const a = toVal(comparisonStats[0]);
                            const b = toVal(comparisonStats[1]);
                            if (a === 0 && b === 0) return <><div className="text-center font-mono">—</div><div className="text-center font-mono">—</div></>;
                            const diffA = b > 0 ? ((a - b) / b) * 100 : (a > 0 ? 100 : 0);
                            const diffB = a > 0 ? ((b - a) / a) * 100 : (b > 0 ? 100 : 0);
                            const ratioA = a > 0 && b > 0 ? (a / b).toFixed(1) : null;
                            const ratioB = a > 0 && b > 0 ? (b / a).toFixed(1) : null;
                            return <>
                              <div className={`text-center font-mono ${a > b ? 'text-red-400' : a < b ? 'text-green-400' : ''}`}>
                                {a > b ? `+${diffA.toFixed(0)}%` : a < b ? `${diffA.toFixed(0)}%` : '='}{ratioA ? ` (${ratioA}x)` : ''}
                              </div>
                              <div className={`text-center font-mono ${b > a ? 'text-red-400' : b < a ? 'text-green-400' : ''}`}>
                                {b > a ? `+${diffB.toFixed(0)}%` : b < a ? `${diffB.toFixed(0)}%` : '='}{ratioB ? ` (${ratioB}x)` : ''}
                              </div>
                            </>;
                          })()}
                        </div>
                        {/* Crime type breakdown comparison */}
                        {(() => {
                          const useRate = rateMode === 'rate'
                            && comparisonStats[0].population && comparisonStats[1].population;
                          const fmt = (v: number) => useRate ? v.toFixed(1) : v.toLocaleString();
                          const toRate = (count: number, stats: any) =>
                            useRate && stats.population ? (count / stats.population) * 100000 : count;
                          // Use canonical categories for cross-state comparison
                          const useCats = comparisonStats.every((s: any) => s.crime_categories?.length > 0);
                          if (useCats) {
                            const allCats = new Set<string>();
                            comparisonStats.forEach((s: any) => (s.crime_categories || []).forEach((cc: any) => allCats.add(cc.category)));
                            const catArr = Array.from(allCats).sort((a, b) => {
                              const totalA = comparisonStats.reduce((sum: number, s: any) => sum + ((s.crime_categories || []).find((c: any) => c.category === a)?.count || 0), 0);
                              const totalB = comparisonStats.reduce((sum: number, s: any) => sum + ((s.crime_categories || []).find((c: any) => c.category === b)?.count || 0), 0);
                              return totalB - totalA;
                            });
                            const getCatCount = (stats: any, cat: string) => {
                              const cc = (stats.crime_categories || []).find((c: any) => c.category === cat);
                              return cc ? cc.count : 0;
                            };
                            return <div className="max-h-60 overflow-y-auto">{catArr.map(cat => {
                              const raw0 = getCatCount(comparisonStats[0], cat);
                              const raw1 = getCatCount(comparisonStats[1], cat);
                              const c0 = toRate(raw0, comparisonStats[0]);
                              const c1 = toRate(raw1, comparisonStats[1]);
                              const diff = c0 > 0 ? (((c1 - c0) / c0) * 100) : 0;
                              return (
                                <div key={cat} className="grid grid-cols-4 gap-1 text-[10px]">
                                  <div className="text-[#94a3b8] truncate" title={cat}>{cat}</div>
                                  <div className="text-center font-mono">{fmt(c0)}</div>
                                  <div className="text-center font-mono">{fmt(c1)}</div>
                                  <div className={`text-center font-mono ${diff > 0 ? 'text-red-400' : diff < 0 ? 'text-green-400' : 'text-[#94a3b8]'}`}>
                                    {c0 > 0 ? `${diff > 0 ? '+' : ''}${diff.toFixed(0)}%` : '—'}
                                  </div>
                                </div>
                              );
                            })}</div>;
                          }
                          // Fallback to raw crime types (same-state comparison)
                          const allTypes = new Set<string>();
                          comparisonStats.forEach(s => (s.crime_types || []).forEach((ct: any) => allTypes.add(ct.tipo_enquadramento)));
                          const typeArr = Array.from(allTypes).sort((a, b) => {
                            const totalA = comparisonStats.reduce((sum: number, s: any) => sum + ((s.crime_types || []).find((c: any) => c.tipo_enquadramento === a)?.count || 0), 0);
                            const totalB = comparisonStats.reduce((sum: number, s: any) => sum + ((s.crime_types || []).find((c: any) => c.tipo_enquadramento === b)?.count || 0), 0);
                            return totalB - totalA;
                          });
                          const getCount = (stats: any, tipo: string) => {
                            const ct = (stats.crime_types || []).find((c: any) => c.tipo_enquadramento === tipo);
                            return ct ? ct.count : 0;
                          };
                          return <div className="max-h-60 overflow-y-auto">{typeArr.map(tipo => {
                            const raw0 = getCount(comparisonStats[0], tipo);
                            const raw1 = getCount(comparisonStats[1], tipo);
                            const c0 = toRate(raw0, comparisonStats[0]);
                            const c1 = toRate(raw1, comparisonStats[1]);
                            const diff = c0 > 0 ? (((c1 - c0) / c0) * 100) : 0;
                            return (
                              <div key={tipo} className="grid grid-cols-4 gap-1 text-[10px]">
                                <div className="text-[#94a3b8] truncate" title={prettifyCrimeType(tipo)}>{prettifyCrimeType(tipo)}</div>
                                <div className="text-center font-mono">{fmt(c0)}</div>
                                <div className="text-center font-mono">{fmt(c1)}</div>
                                <div className={`text-center font-mono ${diff > 0 ? 'text-red-400' : diff < 0 ? 'text-green-400' : 'text-[#94a3b8]'}`}>
                                  {c0 > 0 ? `${diff > 0 ? '+' : ''}${diff.toFixed(0)}%` : '—'}
                                </div>
                              </div>
                            );
                          })}</div>;
                        })()}
                      </div>
                    ) : (
                      // Single location selected
                      <div className="text-xs">
                        <div className="font-semibold text-[#7c3aed] mb-1">{comparisonStats[0].displayName}</div>
                        <div className="text-[#94a3b8]">Total: <span className="font-mono text-[#f1f5f9]">{comparisonStats[0].total?.toLocaleString() || 0}</span></div>
                        {comparisonStats[0].population && (
                          <div className="text-[#94a3b8]">Taxa: <span className="font-mono text-[#f1f5f9]">{((comparisonStats[0].total / comparisonStats[0].population) * 100000).toFixed(1)} /100K</span></div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {/* Resize handle */}
                <div
                  className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    compareResizeStart.current = { x: e.clientX, y: e.clientY, w: compareSize.w };
                    setCompareResizing(true);
                  }}
                />
              </div>
            </div>
          )}
          {/* Bottom-right utility links */}
          <div className="absolute bottom-2 right-2 sm:bottom-4 sm:right-4 z-[1000] hidden sm:flex items-center gap-3">
            <button onClick={openBugReport} className="flex items-center gap-1.5 text-[#b91c1c] hover:text-[#dc2626] transition-colors" title="Reportar Problema">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 116 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 014-4h4a4 4 0 014 4v3c0 3.3-2.7 6-6 6z"/><path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M6 17l-4 1M17.47 9c1.93-.2 3.53-1.9 3.53-4M18 13h4M18 17l4 1"/></svg>
              <span className="text-xs">Reportar Problema</span>
            </button>
            <button onClick={() => setShowHelp(true)} className="text-[#64748b] hover:text-[#94a3b8] transition-colors" title="Como usar">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r=".5"/></svg>
            </button>
            <button onClick={() => setShowChangelog(true)} className="text-[10px] text-[#64748b] hover:text-[#94a3b8] transition-colors">Novidades</button>
            <button onClick={() => setShowSources(!showSources)} className="text-[10px] text-[#64748b] hover:text-[#94a3b8] transition-colors">Fontes</button>
            <a href="mailto:contato@crimebrasil.com.br" className="text-[10px] text-[#64748b] hover:text-[#94a3b8] transition-colors">Contato</a>
            <a href="https://linkedin.com/in/israel-l-b00800116" target="_blank" rel="noopener noreferrer" className="text-[10px] text-[#a78bfa] hover:text-[#c4b5fd] transition-colors">Designed by I.L.S.</a>
          </div>
          <div className="absolute bottom-2 left-2 md:bottom-4 md:left-4 bg-[#111827]/90 backdrop-blur-xl border border-[#1e293b] rounded-xl md:rounded-2xl p-2 md:p-4 z-[1000] flex gap-3 md:gap-6 max-w-[calc(100vw-4rem)]">
            {initialLoading ? (
              <>
                <div><div className="h-8 w-20 bg-[#1e293b] rounded animate-pulse mb-1" /><div className="h-3 w-16 bg-[#1e293b] rounded animate-pulse" /></div>
                <div><div className="h-8 w-14 bg-[#1e293b] rounded animate-pulse mb-1" /><div className="h-3 w-16 bg-[#1e293b] rounded animate-pulse" /></div>
              </>
            ) : (
              <>
                {stats && <div><p className="text-base sm:text-lg md:text-2xl font-bold font-mono text-red-400">{stats.total_crimes?.toLocaleString()}</p><p className="text-[8px] md:text-[10px] text-[#94a3b8] uppercase tracking-wider">Ocorrências</p></div>}
                <div><p className="text-base sm:text-lg md:text-2xl font-bold font-mono text-amber-400">{systemInfo?.total_municipios ?? '—'}</p><p className="text-[8px] md:text-[10px] text-[#94a3b8] uppercase tracking-wider">Municípios</p><p className="text-[7px] md:text-[8px] text-[#64748b]">no sistema</p></div>
                <div><p className="text-base sm:text-lg md:text-2xl font-bold font-mono text-blue-400">{systemInfo ? `${systemInfo.period_start_year}–${systemInfo.period_end_year}` : '—'}</p><p className="text-[8px] md:text-[10px] text-[#94a3b8] uppercase tracking-wider">Dados disponíveis</p></div>
              </>
            )}
          </div>
          {detailPanels.map((panel, idx) => (
            <DetailPanel
              key={panel.id}
              data={panel}
              rateMode={rateMode}
              onClose={() => setDetailPanels(prev => prev.filter(p => p.id !== panel.id))}
              stackIndex={idx}
              onFocus={() => setDetailPanels(prev => {
                const panelToFocus = prev.find(p => p.id === panel.id);
                if (!panelToFocus) return prev;
                return [...prev.filter(p => p.id !== panel.id), panelToFocus];
              })}
            />
          ))}
        </main></div>
      {showMgWarning && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={cancelMgWarning}>
          <div className="bg-[#111827] border border-amber-500/40 rounded-2xl p-6 w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold mb-3 text-amber-400">Dados parciais</h2>
            <p className="text-sm text-[#94a3b8] mb-4">
              MG reporta apenas crimes violentos (homicídios, roubos, estupros). Para comparação justa, os outros estados selecionados serão filtrados automaticamente para mostrar apenas crimes violentos.
            </p>
            <p className="text-sm text-[#94a3b8] mb-4">
              Para ver todos os crimes dos outros estados, desmarque MG.
            </p>
            <div className="flex gap-2">
              <button onClick={cancelMgWarning} className="flex-1 px-4 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm hover:bg-[#1e293b]">Cancelar</button>
              <button onClick={confirmMgWarning} className="flex-1 px-4 py-2 rounded-xl bg-amber-600 text-white text-sm hover:bg-amber-700">Confirmar</button>
            </div>
          </div>
        </div>
      )}
      {showBugReport && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowBugReport(false)}>
          <div className="bg-[#111827] border border-[#1e293b] rounded-2xl p-6 w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
            {bugSuccess ? (
              <div className="text-center py-8">
                <p className="text-lg font-bold text-green-400 mb-2">Bug reportado com sucesso!</p>
                <p className="text-sm text-[#94a3b8]">Obrigado pelo feedback.</p>
                <button onClick={() => setShowBugReport(false)} className="mt-4 px-4 py-2 bg-[#3b82f6] rounded-xl text-sm text-white hover:bg-[#2563eb]">Fechar</button>
              </div>
            ) : (
              <>
                <h2 className="text-lg font-bold mb-4">Reportar Bug</h2>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs uppercase tracking-wider text-[#94a3b8] block mb-1">Descrição *</label>
                    <textarea value={bugDesc} onChange={e => setBugDesc(e.target.value)} rows={4} className="w-full bg-[#1a2234] border border-[#1e293b] rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-[#3b82f6]" placeholder="Descreva o problema encontrado..." />
                  </div>
                  <div>
                    <label className="text-xs uppercase tracking-wider text-[#94a3b8] block mb-1">Email (opcional)</label>
                    <input type="email" value={bugEmail} onChange={e => setBugEmail(e.target.value)} className="w-full bg-[#1a2234] border border-[#1e293b] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#3b82f6]" placeholder="seu@email.com" />
                  </div>
                  <div>
                    <label className="text-xs uppercase tracking-wider text-[#94a3b8] block mb-1">Screenshot (opcional)</label>
                    <input type="file" accept="image/*" onChange={handleImageUpload} className="w-full text-sm text-[#94a3b8] file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-sm file:bg-[#1a2234] file:text-[#94a3b8] hover:file:bg-[#1e293b]" />
                  </div>
                  <div>
                    <label className="text-xs uppercase tracking-wider text-[#94a3b8] block mb-1">Verificação</label>
                    <div id="hcaptcha-widget" />
                  </div>
                  {bugError && <p className="text-sm text-red-400">{bugError}</p>}
                  <div className="flex gap-2 pt-2">
                    <button onClick={() => setShowBugReport(false)} className="flex-1 px-4 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm hover:bg-[#1e293b]">Cancelar</button>
                    <button onClick={handleBugSubmit} disabled={bugSubmitting} className="flex-1 px-4 py-2 rounded-xl bg-[#3b82f6] text-white text-sm hover:bg-[#2563eb] disabled:opacity-50">{bugSubmitting ? 'Enviando...' : 'Enviar'}</button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {showChangelog && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowChangelog(false)}>
          <div className="bg-[#111827] border border-[#1e293b] rounded-2xl p-6 w-full max-w-lg max-h-[80vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">Novidades</h2>
              <button onClick={() => setShowChangelog(false)} className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-[#1a2234] border border-[#1e293b] text-[#94a3b8] text-sm" aria-label="Fechar">✕</button>
            </div>
            {CHANGELOG.map((entry, i) => (
              <div key={i} className="mb-4 last:mb-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-[#3b82f6]">{entry.date}</span>
                  <span className="text-sm font-semibold text-[#f1f5f9]">{entry.title}</span>
                </div>
                <ul className="space-y-1 ml-4">
                  {entry.items.map((item, j) => (
                    <li key={j} className="text-sm text-[#94a3b8] before:content-['•'] before:mr-2 before:text-[#475569]">{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
      {showSources && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowSources(false)}>
          <div className="bg-[#111827] border border-[#1e293b] rounded-2xl p-6 w-full max-w-lg max-h-[80vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">Fontes de Dados</h2>
              <button onClick={() => setShowSources(false)} className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-[#1a2234] border border-[#1e293b] text-[#94a3b8] text-sm" aria-label="Fechar">✕</button>
            </div>
            {(dataSourcesApi || DATA_SOURCES).map((s: any) => (
              <div key={s.id || s.state} className="mb-4 last:mb-0">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    s.quality === 'full' ? 'bg-green-500' :
                    s.quality === 'partial' ? 'bg-amber-500' : 'bg-gray-500'
                  }`} />
                  <span className="text-sm text-[#f1f5f9] font-medium">{s.name}</span>
                </div>
                {s.description && (
                  <p className="text-xs text-[#64748b] ml-4 mt-1">{s.description}</p>
                )}
                <div className="flex items-center gap-3 ml-4 mt-1">
                  {s.record_count != null && (
                    <span className="text-xs text-[#64748b]">
                      {s.record_count.toLocaleString()} registros
                    </span>
                  )}
                  {s.last_updated && (
                    <span className="text-xs text-[#64748b]">
                      Atualizado: {new Date(s.last_updated).toLocaleDateString('pt-BR')}
                    </span>
                  )}
                </div>
                {s.caveat && (
                  <p className="text-xs text-amber-400 ml-4 mt-1">⚠ {s.caveat}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {showHelp && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowHelp(false)}>
          <div className="bg-[#111827] border border-[#1e293b] rounded-2xl p-6 w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">Como usar o Crime Brasil</h2>
              <button onClick={() => setShowHelp(false)} className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-[#1a2234] border border-[#1e293b] text-[#94a3b8] text-sm" aria-label="Fechar">✕</button>
            </div>

            <section className="mb-5">
              <h3 className="text-sm font-bold text-[#3b82f6] uppercase tracking-wider mb-2">Navegando o Mapa</h3>
              <p className="text-sm text-[#94a3b8] mb-2">O mapa possui três níveis de zoom que mudam automaticamente o que é exibido:</p>
              <ul className="space-y-1 ml-4 text-sm text-[#94a3b8]">
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]"><strong>Estados</strong> — visão geral do Brasil (zoom afastado)</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]"><strong>Municípios</strong> — detalhamento por cidade (zoom médio)</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]"><strong>Bairros</strong> — detalhamento por bairro para RS, RJ e MG (zoom aproximado)</li>
              </ul>
              <p className="text-sm text-[#94a3b8] mt-2">Clique em qualquer região ou ponto para abrir um painel de detalhes flutuante com o total de ocorrências e a distribuição por tipo de crime. Use a barra de busca para encontrar uma cidade ou bairro específico.</p>
            </section>

            <section className="mb-5">
              <h3 className="text-sm font-bold text-[#3b82f6] uppercase tracking-wider mb-2">Cores e Escala</h3>
              <div className="flex flex-wrap gap-3 mb-2">
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-[#16a34a]" /><span className="text-sm text-[#94a3b8]">Baixo</span></div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-[#eab308]" /><span className="text-sm text-[#94a3b8]">Médio</span></div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-[#f97316]" /><span className="text-sm text-[#94a3b8]">Alto</span></div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-[#ef4444]" /><span className="text-sm text-[#94a3b8]">Crítico</span></div>
              </div>
              <p className="text-sm text-[#94a3b8]">No modo <strong>/100K hab.</strong>, as cores usam faixas fixas de taxa. No modo <strong>Total</strong>, as cores são relativas (comparando regiões visíveis entre si).</p>
            </section>

            <section className="mb-5">
              <h3 className="text-sm font-bold text-[#3b82f6] uppercase tracking-wider mb-2">Modos de Visualização</h3>
              <ul className="space-y-1 ml-4 text-sm text-[#94a3b8]">
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]"><strong>Pontos vs Regiões:</strong> pontos mostram círculos individuais; regiões colorem áreas inteiras no mapa</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]"><strong>/100K hab. vs Total:</strong> taxa per capita (comparação justa entre regiões de tamanhos diferentes) vs contagem absoluta</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]"><strong>Auto/Municípios/Bairros:</strong> force um nível específico de agregação em vez do automático por zoom</li>
              </ul>
            </section>

            <section className="mb-5">
              <h3 className="text-sm font-bold text-[#3b82f6] uppercase tracking-wider mb-2">Modo Comparação</h3>
              <p className="text-sm text-[#94a3b8] mb-2">Ative o <strong>Modo Comparação</strong> no painel de filtros e clique em dois locais (estados, cidades ou bairros) para ver os dados lado a lado:</p>
              <ul className="space-y-1 ml-4 text-sm text-[#94a3b8]">
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Exibe total de ocorrências, população e taxa /100K hab. de cada local</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">No modo <strong>/100K</strong>, o "Total /100K" substitui o total absoluto para facilitar a comparação</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Ao comparar MG com outro estado, um aviso indica que os dados de MG são parciais e que o filtro de compatibilidade foi aplicado</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">O painel pode ser arrastado e redimensionado</li>
              </ul>
            </section>

            <section className="mb-5">
              <h3 className="text-sm font-bold text-[#3b82f6] uppercase tracking-wider mb-2">Fontes de Dados</h3>
              <p className="text-sm text-[#94a3b8] mb-2">Os dados vêm de múltiplas fontes com diferentes níveis de qualidade:</p>
              <div className="space-y-2 ml-4">
                <div className="flex items-start gap-2"><div className="w-2 h-2 rounded-full bg-green-500 mt-1.5 flex-shrink-0" /><span className="text-sm text-[#94a3b8]"><strong>Completo</strong> (RS, RJ) — registros individuais com dados demográficos da vítima, bairro e geolocalização</span></div>
                <div className="flex items-start gap-2"><div className="w-2 h-2 rounded-full bg-amber-500 mt-1.5 flex-shrink-0" /><span className="text-sm text-[#94a3b8]"><strong>Parcial</strong> (MG) — apenas crimes violentos; crimes patrimoniais e drogas não disponíveis</span></div>
                <div className="flex items-start gap-2"><div className="w-2 h-2 rounded-full bg-gray-500 mt-1.5 flex-shrink-0" /><span className="text-sm text-[#94a3b8]"><strong>Básico</strong> (demais estados) — dados agregados do SINESP/Ministério da Justiça, 15 tipos de crime</span></div>
              </div>
              <p className="text-sm text-[#94a3b8] mt-2">Os dados são atualizados automaticamente toda semana. Clique em "Fontes" para ver detalhes de cada fonte.</p>
            </section>

            <section className="mb-5">
              <h3 className="text-sm font-bold text-[#3b82f6] uppercase tracking-wider mb-2">Filtros</h3>
              <p className="text-sm text-[#94a3b8] mb-2">Os filtros são <strong>em cascata</strong>: ao selecionar um tipo de crime, as opções disponíveis nos outros filtros se atualizam automaticamente.</p>
              <ul className="space-y-1 ml-4 text-sm text-[#94a3b8]">
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Filtros de sexo, cor e idade da vítima só têm dados detalhados para RS e RJ</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Selecionar MG junto com outros estados ativa filtro automático de compatibilidade</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Dados do SINESP são anuais — filtro por semestre fica desabilitado para estados com apenas dados SINESP</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Clique diretamente nos estados no mapa para selecioná-los rapidamente</li>
              </ul>
            </section>

            <section>
              <h3 className="text-sm font-bold text-amber-400 uppercase tracking-wider mb-2">Limitações</h3>
              <ul className="space-y-1 ml-4 text-sm text-[#94a3b8]">
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Dados por bairro disponíveis apenas para RS, RJ e MG</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">MG reporta apenas crimes violentos — não há dados de crimes patrimoniais ou drogas</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Dados do SINESP são anuais — não é possível filtrar por semestre para demais estados</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">A frequência de atualização varia: RS/SP verificados semanalmente; os órgãos de origem publicam em cadências diferentes</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Alguns municípios podem ter geolocalização imprecisa</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Dados populacionais são estimativas do IBGE — taxas per capita são aproximadas</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Critérios de registro de crimes variam entre estados — comparações diretas devem ser feitas com cautela</li>
              </ul>
            </section>
          </div>
        </div>
      )}
    </div>);
}
