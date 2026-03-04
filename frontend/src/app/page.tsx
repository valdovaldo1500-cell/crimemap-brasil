'use client';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { fetchStats, fetchCrimeTypes, fetchMunicipios, fetchSemesters, fetchAutocomplete } from '@/lib/api';
const CrimeMap = dynamic(() => import('@/components/CrimeMap'), { ssr: false });

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
  const [municipios, setMunicipios] = useState<string[]>([]);
  const [semesters, setSemesters] = useState<string[]>([]);
  const [selectedYear, setSelectedYear] = useState('');
  const [selectedPeriod, setSelectedPeriod] = useState<'ano' | 'S1' | 'S2'>('ano');
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [selectedMun, setSelectedMun] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [center, setCenter] = useState<[number,number]>([-30.03,-51.22]);
  const [zoom, setZoom] = useState(7);
  const [showFilters, setShowFilters] = useState(false);
  const [viewMode, setViewMode] = useState<'dots' | 'choropleth'>('dots');
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>|null>(null);

  const [initialLoading, setInitialLoading] = useState(true);
  useEffect(() => { Promise.all([fetchStats().then(setStats), fetchCrimeTypes().then(setCrimeTypes), fetchMunicipios().then(setMunicipios), fetchSemesters().then((s: string[]) => { setSemesters(s); if (s.length > 0) { setSelectedYear(s[0].split('-')[0]); setSelectedPeriod('ano'); } })]).finally(() => setInitialLoading(false)); }, []);

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

  const toggle = (t:string) => setSelectedTypes(p=>p.includes(t)?p.filter(x=>x!==t):[...p,t]);
  const filters = useMemo(() => ({
    tipo: selectedTypes.length ? selectedTypes : undefined,
    municipio: selectedMun || undefined,
    semestre: selectedPeriod !== 'ano' ? `${selectedYear}-${selectedPeriod}` : undefined,
    ano: selectedPeriod === 'ano' ? selectedYear : undefined,
  }), [selectedTypes, selectedMun, selectedYear, selectedPeriod]);

  const municResults = suggestions.filter(s => s.type === 'municipio');
  const bairroResults = suggestions.filter(s => s.type === 'bairro');

  return (
    <div className="min-h-screen bg-[#0a0f1a]">
      <header className="border-b border-[#1e293b] bg-[#111827]/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-[1800px] mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-500 to-amber-500 flex items-center justify-center text-white font-bold text-xs">RS</div>
            <div><h1 className="text-lg font-bold">CrimeMap RS</h1><p className="text-[10px] text-[#94a3b8] uppercase tracking-widest">Rio Grande do Sul</p></div>
          </div>
          <div className="flex-1 max-w-md mx-8 relative" ref={searchRef}>
            <input
              value={searchQ}
              onChange={e => onSearchChange(e.target.value)}
              onFocus={() => { setSearchFocused(true); if (suggestions.length > 0) setShowSuggestions(true); }}
              onBlur={() => { setSearchFocused(false); setTimeout(() => setShowSuggestions(false), 200); }}
              placeholder="Buscar cidade ou bairro..."
              className="w-full bg-[#1a2234] border border-[#1e293b] rounded-xl px-4 py-2.5 text-sm text-[#f1f5f9] placeholder-[#475569] focus:outline-none focus:border-[#3b82f6]"
            />
            {searchFocused && searchQ.trim().length < 3 && !showSuggestions && (
              <div className="absolute top-full mt-1 w-full bg-[#1a2234] border border-[#1e293b] rounded-xl overflow-hidden shadow-2xl z-50 px-4 py-3">
                <span className="text-sm text-[#475569]">Comece a escrever para sugestões...</span>
              </div>
            )}
            {showSuggestions && (
              <div className="absolute top-full mt-1 w-full bg-[#1a2234] border border-[#1e293b] rounded-xl overflow-hidden shadow-2xl z-50 max-h-80 overflow-y-auto">
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
          <div className="flex items-center gap-2">
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
                    <button onClick={() => setSelectedPeriod('S1')}
                      className={`px-2.5 py-1 text-xs ${selectedPeriod === 'S1' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>
                      Jan-Jun
                    </button>
                  )}
                  {availablePeriods.includes('S2') && (
                    <button onClick={() => setSelectedPeriod('S2')}
                      className={`px-2.5 py-1 text-xs ${selectedPeriod === 'S2' ? 'bg-[#3b82f6] text-white' : 'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>
                      Jul-Dez
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="flex rounded-xl border border-[#1e293b] overflow-hidden">
              <button onClick={()=>setViewMode('dots')} className={`px-3 py-2.5 text-sm ${viewMode==='dots'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>Pontos</button>
              <button onClick={()=>setViewMode('choropleth')} className={`px-3 py-2.5 text-sm ${viewMode==='choropleth'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>Regiões</button>
            </div>
            <button onClick={()=>setShowFilters(!showFilters)} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm hover:bg-[#1e293b]">Filtros{selectedTypes.length>0&&<span className="bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">{selectedTypes.length}</span>}</button>
          </div>
        </div></header>
      <div className="flex h-[calc(100vh-80px)]">
        {showFilters&&<aside className="w-80 border-r border-[#1e293b] bg-[#111827] overflow-y-auto p-4 space-y-4">
          <div><h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Município</h3><select value={selectedMun} onChange={e=>setSelectedMun(e.target.value)} className="w-full bg-[#1a2234] border border-[#1e293b] rounded-lg px-3 py-2 text-sm"><option value="">Todos</option>{municipios.map(m=><option key={m} value={m}>{m}</option>)}</select></div>
          <div><h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Tipo de Crime</h3><div className="space-y-1 max-h-96 overflow-y-auto">{crimeTypes.slice(0,30).map((ct:any)=><label key={ct.tipo_enquadramento} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[#1a2234] cursor-pointer text-sm"><input type="checkbox" checked={selectedTypes.includes(ct.tipo_enquadramento)} onChange={()=>toggle(ct.tipo_enquadramento)} /><span className="flex-1 truncate">{prettifyCrimeType(ct.tipo_enquadramento)}</span><span className="text-[10px] text-[#94a3b8] font-mono">{ct.count.toLocaleString()}</span></label>)}</div></div>
        </aside>}
        <main className="flex-1 relative z-0">
          <CrimeMap center={center} zoom={zoom} filters={filters} viewMode={viewMode} />
          <div className="absolute bottom-4 left-4 bg-[#111827]/90 backdrop-blur-xl border border-[#1e293b] rounded-2xl p-4 z-[1000] flex gap-6">
            {initialLoading ? (
              <>
                <div><div className="h-8 w-20 bg-[#1e293b] rounded animate-pulse mb-1" /><div className="h-3 w-16 bg-[#1e293b] rounded animate-pulse" /></div>
                <div><div className="h-8 w-14 bg-[#1e293b] rounded animate-pulse mb-1" /><div className="h-3 w-16 bg-[#1e293b] rounded animate-pulse" /></div>
              </>
            ) : stats && (
              <>
                <div><p className="text-2xl font-bold font-mono text-red-400">{stats.total_crimes?.toLocaleString()}</p><p className="text-[10px] text-[#94a3b8] uppercase tracking-wider">Ocorrências</p></div>
                <div><p className="text-2xl font-bold font-mono text-amber-400">{stats.total_municipios}</p><p className="text-[10px] text-[#94a3b8] uppercase tracking-wider">Municípios</p></div>
                <div><p className="text-2xl font-bold font-mono text-blue-400">{selectedYear ? (selectedPeriod === 'ano' ? selectedYear : formatSemester(`${selectedYear}-${selectedPeriod}`)) : 'Todos'}</p><p className="text-[10px] text-[#94a3b8] uppercase tracking-wider">Período</p></div>
              </>
            )}
          </div>
        </main></div></div>);
}
