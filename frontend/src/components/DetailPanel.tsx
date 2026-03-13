'use client';
import { useState, useRef, useCallback, useEffect } from 'react';
import { slugify } from '@/lib/slugify';

const STATE_SLUGS: Record<string, string> = {
  RS: 'rio-grande-do-sul',
  RJ: 'rio-de-janeiro',
  MG: 'minas-gerais',
};

function getShareUrl(state?: string, municipio?: string, bairro?: string): string {
  const base = 'https://crimebrasil.com.br';
  if (!state || (!municipio && !state)) return base;
  if (municipio && !bairro) {
    const stateSlug = STATE_SLUGS[state];
    if (stateSlug) return `${base}/cidade/${state.toLowerCase()}/${slugify(municipio)}`;
  }
  if (state && !municipio) {
    const stateSlug = STATE_SLUGS[state];
    if (stateSlug) return `${base}/estado/${stateSlug}`;
  }
  return base;
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

interface DetailPanelProps {
  data: {
    id?: string;
    displayName: string;
    total: number;
    population?: number | null;
    crime_types?: { tipo: string; count: number }[];
    components?: { bairro: string; weight: number }[];
    isUnknown?: boolean;
    loading?: boolean;
    periodLabel?: string;
    state?: string;
    municipio?: string;
    bairro?: string;
  } | null;
  onClose: () => void;
  stackIndex?: number;
  onFocus?: () => void;
  rateMode?: 'rate' | 'absolute';
}

export default function DetailPanel({ data, onClose, stackIndex = 0, onFocus, rateMode = 'absolute' }: DetailPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: 320, h: 0 }); // h=0 means auto
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [copied, setCopied] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, px: 0, py: 0 });
  const resizeStart = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const initialized = useRef(false);

  // Center panel on first show
  useEffect(() => {
    if (data && !initialized.current) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Position: right side on desktop, center-bottom on mobile
      const isMobile = vw < 640;
      setPos({
        x: (isMobile ? Math.max(8, (vw - 300) / 2) : vw - 400) + stackIndex * 30,
        y: (isMobile ? vh - 350 : 100) + stackIndex * 30,
      });
      setSize({ w: isMobile ? Math.min(300, vw - 16) : 320, h: 0 });
      initialized.current = true;
    }
    if (!data) initialized.current = false;
  }, [data]);

  // Drag handlers (mouse + touch)
  const onDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    dragStart.current = { x: clientX, y: clientY, px: pos.x, py: pos.y };
    setDragging(true);
  }, [pos]);

  // Resize handlers
  const onResizeStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    const rect = panelRef.current?.getBoundingClientRect();
    resizeStart.current = { x: clientX, y: clientY, w: rect?.width || 320, h: rect?.height || 200 };
    setResizing(true);
  }, []);

  useEffect(() => {
    if (!dragging && !resizing) return;
    const onMove = (e: MouseEvent | TouchEvent) => {
      const clientX = 'touches' in e ? (e as TouchEvent).touches[0].clientX : (e as MouseEvent).clientX;
      const clientY = 'touches' in e ? (e as TouchEvent).touches[0].clientY : (e as MouseEvent).clientY;
      if (dragging) {
        setPos({
          x: dragStart.current.px + (clientX - dragStart.current.x),
          y: dragStart.current.py + (clientY - dragStart.current.y),
        });
      } else if (resizing) {
        const newW = Math.max(220, resizeStart.current.w + (clientX - resizeStart.current.x));
        const newH = Math.max(100, resizeStart.current.h + (clientY - resizeStart.current.y));
        setSize({ w: newW, h: newH });
      }
    };
    const onEnd = () => { setDragging(false); setResizing(false); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
  }, [dragging, resizing]);

  if (!data) return null;

  const rate = data.population ? ((data.total / data.population) * 100000).toFixed(1) : null;
  const shareUrl = getShareUrl(data.state, data.municipio, data.bairro);
  const shareText = `${data.displayName}: ${data.total.toLocaleString('pt-BR')} ocorrências de crime registradas${rate ? ` (${rate}/100K hab.)` : ''}. Veja os dados no Crime Brasil: ${shareUrl}`;
  const waLink = `https://wa.me/?text=${encodeURIComponent(shareText)}`;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      ref={panelRef}
      className="fixed bg-[#111827] border border-[#1e293b] rounded-xl shadow-2xl overflow-hidden"
      style={{
        left: pos.x,
        top: pos.y,
        width: size.w,
        ...(size.h > 0 ? { height: size.h } : {}),
        maxHeight: '80vh',
        zIndex: 2000 + stackIndex,
      }}
      onMouseDown={() => onFocus?.()}
      onTouchStart={() => onFocus?.()}
    >
      {/* Drag handle / title bar */}
      <div
        className="flex items-center justify-between px-3 py-2 bg-[#1a2234] cursor-move select-none border-b border-[#1e293b]"
        onMouseDown={onDragStart}
        onTouchStart={onDragStart}
      >
        <span className="text-sm font-semibold text-[#f1f5f9] truncate mr-2">{data.displayName}{data.periodLabel && <span className="text-[9px] font-normal text-[#64748b] ml-1.5">({data.periodLabel})</span>}</span>
        <button
          onClick={onClose}
          onMouseDown={e => e.stopPropagation()}
          className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[#374151] text-[#94a3b8] hover:text-white transition-colors"
          aria-label="Fechar painel"
        >
          &#x2715;
        </button>
      </div>

      {/* Content */}
      <div className="p-3 overflow-y-auto" style={{ maxHeight: size.h > 0 ? size.h - 40 : 'calc(80vh - 40px)' }}>
        {data.loading && !data.total ? (
          /* Full skeleton when no cached total */
          <div className="space-y-3">
            <div className="flex items-baseline gap-3 mb-2">
              <div className="h-6 w-20 bg-[#1e293b] rounded animate-pulse" />
              <div className="h-3 w-16 bg-[#1e293b] rounded animate-pulse" />
            </div>
            <div className="h-3 w-32 bg-[#1e293b] rounded animate-pulse" />
            <div className="space-y-1.5 pt-2">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="flex justify-between">
                  <div className="h-3 bg-[#1e293b] rounded animate-pulse" style={{ width: `${60 + i * 10}%` }} />
                  <div className="h-3 w-8 bg-[#1e293b] rounded animate-pulse" />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            {rateMode === 'rate' && rate ? (
              <>
                <div className="flex items-baseline gap-3 mb-2">
                  <span className="text-lg font-bold font-mono text-[#f1f5f9]">{rate}</span>
                  <span className="text-xs text-[#94a3b8]">/100K hab.</span>
                </div>
                <div className="text-xs text-[#94a3b8] mb-3">
                  <span className="font-mono text-[#f1f5f9]">{data.total.toLocaleString()}</span> ocorrências
                  {data.population && <span className="ml-2 text-[#64748b]">(pop: {data.population.toLocaleString()})</span>}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-baseline gap-3 mb-2">
                  <span className="text-lg font-bold font-mono text-[#f1f5f9]">{data.total.toLocaleString()}</span>
                  <span className="text-xs text-[#94a3b8]">ocorrências</span>
                </div>
                {rate && (
                  <div className="text-xs text-[#94a3b8] mb-3">
                    <span className="font-mono text-[#f1f5f9]">{rate}</span> /100K hab.
                    {data.population && <span className="ml-2 text-[#64748b]">(pop: {data.population.toLocaleString()})</span>}
                  </div>
                )}
              </>
            )}

            {/* Unknown bairro components */}
            {data.isUnknown && data.components && data.components.length > 0 && (
              <div className="mb-3">
                <div className="text-[10px] text-[#94a3b8] uppercase tracking-wider mb-1">
                  Bairros com poucas ocorrências ou localização imprecisa:
                </div>
                <div className="space-y-0.5 max-h-40 overflow-y-auto">
                  {data.components.map((c, i) => (
                    <div key={i} className="flex justify-between text-xs">
                      <span className="text-[#cbd5e1] truncate">{c.bairro}</span>
                      <span className="font-mono text-[#94a3b8] ml-2">{c.weight.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Crime type breakdown — skeleton or real data */}
            {data.loading && !data.crime_types ? (
              <div className="space-y-1.5 pt-1">
                <div className="text-[10px] text-[#94a3b8] uppercase tracking-wider mb-1">Tipos de crime</div>
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="flex justify-between">
                    <div className="h-3 bg-[#1e293b] rounded animate-pulse" style={{ width: `${60 + i * 10}%` }} />
                    <div className="h-3 w-8 bg-[#1e293b] rounded animate-pulse" />
                  </div>
                ))}
              </div>
            ) : data.crime_types && data.crime_types.length > 0 ? (
              <div>
                <div className="text-[10px] text-[#94a3b8] uppercase tracking-wider mb-1">
                  Tipos de crime{rateMode === 'rate' && data.population ? ' /100K' : ''}
                </div>
                <div className="space-y-0.5 max-h-60 overflow-y-auto">
                  {data.crime_types.map((ct, i) => (
                    <div key={i} className="flex items-center text-xs gap-1">
                      <span className="text-[#cbd5e1] truncate flex-1">{prettifyCrimeType(ct.tipo)}</span>
                      <span className="font-mono text-[#64748b] whitespace-nowrap">{data.total > 0 ? ((ct.count / data.total) * 100).toFixed(1) : '0.0'}%</span>
                      <span className="font-mono text-[#94a3b8] whitespace-nowrap w-14 text-right">{rateMode === 'rate' && data.population ? (ct.count / data.population * 100000).toFixed(1) : ct.count.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Resize handle */}
      <div
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
        onMouseDown={onResizeStart}
        onTouchStart={onResizeStart}
      >
        <svg className="w-3 h-3 text-[#475569] ml-1 mt-1" viewBox="0 0 6 6">
          <circle cx="5" cy="1" r="0.7" fill="currentColor" />
          <circle cx="5" cy="5" r="0.7" fill="currentColor" />
          <circle cx="1" cy="5" r="0.7" fill="currentColor" />
        </svg>
      </div>
    </div>
  );
}
