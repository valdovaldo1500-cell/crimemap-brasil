'use client';
import { useState, useRef, useCallback, useEffect } from 'react';
import { slugify } from '@/lib/slugify';
import { trackEvent } from '@/lib/analytics';

const STATE_SLUGS: Record<string, string> = {
  RS: 'rio-grande-do-sul',
  RJ: 'rio-de-janeiro',
  MG: 'minas-gerais',
};

function getShareUrl(state?: string, municipio?: string, bairro?: string): string {
  const base = 'https://crimebrasil.com.br';
  if (!state) return base;
  if (!municipio) {
    const stateSlug = STATE_SLUGS[state];
    return stateSlug ? `${base}/estado/${stateSlug}` : base;
  }
  if (bairro) {
    return `${base}/bairro/${state.toLowerCase()}/${slugify(municipio)}/${slugify(bairro)}`;
  }
  return `${base}/cidade/${state.toLowerCase()}/${slugify(municipio)}`;
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
  shareUrl?: string;
}

export default function DetailPanel({ data, onClose, stackIndex = 0, onFocus, rateMode = 'absolute', shareUrl: shareUrlProp }: DetailPanelProps) {
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
  const shareUrl = shareUrlProp ?? getShareUrl(data.state, data.municipio, data.bairro);
  const sep = shareUrl.includes('?') ? '&' : '?';
  const waShareUrl = `${shareUrl}${sep}utm_source=whatsapp&utm_medium=social&utm_campaign=panel_share`;
  const copyShareUrl = `${shareUrl}${sep}utm_source=link_copy&utm_medium=social&utm_campaign=panel_share`;
  const shareText = `${data.displayName}: ${data.total.toLocaleString('pt-BR')} ocorrências de crime registradas${rate ? ` (${rate}/100K hab.)` : ''}. Veja os dados no Crime Brasil: ${waShareUrl}`;
  const waLink = `https://wa.me/?text=${encodeURIComponent(shareText)}`;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(copyShareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
    trackEvent('share_clicked', { share_method: 'copy_link', location_name: data.displayName });
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
        <div className="flex items-center gap-1 flex-shrink-0" onMouseDown={e => e.stopPropagation()}>
          {/* WhatsApp share */}
          <a
            href={waLink}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => { e.stopPropagation(); trackEvent('share_clicked', { share_method: 'whatsapp', location_name: data.displayName }); }}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[#374151] text-[#25D366] transition-colors"
            aria-label="Compartilhar no WhatsApp"
            title="Compartilhar no WhatsApp"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
          </a>
          {/* Copy link */}
          <div className="relative">
            <button
              onClick={handleCopy}
              className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[#374151] text-[#94a3b8] hover:text-white transition-colors"
              aria-label="Copiar link"
              title="Copiar link"
            >
              {copied ? (
                <svg viewBox="0 0 24 24" className="w-4 h-4 text-green-400" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                </svg>
              )}
            </button>
            {copied && (
              <span className="absolute -bottom-7 left-1/2 -translate-x-1/2 bg-[#1e293b] text-green-400 text-[10px] px-2 py-0.5 rounded whitespace-nowrap pointer-events-none">
                Copiado!
              </span>
            )}
          </div>
          {/* Close */}
          <button
            onClick={onClose}
            onMouseDown={e => e.stopPropagation()}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[#374151] text-[#94a3b8] hover:text-white transition-colors"
            aria-label="Fechar painel"
          >
            &#x2715;
          </button>
        </div>
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
