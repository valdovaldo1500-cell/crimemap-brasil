'use client';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { fetchStats, fetchCrimeTypes, fetchSemesters, fetchAutocomplete, fetchSexoValues, fetchCorValues, fetchGrupoValues, fetchFilterOptions, fetchCaptcha, submitBugReport } from '@/lib/api';
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
  const [viewMode, setViewMode] = useState<'dots' | 'choropleth'>('choropleth');
  const [aggregationOverride, setAggregationOverride] = useState<'auto'|'municipios'|'bairros'>('auto');
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
    ]).finally(() => setInitialLoading(false));
  }, []);

  // Dynamic cascading filters: re-fetch options when any filter changes
  const filterDebounceRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(() => {
    if (initialLoading) return;
    if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    filterDebounceRef.current = setTimeout(() => {
      const params: any = {};
      if (selectedTypes.length) params.tipo = selectedTypes;
      if (selectedGrupo.length) params.grupo = selectedGrupo[0];
      if (selectedPeriod !== 'ano') params.semestre = `${selectedYear}-${selectedPeriod}`;
      else if (selectedYear) params.ano = selectedYear;
      if (selectedSexo.length) params.sexo = selectedSexo;
      if (selectedCor.length) params.cor = selectedCor;
      if (idadeMin) params.idade_min = Number(idadeMin);
      if (idadeMax) params.idade_max = Number(idadeMax);
      fetchFilterOptions(params).then((opts: any) => {
        const VALID_GRUPOS = ['CRIMES', 'CONTRAVENCOES'];
        setCrimeTypes((opts.tipo || []).map((t: any) => ({ tipo_enquadramento: t.value, count: t.count })));
        setGrupoValues((opts.grupo || []).filter((g: any) => VALID_GRUPOS.includes(g.value)));
        setSexoValues(opts.sexo || []);
        setCorValues(opts.cor || []);
      }).catch((e) => console.error('Filter options fetch failed:', e));
    }, 300);
  }, [selectedTypes, selectedGrupo, selectedYear, selectedPeriod, selectedSexo, selectedCor, idadeMin, idadeMax, initialLoading]);

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

  const filters = useMemo(() => ({
    tipo: selectedTypes.length ? selectedTypes : undefined,
    grupo: selectedGrupo.length ? selectedGrupo[0] : undefined,
    semestre: selectedPeriod !== 'ano' ? `${selectedYear}-${selectedPeriod}` : undefined,
    ano: selectedPeriod === 'ano' ? selectedYear : undefined,
    sexo: selectedSexo.length ? selectedSexo : undefined,
    cor: selectedCor.length ? selectedCor : undefined,
    idade_min: idadeMin ? Number(idadeMin) : undefined,
    idade_max: idadeMax ? Number(idadeMax) : undefined,
  }), [selectedTypes, selectedGrupo, selectedYear, selectedPeriod, selectedSexo, selectedCor, idadeMin, idadeMax]);

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
    <div className="min-h-screen bg-[#0a0f1a]">
      <header className="border-b border-[#1e293b] bg-[#111827]/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-[1800px] mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-500 to-amber-500 flex items-center justify-center text-white font-bold text-xs">BR</div>
            <div><h1 className="text-lg font-bold">Crime Brasil</h1><p className="text-[10px] text-[#94a3b8] uppercase tracking-widest">crimebrasil.com.br</p></div>
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
            <div className="flex rounded-xl border border-[#1e293b] overflow-hidden">
              {(['auto','municipios','bairros'] as const).map(v=>(
                <button key={v} onClick={()=>setAggregationOverride(v)}
                  className={`px-2.5 py-2.5 text-xs ${aggregationOverride===v?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>
                  {v==='auto'?'Auto':v==='municipios'?'Municípios':'Bairros'}
                </button>
              ))}
            </div>
            <a href="mailto:contato@crimebrasil.com.br" className="px-3 py-2.5 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm text-[#94a3b8] hover:bg-[#1e293b] hover:text-[#f1f5f9]">Contato</a>
            <button onClick={openBugReport} className="px-3 py-2.5 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm text-[#94a3b8] hover:bg-[#1e293b] hover:text-[#f1f5f9]">Reportar Bug</button>
            <button onClick={()=>setShowFilters(!showFilters)} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm hover:bg-[#1e293b]">Filtros{activeFilterCount>0&&<span className="bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">{activeFilterCount}</span>}</button>
          </div>
        </div></header>
      <div className="flex h-[calc(100vh-80px)]">
        {showFilters&&<aside className="w-80 border-r border-[#1e293b] bg-[#111827] overflow-y-auto p-4 space-y-4">
          <div><h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Tipo de Crime</h3><input value={crimeTypeSearch} onChange={e=>setCrimeTypeSearch(e.target.value)} placeholder="Buscar tipo..." className="w-full bg-[#1a2234] border border-[#1e293b] rounded-lg px-3 py-1.5 text-sm text-[#f1f5f9] placeholder-[#475569] focus:outline-none focus:border-[#3b82f6] mb-2" /><div className="space-y-1 max-h-64 overflow-y-auto">{crimeTypes.filter((ct:any)=>!crimeTypeSearch||stripAccents(prettifyCrimeType(ct.tipo_enquadramento)).toLowerCase().includes(stripAccents(crimeTypeSearch).toLowerCase())).map((ct:any)=><label key={ct.tipo_enquadramento} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[#1a2234] cursor-pointer text-sm"><input type="checkbox" checked={selectedTypes.includes(ct.tipo_enquadramento)} onChange={()=>toggleType(ct.tipo_enquadramento)} /><span className="flex-1 truncate">{prettifyCrimeType(ct.tipo_enquadramento)}</span><span className="text-[10px] text-[#94a3b8] font-mono">{ct.count.toLocaleString()}</span></label>)}</div></div>
          <div><h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Grupo</h3><div className="space-y-1">{grupoValues.map((gv:any)=><label key={gv.value} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[#1a2234] cursor-pointer text-sm"><input type="checkbox" checked={selectedGrupo.includes(gv.value)} onChange={()=>toggleGrupo(gv.value)} /><span className="flex-1 truncate">{prettifyGrupo(gv.value)}</span><span className="text-[10px] text-[#94a3b8] font-mono">{gv.count.toLocaleString()}</span></label>)}</div></div>
          <div><h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Sexo da Vítima</h3><div className="space-y-1">{sexoValues.map((sv:any)=><label key={sv.value} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[#1a2234] cursor-pointer text-sm"><input type="checkbox" checked={selectedSexo.includes(sv.value)} onChange={()=>toggleSexo(sv.value)} /><span className="flex-1">{sv.value}</span><span className="text-[10px] text-[#94a3b8] font-mono">{sv.count.toLocaleString()}</span></label>)}</div></div>
          <div><h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Cor da Vítima</h3><div className="space-y-1">{corValues.map((cv:any)=><label key={cv.value} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[#1a2234] cursor-pointer text-sm"><input type="checkbox" checked={selectedCor.includes(cv.value)} onChange={()=>toggleCor(cv.value)} /><span className="flex-1">{cv.value}</span><span className="text-[10px] text-[#94a3b8] font-mono">{cv.count.toLocaleString()}</span></label>)}</div></div>
          <div><h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Idade da Vítima</h3><div className="flex gap-2"><input type="number" placeholder="Mín" value={idadeMin} onChange={e=>setIdadeMin(e.target.value)} min={0} max={120} className="w-1/2 bg-[#1a2234] border border-[#1e293b] rounded-lg px-3 py-2 text-sm" /><input type="number" placeholder="Máx" value={idadeMax} onChange={e=>setIdadeMax(e.target.value)} min={0} max={120} className="w-1/2 bg-[#1a2234] border border-[#1e293b] rounded-lg px-3 py-2 text-sm" /></div></div>
        </aside>}
        <main className="flex-1 relative z-0">
          <CrimeMap center={center} zoom={zoom} filters={filters} viewMode={viewMode} aggregationOverride={aggregationOverride} />
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
        </main></div>
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
    </div>);
}
