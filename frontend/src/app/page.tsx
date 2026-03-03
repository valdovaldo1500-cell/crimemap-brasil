'use client';
import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { fetchStats, fetchCrimeTypes, fetchMunicipios, searchLocation } from '@/lib/api';
const CrimeMap = dynamic(() => import('@/components/CrimeMap'), { ssr: false });
export default function Home() {
  const [stats, setStats] = useState<any>(null);
  const [crimeTypes, setCrimeTypes] = useState<any[]>([]);
  const [municipios, setMunicipios] = useState<string[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [selectedMun, setSelectedMun] = useState('');
  const [searchQ, setSearchQ] = useState('');
  const [searchRes, setSearchRes] = useState<any[]>([]);
  const [center, setCenter] = useState<[number,number]>([-30.03,-51.22]);
  const [zoom, setZoom] = useState(7);
  const [showFilters, setShowFilters] = useState(false);
  useEffect(() => { fetchStats().then(setStats); fetchCrimeTypes().then(setCrimeTypes); fetchMunicipios().then(setMunicipios); }, []);  const doSearch = async () => { if (!searchQ.trim()) return; const r = await searchLocation(searchQ); setSearchRes(r); if (r.length>0&&r[0].latitude) { setCenter([r[0].latitude,r[0].longitude]); setZoom(r[0].type==="bairro"?14:12); }};
  const toggle = (t:string) => setSelectedTypes(p=>p.includes(t)?p.filter(x=>x!==t):[...p,t]);
  const filters = {tipo:selectedTypes.length?selectedTypes:undefined,municipio:selectedMun||undefined};
  return (
    <div className="min-h-screen bg-[#0a0f1a]">
      <header className="border-b border-[#1e293b] bg-[#111827]/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-[1800px] mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-500 to-amber-500 flex items-center justify-center text-white font-bold text-xs">RS</div>
            <div><h1 className="text-lg font-bold">CrimeMap RS</h1><p className="text-[10px] text-[#94a3b8] uppercase tracking-widest">Rio Grande do Sul</p></div>
          </div>
          <div className="flex-1 max-w-md mx-8 relative">
            <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doSearch()} placeholder="Buscar cidade ou bairro..." className="w-full bg-[#1a2234] border border-[#1e293b] rounded-xl px-4 py-2.5 text-sm text-[#f1f5f9] placeholder-[#475569] focus:outline-none focus:border-[#3b82f6]" />            {searchRes.length>0&&<div className="absolute top-full mt-1 w-full bg-[#1a2234] border border-[#1e293b] rounded-xl overflow-hidden shadow-2xl z-50">{searchRes.map((r:any,i:number)=><button key={i} onClick={()=>{if(r.latitude){setCenter([r.latitude,r.longitude]);setZoom(r.type==="bairro"?14:12)}setSearchRes([])}} className="w-full px-4 py-2 text-left text-sm hover:bg-[#111827]">{r.name}</button>)}</div>}
          </div>
          <button onClick={()=>setShowFilters(!showFilters)} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#1a2234] border border-[#1e293b] text-sm hover:bg-[#1e293b]">Filtros{selectedTypes.length>0&&<span className="bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">{selectedTypes.length}</span>}</button>
        </div></header>
      <div className="flex h-[calc(100vh-57px)]">
        {showFilters&&<aside className="w-80 border-r border-[#1e293b] bg-[#111827] overflow-y-auto p-4 space-y-4">
          <div><h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Municipio</h3><select value={selectedMun} onChange={e=>setSelectedMun(e.target.value)} className="w-full bg-[#1a2234] border border-[#1e293b] rounded-lg px-3 py-2 text-sm"><option value="">Todos</option>{municipios.map(m=><option key={m} value={m}>{m}</option>)}</select></div>
          <div><h3 className="text-xs uppercase tracking-wider text-[#94a3b8] mb-2">Tipo de Crime</h3><div className="space-y-1 max-h-96 overflow-y-auto">{crimeTypes.slice(0,30).map((ct:any)=><label key={ct.tipo_enquadramento} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[#1a2234] cursor-pointer text-sm"><input type="checkbox" checked={selectedTypes.includes(ct.tipo_enquadramento)} onChange={()=>toggle(ct.tipo_enquadramento)} /><span className="flex-1 truncate">{ct.tipo_enquadramento}</span><span className="text-[10px] text-[#94a3b8] font-mono">{ct.count.toLocaleString()}</span></label>)}</div></div>
        </aside>}
        <main className="flex-1 relative">
          <CrimeMap center={center} zoom={zoom} filters={filters} />
          {stats&&<div className="absolute bottom-4 left-4 bg-[#111827]/90 backdrop-blur-xl border border-[#1e293b] rounded-2xl p-4 z-[1000] flex gap-6">
            <div><p className="text-2xl font-bold font-mono text-red-400">{stats.total_crimes?.toLocaleString()}</p><p className="text-[10px] text-[#94a3b8] uppercase tracking-wider">Ocorrencias</p></div>
            <div><p className="text-2xl font-bold font-mono text-amber-400">{stats.total_municipios}</p><p className="text-[10px] text-[#94a3b8] uppercase tracking-wider">Municipios</p></div>
          </div>}
        </main></div></div>);}