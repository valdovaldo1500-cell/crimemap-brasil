'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

interface MapLinkButtonProps {
  panelType: 'state' | 'muni' | 'bairro';
  state: string;
  municipio?: string;
  bairro?: string;
  description?: string;
}

const BTN_STYLE = { display: 'inline-block', background: '#2563eb', color: '#fff', padding: '0.75rem 2rem', borderRadius: '0.5rem', textDecoration: 'none', fontWeight: 600, fontSize: '1rem' } as const;
const WRAP_STYLE = { background: 'linear-gradient(135deg, #1e3a5f 0%, #1a2744 100%)', borderRadius: '1rem', padding: '2rem', textAlign: 'center' as const, border: '1px solid #2563eb33', marginBottom: '2rem' } as const;

function buildBase(panelType: string, state: string, municipio?: string, bairro?: string) {
  const p = new URLSearchParams();
  p.set('panel', panelType);
  p.set('state', state);
  p.set('states', state);
  if (municipio) p.set('municipio', municipio);
  if (bairro) p.set('bairro', bairro);
  return p;
}

function MapLinkButtonInner({ panelType, state, municipio, bairro, description }: MapLinkButtonProps) {
  const searchParams = useSearchParams();
  const p = buildBase(panelType, state, municipio, bairro);
  ['per', 'ano', 'tipos', 'sexo', 'cor', 'idade_min', 'idade_max', 'view', 'rate'].forEach(k => {
    const v = searchParams.get(k);
    if (v) p.set(k, v);
  });
  return (
    <div style={WRAP_STYLE}>
      {description && <p style={{ color: '#93c5fd', marginBottom: '1rem', fontSize: '1rem' }}>{description}</p>}
      <Link href={`/?${p.toString()}`} style={BTN_STYLE}>Ver no mapa interativo →</Link>
    </div>
  );
}

export default function MapLinkButton(props: MapLinkButtonProps) {
  const { panelType, state, municipio, bairro, description } = props;
  const fallback = `/?${buildBase(panelType, state, municipio, bairro).toString()}`;
  return (
    <Suspense fallback={
      <div style={WRAP_STYLE}>
        {description && <p style={{ color: '#93c5fd', marginBottom: '1rem', fontSize: '1rem' }}>{description}</p>}
        <a href={fallback} style={BTN_STYLE}>Ver no mapa interativo →</a>
      </div>
    }>
      <MapLinkButtonInner {...props} />
    </Suspense>
  );
}
