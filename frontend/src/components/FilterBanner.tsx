'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

interface FilterBannerProps {
  panelType: 'state' | 'muni' | 'bairro';
  state: string;
  municipio?: string;
  bairro?: string;
}

function FilterBannerInner({ panelType, state, municipio, bairro }: FilterBannerProps) {
  const searchParams = useSearchParams();
  const hasFilters = searchParams.get('per') || searchParams.get('tipos') ||
    searchParams.get('sexo') || searchParams.get('cor') ||
    searchParams.get('idade_min') || searchParams.get('idade_max') ||
    searchParams.get('view');
  if (!hasFilters) return null;

  const p = new URLSearchParams();
  p.set('panel', panelType);
  p.set('state', state);
  if (municipio) p.set('municipio', municipio);
  if (bairro) p.set('bairro', bairro);
  ['per', 'ano', 'tipos', 'sexo', 'cor', 'idade_min', 'idade_max', 'view'].forEach(k => {
    const v = searchParams.get(k);
    if (v) p.set(k, v);
  });

  return (
    <Link
      href={`/?${p.toString()}`}
      style={{
        display: 'block',
        background: 'linear-gradient(135deg, #1e3a5f 0%, #1a2744 100%)',
        border: '1px solid #2563eb44',
        borderRadius: '0.75rem',
        padding: '1rem 1.5rem',
        marginBottom: '1.5rem',
        color: '#93c5fd',
        textDecoration: 'none',
        fontSize: '0.9rem',
        textAlign: 'center' as const,
        fontWeight: 600,
      }}
    >
      Ver dados com filtros aplicados no mapa interativo →
    </Link>
  );
}

export default function FilterBanner(props: FilterBannerProps) {
  return (
    <Suspense fallback={null}>
      <FilterBannerInner {...props} />
    </Suspense>
  );
}
