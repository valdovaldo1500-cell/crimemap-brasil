'use client';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { fetchStats, fetchCrimeTypes, fetchSemesters, fetchAutocomplete, fetchSexoValues, fetchCorValues, fetchGrupoValues, fetchFilterOptions, fetchCaptcha, submitBugReport, fetchAvailableStates, fetchStateFilterInfo, fetchLocationStats, fetchStateStats } from '@/lib/api';
import { calcRate, formatRate } from '@/lib/rates';
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
  const [selectedPeriod, setSelectedPeriod] = useState<'ano' | 'S1' | 'S2'>('ano');
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [center, setCenter] = useState<[number,number]>([-14.24,-51.93]);
  const [zoom, setZoom] = useState(4);
  const [showFilters, setShowFilters] = useState(false);
  const [filterLoading, setFilterLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'dots' | 'choropleth'>('choropleth');
  const [rateMode, setRateMode] = useState<'rate' | 'absolute'>('rate');
  const [aggregationOverride, setAggregationOverride] = useState<'auto'|'estados'|'municipios'|'bairros'>('auto');
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>|null>(null);

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
  const [captcha, setCaptcha] = useState<any>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');
  const [bugSubmitting, setBugSubmitting] = useState(false);
  const [bugSuccess, setBugSuccess] = useState(false);
  const [bugError, setBugError] = useState('');
  const [crimeTypeSearch, setCrimeTypeSearch] = useState('');
  const [showMobileMenu, setShowMobileMenu] = useState(false);

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

  const CHANGELOG = [
    {
      date: '2026-03-06',
      title: 'Comparação e visualização',
      items: [
        'Modo comparação entre estados, cidades e bairros',
        'Dados de RS, RJ e MG com filtro automático de compatibilidade',
        'Visualização por bairros para RS, RJ e MG',
      ],
    },
    {
      date: '2026-03-01',
      title: 'Multi-estado e filtros',
      items: [
        'Taxa por 100 mil habitantes e modo regiões (coropleto)',
        'Filtros por tipo de crime, grupo, sexo, cor e idade',
        'Busca por cidade ou bairro com autocomplete',
      ],
    },
    {
      date: '2026-02-01',
      title: 'Lançamento',
      items: [
        'Mapa de crimes com dados oficiais',
        'Visualização por município e bairro',
        'Filtros por tipo de crime e período',
      ],
    },
  ];

  const [initialLoading, setInitialLoading] = useState(true);
  useEffect(() => {
    Promise.all([
      fetchStats().then(setStats),
      fetchSemesters().then((s: string[]) => { setSemesters(s); if (s.length > 0) { setSelectedYear(s[0].split('-')[0]); setSelectedPeriod('ano'); } }),
      fetchFilterOptions({}).then((opts: any) => {
        const VALID_GRUPOS = ['CRIMES', 'CONTRAVENCOES'];
        setCrimeTypes((opts.tipo || []).map((t: any) => ({ tipo_enquadramento: t.value, count: t.count })));
        setGrupoValues((opts.grupo || []).filter((g: any) => VALID_GRUPOS.includes(g.value)));
        setSexoValues(opts.sexo || []);
        setCorValues(opts.cor || []);
      }),
      fetchAvailableStates().then(setAvailableStates).catch(() => {}),
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
      if (selectedPeriod !== 'ano') params.semestre = `${selectedYear}-${selectedPeriod}`;
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
    if (val.trim().length < 3) { setSuggestions([]); setShowSuggestions(false); return; }
    debounceRef.current = setTimeout(async () => {
      const results = await fetchAutocomplete(val.trim());
      setSuggestions(results);
      setShowSuggestions(results.length > 0);
    }, 250);
  };

  const onSelect = (item: any) => {
    setCenter([item.latitude, item.longitude]);
    setZoom(item.type === 'bairro' ? 14 : 12);
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
    setSelectedPeriod('ano');
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
    if (maxGranularity === 'yearly' && selectedPeriod !== 'ano') {
      setSelectedPeriod('ano');
    }
  }, [maxGranularity, selectedPeriod]);

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
    semestre: selectedPeriod !== 'ano' ? `${selectedYear}-${selectedPeriod}` : undefined,
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

  const activeFilterCount = selectedTypes.length + selectedGrupo.length + selectedSexo.length + selectedCor.length + (idadeMin ? 1 : 0) + (idadeMax ? 1 : 0);

  const municResults = suggestions.filter(s => s.type === 'municipio');
  const bairroResults = suggestions.filter(s => s.type === 'bairro');

  const openBugReport = async () => {
    setShowBugReport(true);
    setBugSuccess(false);
    setBugError('');
    setBugDesc('');
    setBugEmail('');
    setBugImage('');
    setCaptchaAnswer('');
    try { setCaptcha(await fetchCaptcha()); } catch { /* ignore */ }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setBugImage(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleBugSubmit = async () => {
    if (!bugDesc.trim()) { setBugError('Descrição é obrigatória'); return; }
    if (!captchaAnswer.trim()) { setBugError('Responda o captcha'); return; }
    setBugSubmitting(true);
    setBugError('');
    try {
      await submitBugReport({
        description: bugDesc,
        email: bugEmail || undefined,
        image: bugImage || undefined,
        captcha_token: captcha?.token || '',
        captcha_answer: captchaAnswer,
      });
      setBugSuccess(true);
    } catch (err: any) {
      setBugError(err.message || 'Erro ao enviar');
      try { setCaptcha(await fetchCaptcha()); } catch { /* ignore */ }
      setCaptchaAnswer('');
    } finally {
      setBugSubmitting(false);
    }
  };

  return (
    <div className="h-screen overflow-hidden bg-[#0a0f1a]">
      <header className="border-b border-[#1e293b] bg-[#111827]/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-[1800px] mx-auto px-4 py-2 md:py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 md:gap-3 shrink-0">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-500 to-amber-500 flex items-center justify-center text-white font-bold text-xs">BR</div>
            <div className="hidden sm:block"><h1 className="text-lg font-bold">Crime Brasil</h1><p className="text-[10px] text-[#94a3b8] uppercase tracking-widest">crimebrasil.com.br</p></div>
          </div>
          <div className="flex-1 max-w-md mx-2 md:mx-8 relative" ref={searchRef}>
            <input
              value={searchQ}
              onChange={e => onSearchChange(e.target.value)}
              onFocus={() => { setSearchFocused(true); if (suggestions.length > 0) setShowSuggestions(true); }}
              onBlur={() => { setSearchFocused(false); setTimeout(() => setShowSuggestions(false), 200); }}
              placeholder="Buscar cidade ou bairro..."
              className="w-full bg-[#1a2234] border border-[#1e293b] rounded-xl px-4 py-2.5 text-sm text-[#f1f5f9] placeholder-[#475569] focus:outline-none focus:border-[#3b82f6]"
            />
            {searchFocused && searchQ.trim().length < 3 && !showSuggestions && (
              <div className="absolute top-full mt-1 w-full bg-[#1a2234] border border-[#1e293b] rounded-xl overflow-hidden shadow-2xl z-[60] px-4 py-3">
                <span className="text-sm text-[#475569]">Comece a escrever para sugestões...</span>
              </div>
            )}
            {showSuggestions && (
              <div className="absolute top-full mt-1 w-full bg-[#1a2234] border border-[#1e293b] rounded-xl overflow-hidden shadow-2xl z-[60] max-h-80 overflow-y-auto">
                {municResults.length > 0 && (
                  <>
                    <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-[#94a3b8] bg-[#111827]">Cidades</div>
                    {municResults.map((r, i) => (
                      <button key={'m'+i} onMouseDown={() => onSelect(r)} className="w-full px-4 py-2 text-left text-sm hover:bg-[#111827] flex justify-between items-center">
                        <span>{r.name}</span>
                        <span className="text-[10px] text-[#94a3b8] font-mono">{formatCount(r.count)}</span>
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
                        <span className="text-[10px] text-[#94a3b8] font-mono">{formatCount(r.count)}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
          <div className="hidden md:flex items-center gap-2">
            {years.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="flex rounded-xl border border-[#1e293b] overflow-hidden">
                  {years.map(yr => (
                    <button key={yr} onClick={() => onSelectYear(yr)}
                      className={`px-3 py-1.5 text-sm ${selectedYear === yr ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>
                      {yr}
                    </button>
                  ))}
                </div>
                <div className="flex rounded-xl border border-[#1e293b] overflow-hidden">
                  <button onClick={() => setSelectedPeriod('ano')}
                    className={`px-2.5 py-1 text-xs ${selectedPeriod === 'ano' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>
                    Ano
                  </button>
                  {availablePeriods.includes('S1') && (
                    <button onClick={() => maxGranularity === 'monthly' && setSelectedPeriod('S1')}
                      title={maxGranularity === 'yearly' ? 'Filtro por semestre indisponível — dados do SINESP são anuais' : ''}
                      className={`px-2.5 py-1 text-xs ${selectedPeriod === 'S1' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'} ${maxGranularity === 'yearly' ? 'opacity-40 cursor-not-allowed' : ''}`}>
                      Jan-Jun
                    </button>
                  )}
                  {availablePeriods.includes('S2') && (
                    <button onClick={() => maxGranularity === 'monthly' && setSelectedPeriod('S2')}
                      title={maxGranularity === 'yearly' ? 'Filtro por semestre indisponível — dados do SINESP são anuais' : ''}
                      className={`px-2.5 py-1 text-xs ${selectedPeriod === 'S2' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'} ${maxGranularity === 'yearly' ? 'opacity-40 cursor-not-allowed' : ''}`}>
                      Jul-Dez
                    </button>
                  )}
                </div>
              </div>
            )}
            {/* Fix #13: aria-label on view toggle buttons */}
            <div className="flex rounded-xl border border-[#1e293b] overflow-hidden" role="group" aria-label="Modo de visualização">
              <button onClick={()=>setViewMode('dots')} aria-label="Visualização em pontos" className={`px-3 py-2.5 text-sm ${viewMode==='dots'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>Pontos</button>
              <button onClick={()=>setViewMode('choropleth')} aria-label="Visualização em regiões" className={`px-3 py-2.5 text-sm ${viewMode==='choropleth'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>Regiões</button>
            </div>
            <button
              onClick={() => { const entering = !compareMode; setCompareMode(entering); if (entering) setSelectedStates([]); setComparisonLocations([]); setComparisonStats([]); }}
              aria-label={compareMode ? 'Desativar comparação' : 'Ativar comparação'}
              className={`px-3 py-2.5 rounded-xl border text-sm ${compareMode ? 'bg-[#7c3aed] text-white border-[#7c3aed]' : 'bg-[#1a2234] border-[#1e293b] text-[#94a3b8] hover:bg-[#1e293b] hover:text-[#f1f5f9]'}`}
            >Comparar</button>
            <div className="flex rounded-xl border border-[#1e293b] overflow-hidden" role="group" aria-label="Modo de taxa">
              <button onClick={()=>setRateMode('rate')} aria-label="Taxa por 100 mil habitantes" className={`px-3 py-2.5 text-sm ${rateMode==='rate'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>/100K hab.</button>
              <button onClick={()=>setRateMode('absolute')} aria-label="Total absoluto" className={`px-3 py-2.5 text-sm ${rateMode==='absolute'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>Total</button>
            </div>
            <div className="flex rounded-xl border border-[#1e293b] overflow-hidden" role="group" aria-label="Nível de agregação">
              {(['auto','estados','municipios','bairros'] as const).map(v=>(
                <button key={v} onClick={()=>setAggregationOverride(v)}
                  aria-label={v==='auto'?'Agregação automática':v==='estados'?'Estados':v==='municipios'?'Municípios':'Bairros'}
                  className={`px-2.5 py-2.5 text-xs ${aggregationOverride===v?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>
                  {v==='auto'?'Auto':v==='estados'?'Estados':v==='municipios'?'Municípios':'Bairros'}
                </button>
              ))}
            </div>
            <button onClick={()=>setShowFilters(!showFilters)} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm hover:bg-[#1e293b]">Filtros{activeFilterCount>0&&<span className="bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">{activeFilterCount}</span>}</button>
          </div>
          {/* Fix #13: aria-label on hamburger button */}
          <button
            className="md:hidden p-2 rounded-lg bg-[#1a2234] border border-[#1e293b]"
            onClick={() => setShowMobileMenu(!showMobileMenu)}
            aria-label="Abrir menu de navegação"
          >
            <svg className="w-5 h-5 text-[#94a3b8]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
        </div>
        {showMobileMenu && (
          <div className="md:hidden border-t border-[#1e293b] p-3 space-y-3 bg-[#111827]">
            {years.length > 0 && (
              <div className="space-y-2">
                <span className="text-[10px] text-[#94a3b8] uppercase tracking-wider">Ano</span>
                <div className="flex flex-wrap gap-1">
                  {years.map(yr => (
                    <button key={yr} onClick={() => { onSelectYear(yr); }} className={`px-3 py-1.5 text-sm rounded-lg ${selectedYear === yr ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8]'}`}>{yr}</button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1">
                  <button onClick={() => setSelectedPeriod('ano')} className={`px-2.5 py-1 text-xs rounded-lg ${selectedPeriod === 'ano' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8]'}`}>Ano</button>
                  {availablePeriods.includes('S1') && <button onClick={() => setSelectedPeriod('S1')} className={`px-2.5 py-1 text-xs rounded-lg ${selectedPeriod === 'S1' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8]'}`}>Jan-Jun</button>}
                  {availablePeriods.includes('S2') && <button onClick={() => setSelectedPeriod('S2')} className={`px-2.5 py-1 text-xs rounded-lg ${selectedPeriod === 'S2' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8]'}`}>Jul-Dez</button>}
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <div className="flex rounded-xl border border-[#1e293b] overflow-hidden">
                <button onClick={()=>setViewMode('dots')} className={`px-3 py-2 text-sm ${viewMode==='dots'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8]'}`}>Pontos</button>
                <button onClick={()=>setViewMode('choropleth')} className={`px-3 py-2 text-sm ${viewMode==='choropleth'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8]'}`}>Regiões</button>
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
              <button onClick={()=>{const entering=!compareMode;setCompareMode(entering);if(entering)setSelectedStates([]);setComparisonLocations([]);setComparisonStats([]);setShowMobileMenu(false);}} className={`px-3 py-2 rounded-xl border text-sm ${compareMode ? 'bg-[#7c3aed] text-white border-[#7c3aed]' : 'bg-[#1a2234] border-[#1e293b] text-[#94a3b8]'}`}>Comparar</button>
              <button onClick={()=>{openBugReport();setShowMobileMenu(false);}} className="px-3 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm text-[#94a3b8]">Bug</button>
              <button onClick={()=>{setShowHelp(true);setShowMobileMenu(false);}} className="px-3 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm text-[#94a3b8]">Como usar</button>
              <button onClick={()=>{setShowChangelog(true);setShowMobileMenu(false);}} className="px-3 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm text-[#94a3b8]">Novidades</button>
              <button onClick={()=>{setShowSources(!showSources);setShowMobileMenu(false);}} className="px-3 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm text-[#94a3b8]">Fontes</button>
              <a href="mailto:contato@crimebrasil.com.br" className="px-3 py-2 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm text-[#94a3b8]">Contato</a>
            </div>
          </div>
        )}
        </header>
      <div className="flex h-[calc(100vh-56px)] md:h-[calc(100vh-80px)]">
        {/* Fix #11: backdrop overlay that closes sidebar on mobile click */}
        {showFilters && (
          <div
            className="fixed inset-0 z-40 md:hidden bg-black/40"
            aria-hidden="true"
            onClick={() => setShowFilters(false)}
          />
        )}
        {showFilters&&(
          /* Fix #13: role="region" and aria-label on sidebar */
          <aside
            className="fixed inset-y-0 left-0 z-50 w-80 md:relative md:inset-auto md:z-0 md:w-80 border-r border-[#1e293b] bg-[#111827] overflow-y-auto p-4 space-y-4"
            role="region"
            aria-label="Filtros"
            onClick={e => e.stopPropagation()}
          >
          <div className="flex justify-between items-center md:hidden mb-3">
            <h2 className="text-base font-bold">Filtros</h2>
            {/* Fix #12: min touch target on close button */}
            <button onClick={() => setShowFilters(false)} className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-[#1a2234] border border-[#1e293b] text-[#94a3b8] text-sm" aria-label="Fechar filtros">✕</button>
          </div>
          <div className={filterLoading ? 'opacity-50 pointer-events-none transition-opacity' : 'transition-opacity'}>
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
          <CrimeMap center={center} zoom={zoom} filters={filters} viewMode={viewMode} rateMode={rateMode} aggregationOverride={aggregationOverride} selectedStates={selectedStates} onToggleState={toggleState} activeFilter={activeFilter} maxGranularity={maxGranularity} availableStates={availableStates} compareMode={compareMode} comparisonLocations={comparisonLocations} onCompareSelect={onCompareSelect} />
          {/* Comparison mode panel */}
          {compareMode && (
            <div className="absolute top-4 right-14 z-[1001] w-80">
              <div className="bg-[#111827]/95 backdrop-blur-xl border border-[#7c3aed]/40 rounded-xl p-3 shadow-2xl">
                <div className="flex justify-between items-center mb-2">
                  <h3 className="text-xs uppercase tracking-wider text-[#7c3aed] font-semibold">Comparar locais</h3>
                  {comparisonLocations.length > 0 && (
                    <button onClick={clearComparison} className="text-[10px] text-[#94a3b8] hover:text-[#f1f5f9]">Limpar</button>
                  )}
                </div>
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
                        <div className="grid grid-cols-3 gap-1 text-xs border-t border-[#1e293b] pt-1">
                          <div className="text-[#94a3b8]">Total</div>
                          <div className="text-center font-mono">{comparisonStats[0].total?.toLocaleString() || 0}</div>
                          <div className="text-center font-mono">{comparisonStats[1].total?.toLocaleString() || 0}</div>
                        </div>
                        {comparisonStats[0].population && comparisonStats[1].population && (
                          <div className="grid grid-cols-3 gap-1 text-xs">
                            <div className="text-[#94a3b8]">/100K</div>
                            <div className="text-center font-mono">{((comparisonStats[0].total / comparisonStats[0].population) * 100000).toFixed(1)}</div>
                            <div className="text-center font-mono">{((comparisonStats[1].total / comparisonStats[1].population) * 100000).toFixed(1)}</div>
                          </div>
                        )}
                        <div className="grid grid-cols-3 gap-1 text-xs">
                          <div className="text-[#94a3b8]">Diferença</div>
                          {(() => {
                            const a = comparisonStats[0].total || 0;
                            const b = comparisonStats[1].total || 0;
                            if (a === 0 && b === 0) return <><div className="text-center font-mono">—</div><div className="text-center font-mono">—</div></>;
                            const diffA = b > 0 ? ((a - b) / b) * 100 : (a > 0 ? 100 : 0);
                            const diffB = a > 0 ? ((b - a) / a) * 100 : (b > 0 ? 100 : 0);
                            return <>
                              <div className={`text-center font-mono ${a > b ? 'text-red-400' : a < b ? 'text-green-400' : ''}`}>
                                {a > b ? `+${diffA.toFixed(0)}%` : a < b ? `${diffA.toFixed(0)}%` : '='}
                              </div>
                              <div className={`text-center font-mono ${b > a ? 'text-red-400' : b < a ? 'text-green-400' : ''}`}>
                                {b > a ? `+${diffB.toFixed(0)}%` : b < a ? `${diffB.toFixed(0)}%` : '='}
                              </div>
                            </>;
                          })()}
                        </div>
                        {/* Crime type breakdown comparison */}
                        {(() => {
                          // Use canonical categories for cross-state comparison
                          const useCats = comparisonStats.every((s: any) => s.crime_categories?.length > 0);
                          if (useCats) {
                            const allCats = new Set<string>();
                            comparisonStats.forEach((s: any) => (s.crime_categories || []).forEach((cc: any) => allCats.add(cc.category)));
                            const catArr = Array.from(allCats).slice(0, 8);
                            const getCatCount = (stats: any, cat: string) => {
                              const cc = (stats.crime_categories || []).find((c: any) => c.category === cat);
                              return cc ? cc.count : 0;
                            };
                            return catArr.map(cat => {
                              const c0 = getCatCount(comparisonStats[0], cat);
                              const c1 = getCatCount(comparisonStats[1], cat);
                              const diff = c0 > 0 ? (((c1 - c0) / c0) * 100) : 0;
                              return (
                                <div key={cat} className="grid grid-cols-3 gap-1 text-[10px]">
                                  <div className="text-[#94a3b8] truncate" title={cat}>{cat}</div>
                                  <div className="text-center font-mono">{c0.toLocaleString()}</div>
                                  <div className="text-center font-mono">
                                    {c1.toLocaleString()}
                                    {c0 > 0 && <span className={`ml-1 ${diff > 0 ? 'text-red-400' : diff < 0 ? 'text-green-400' : 'text-[#94a3b8]'}`}>
                                      {diff > 0 ? '+' : ''}{diff.toFixed(0)}%
                                    </span>}
                                  </div>
                                </div>
                              );
                            });
                          }
                          // Fallback to raw crime types (same-state comparison)
                          const allTypes = new Set<string>();
                          comparisonStats.forEach(s => (s.crime_types || []).forEach((ct: any) => allTypes.add(ct.tipo_enquadramento)));
                          const typeArr = Array.from(allTypes).slice(0, 8);
                          const getCount = (stats: any, tipo: string) => {
                            const ct = (stats.crime_types || []).find((c: any) => c.tipo_enquadramento === tipo);
                            return ct ? ct.count : 0;
                          };
                          return typeArr.map(tipo => {
                            const c0 = getCount(comparisonStats[0], tipo);
                            const c1 = getCount(comparisonStats[1], tipo);
                            const diff = c0 > 0 ? (((c1 - c0) / c0) * 100) : 0;
                            return (
                              <div key={tipo} className="grid grid-cols-3 gap-1 text-[10px]">
                                <div className="text-[#94a3b8] truncate" title={prettifyCrimeType(tipo)}>{prettifyCrimeType(tipo)}</div>
                                <div className="text-center font-mono">{c0.toLocaleString()}</div>
                                <div className="text-center font-mono">
                                  {c1.toLocaleString()}
                                  {c0 > 0 && <span className={`ml-1 ${diff > 0 ? 'text-red-400' : diff < 0 ? 'text-green-400' : 'text-[#94a3b8]'}`}>
                                    {diff > 0 ? '+' : ''}{diff.toFixed(0)}%
                                  </span>}
                                </div>
                              </div>
                            );
                          });
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
              </div>
            </div>
          )}
          {/* Bottom-right utility links */}
          <div className="absolute bottom-12 right-4 z-[1000] hidden md:flex items-center gap-3">
            <button onClick={openBugReport} className="text-[10px] text-[#64748b] hover:text-[#94a3b8] transition-colors">Reportar Bug</button>
            <button onClick={() => setShowHelp(true)} className="text-[10px] text-[#64748b] hover:text-[#94a3b8] transition-colors">Como usar</button>
            <button onClick={() => setShowChangelog(true)} className="text-[10px] text-[#64748b] hover:text-[#94a3b8] transition-colors">Novidades</button>
            <button onClick={() => setShowSources(!showSources)} className="text-[10px] text-[#64748b] hover:text-[#94a3b8] transition-colors">Fontes</button>
            <a href="mailto:contato@crimebrasil.com.br" className="text-[10px] text-[#64748b] hover:text-[#94a3b8] transition-colors">Contato</a>
          </div>
          <div className="absolute bottom-2 left-2 md:bottom-4 md:left-4 bg-[#111827]/90 backdrop-blur-xl border border-[#1e293b] rounded-xl md:rounded-2xl p-2 md:p-4 z-[1000] flex gap-3 md:gap-6">
            {initialLoading ? (
              <>
                <div><div className="h-8 w-20 bg-[#1e293b] rounded animate-pulse mb-1" /><div className="h-3 w-16 bg-[#1e293b] rounded animate-pulse" /></div>
                <div><div className="h-8 w-14 bg-[#1e293b] rounded animate-pulse mb-1" /><div className="h-3 w-16 bg-[#1e293b] rounded animate-pulse" /></div>
              </>
            ) : stats && (
              <>
                <div><p className="text-lg md:text-2xl font-bold font-mono text-red-400">{stats.total_crimes?.toLocaleString()}</p><p className="text-[8px] md:text-[10px] text-[#94a3b8] uppercase tracking-wider">Ocorrências</p></div>
                <div><p className="text-lg md:text-2xl font-bold font-mono text-amber-400">{stats.total_municipios}</p><p className="text-[8px] md:text-[10px] text-[#94a3b8] uppercase tracking-wider">Municípios</p></div>
                <div><p className="text-lg md:text-2xl font-bold font-mono text-blue-400">{selectedYear ? (selectedPeriod === 'ano' ? selectedYear : formatSemester(`${selectedYear}-${selectedPeriod}`)) : 'Todos'}</p><p className="text-[8px] md:text-[10px] text-[#94a3b8] uppercase tracking-wider">Período</p></div>
              </>
            )}
          </div>
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
                  {captcha && (
                    <div>
                      <label className="text-xs uppercase tracking-wider text-[#94a3b8] block mb-1">{captcha.question}</label>
                      <input type="text" value={captchaAnswer} onChange={e => setCaptchaAnswer(e.target.value)} className="w-full bg-[#1a2234] border border-[#1e293b] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#3b82f6]" placeholder="Sua resposta" />
                    </div>
                  )}
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
              <p className="text-sm text-[#94a3b8] mb-2">O mapa possui tres niveis de zoom que mudam automaticamente o que e exibido:</p>
              <ul className="space-y-1 ml-4 text-sm text-[#94a3b8]">
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]"><strong>Estados</strong> — visao geral do Brasil (zoom afastado)</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]"><strong>Municipios</strong> — detalhamento por cidade (zoom medio)</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]"><strong>Bairros</strong> — detalhamento por bairro, disponivel apenas para RS (zoom proximo)</li>
              </ul>
              <p className="text-sm text-[#94a3b8] mt-2">Clique em qualquer regiao ou ponto para ver um detalhamento por tipo de crime. Use a barra de busca para encontrar uma cidade ou bairro especifico.</p>
            </section>

            <section className="mb-5">
              <h3 className="text-sm font-bold text-[#3b82f6] uppercase tracking-wider mb-2">Cores e Escala</h3>
              <div className="flex flex-wrap gap-3 mb-2">
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-[#16a34a]" /><span className="text-sm text-[#94a3b8]">Baixo</span></div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-[#eab308]" /><span className="text-sm text-[#94a3b8]">Medio</span></div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-[#f97316]" /><span className="text-sm text-[#94a3b8]">Alto</span></div>
                <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-[#ef4444]" /><span className="text-sm text-[#94a3b8]">Critico</span></div>
              </div>
              <p className="text-sm text-[#94a3b8]">No modo <strong>/100K hab.</strong>, as cores usam faixas fixas de taxa. No modo <strong>Total</strong>, as cores sao relativas (comparando regioes visiveis entre si).</p>
            </section>

            <section className="mb-5">
              <h3 className="text-sm font-bold text-[#3b82f6] uppercase tracking-wider mb-2">Modos de Visualizacao</h3>
              <ul className="space-y-1 ml-4 text-sm text-[#94a3b8]">
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]"><strong>Pontos vs Regioes:</strong> pontos mostram circulos individuais; regioes colorem areas inteiras no mapa</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]"><strong>/100K hab. vs Total:</strong> taxa per capita (comparacao justa entre regioes de tamanhos diferentes) vs contagem absoluta</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]"><strong>Auto/Municipios/Bairros:</strong> force um nivel especifico de agregacao em vez do automatico por zoom</li>
              </ul>
            </section>

            <section className="mb-5">
              <h3 className="text-sm font-bold text-[#3b82f6] uppercase tracking-wider mb-2">Fontes de Dados</h3>
              <p className="text-sm text-[#94a3b8] mb-2">Os dados vem de multiplas fontes com diferentes niveis de qualidade:</p>
              <div className="space-y-2 ml-4">
                <div className="flex items-start gap-2"><div className="w-2 h-2 rounded-full bg-green-500 mt-1.5 flex-shrink-0" /><span className="text-sm text-[#94a3b8]"><strong>Completo</strong> (RS, RJ) — registros individuais detalhados com dados demograficos da vitima</span></div>
                <div className="flex items-start gap-2"><div className="w-2 h-2 rounded-full bg-amber-500 mt-1.5 flex-shrink-0" /><span className="text-sm text-[#94a3b8]"><strong>Parcial</strong> (MG) — apenas crimes violentos; crimes patrimoniais e drogas nao disponiveis</span></div>
                <div className="flex items-start gap-2"><div className="w-2 h-2 rounded-full bg-gray-500 mt-1.5 flex-shrink-0" /><span className="text-sm text-[#94a3b8]"><strong>Basico</strong> (demais estados) — dados agregados do SINESP/Ministerio da Justica, 15 tipos de crime</span></div>
              </div>
              <p className="text-sm text-[#94a3b8] mt-2">Os dados sao atualizados automaticamente toda semana. Clique em "Fontes" no canto inferior direito do mapa para ver detalhes de cada fonte.</p>
            </section>

            <section className="mb-5">
              <h3 className="text-sm font-bold text-[#3b82f6] uppercase tracking-wider mb-2">Comparando Estados</h3>
              <p className="text-sm text-[#94a3b8] mb-2">Use os checkboxes de estados no painel de Filtros para selecionar estados especificos. Dicas:</p>
              <ul className="space-y-1 ml-4 text-sm text-[#94a3b8]">
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Use o modo <strong>/100K hab.</strong> para comparacoes justas entre estados de tamanhos diferentes</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Ao selecionar MG junto com outros estados, um filtro automatico e aplicado para mostrar apenas crimes violentos (para comparacao justa)</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Clique diretamente nos estados no mapa para seleciona-los rapidamente</li>
              </ul>
            </section>

            <section className="mb-5">
              <h3 className="text-sm font-bold text-[#3b82f6] uppercase tracking-wider mb-2">Filtros</h3>
              <p className="text-sm text-[#94a3b8] mb-2">Os filtros sao <strong>cascata</strong>: ao selecionar um tipo de crime, as opcoes disponiveis nos outros filtros se atualizam automaticamente.</p>
              <ul className="space-y-1 ml-4 text-sm text-[#94a3b8]">
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Filtros de sexo, cor e idade da vitima so tem dados detalhados para RS</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Selecionar estados pode restringir os tipos de crime disponiveis</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Dados do SINESP sao anuais — filtro por semestre fica desabilitado quando apenas estados SINESP estao selecionados</li>
              </ul>
            </section>

            <section>
              <h3 className="text-sm font-bold text-amber-400 uppercase tracking-wider mb-2">Limitacoes</h3>
              <ul className="space-y-1 ml-4 text-sm text-[#94a3b8]">
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Dados por bairro disponiveis apenas para RS</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">MG reporta apenas crimes violentos — nao ha dados de crimes patrimoniais ou drogas</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Dados do SINESP sao anuais — nao e possivel filtrar por semestre</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">A frequencia de atualizacao varia: RS/SP verificados semanalmente; outras fontes tambem atualizadas semanalmente, mas os orgaos de origem publicam em cadencias diferentes</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Alguns municipios podem ter geocodificacao imprecisa</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Dados populacionais sao estimativas — taxas per capita sao aproximadas</li>
                <li className="before:content-['•'] before:mr-2 before:text-[#475569]">Criterios de registro de crimes variam entre estados — comparacoes diretas devem ser feitas com cautela</li>
              </ul>
            </section>
          </div>
        </div>
      )}
    </div>);
}
