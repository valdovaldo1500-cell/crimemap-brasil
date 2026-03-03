'use client';
import { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { fetchStats, fetchCrimeTypes, fetchMunicipios, fetchAutocomplete } from '@/lib/api';
const CrimeMap = dynamic(() => import('@/components/CrimeMap'), { ssr: false });

function formatCount(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

export default function Home() {
  const [stats, setStats] = useState<any>(null);
  const [crimeTypes, setCrimeTypes] = useState<any[]>([]);
  const [municipios, setMunicipios] = useState<string[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [selectedMun, setSelectedMun] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [center, setCenter] = useState<[number,number]>([-30.03,-51.22]);
  const [zoom, setZoom] = useState(7);
  const [showFilters, setShowFilters] = useState(false);
  const [viewMode, setViewMode] = useState<'dots' | 'choropleth'>('dots');
  const searchRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>|null>(null);

  useEffect(() => { fetchStats().then(setStats); fetchCrimeTypes().then(setCrimeTypes); fetchMunicipios().then(setMunicipios); }, []);

  const onSearchChange = (val: string) => {
    setSearchQ(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (val.trim().length < 2) { setSuggestions([]); setShowSuggestions(false); return; }
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

  const toggle = (t:string) => setSelectedTypes(p=>p.includes(t)?p.filter(x=>x!==t):[...p,t]);
  const filters = {tipo:selectedTypes.length?selectedTypes:undefined,municipio:selectedMun||undefined};

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
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
              placeholder="Buscar cidade ou bairro..."
              className="w-full bg-[#1a2234] border border-[#1e293b] rounded-xl px-4 py-2.5 text-sm text-[#f1f5f9] placeholder-[#475569] focus:outline-none focus:border-[#3b82f6]"
            />
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
            <div className="flex rounded-xl border border-[#1e293b] overflow-hidden">
              <button onClick={()=>setViewMode('dots')} className={`px-3 py-2.5 text-sm ${viewMode==='dots'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>Pontos</button>
              <button onClick={()=>setViewMode('choropleth')} className={`px-3 py-2.5 text-sm ${viewMode==='choropleth'?'bg-[#3b82f6] text-white':'bg-[#1a2234] text-[#94a3b8] hover:bg-[#1e293b]'}`}>Regioes</button>
            </div>
            <button onClick={()=>setShowFilters(!showFilters)} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm hover:bg-[#1e293b]">Filtros{selectedTypes.length>0&&<span className="bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">{selectedTypes.length}</span>}</button>
          </div>
        </div></header>
      <div className="flex h-[calc(100vh-57px)]">
        {showFilters&&<aside className="w-80 border-r border-[#1e293b] bg-[#111827] overflow-y-auto p-4 space-y-4">
          <div><h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Municipio</h3><select value={selectedMun} onChange={e=>setSelectedMun(e.target.value)} className="w-full bg-[#1a2234] border border-[#1e293b] rounded-lg px-3 py-2 text-sm"><option value="">Todos</option>{municipios.map(m=><option key={m} value={m}>{m}</option>)}</select></div>
          <div><h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Tipo de Crime</h3><div className="space-y-1 max-h-96 overflow-y-auto">{crimeTypes.slice(0,30).map((ct:any)=><label key={ct.tipo_enquadramento} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[#1a2234] cursor-pointer text-sm"><input type="checkbox" checked={selectedTypes.includes(ct.tipo_enquadramento)} onChange={()=>toggle(ct.tipo_enquadramento)} /><span className="flex-1 truncate">{ct.tipo_enquadramento}</span><span className="text-[10px] text-[#94a3b8] font-mono">{ct.count.toLocaleString()}</span></label>)}</div></div>
        </aside>}
        <main className="flex-1 relative">
          <CrimeMap center={center} zoom={zoom} filters={filters} viewMode={viewMode} />
          {stats&&<div className="absolute bottom-4 left-4 bg-[#111827]/90 backdrop-blur-xl border border-[#1e293b] rounded-2xl p-4 z-[1000] flex gap-6">
            <div><p className="text-2xl font-bold font-mono text-red-400">{stats.total_crimes?.toLocaleString()}</p><p className="text-[10px] text-[#94a3b8] uppercase tracking-wider">Ocorrencias</p></div>
            <div><p className="text-2xl font-bold font-mono text-amber-400">{stats.total_municipios}</p><p className="text-[10px] text-[#94a3b8] uppercase tracking-wider">Municipios</p></div>
          </div>}
        </main></div></div>);
}
