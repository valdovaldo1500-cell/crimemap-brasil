'use client';
import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

interface MapRedirectProps {
  panelType: 'state' | 'muni' | 'bairro';
  state: string;
  municipio?: string;
  bairro?: string;
}

const MAP_PARAMS = ['per', 'view', 'rate', 'tipos', 'sexo', 'cor', 'idade_min', 'idade_max'];

function MapRedirectInner({ panelType, state, municipio, bairro }: MapRedirectProps) {
  const searchParams = useSearchParams();
  useEffect(() => {
    // Always redirect to the map view — share URLs should open the map with detail panel
    const p = new URLSearchParams(searchParams.toString());
    p.set('panel', panelType);
    p.set('state', state);
    p.set('states', state);
    if (municipio) p.set('municipio', municipio);
    else p.delete('municipio');
    if (bairro) p.set('bairro', bairro);
    else p.delete('bairro');
    window.location.replace(`/?${p.toString()}`);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function MapRedirect(props: MapRedirectProps) {
  return (
    <Suspense fallback={null}>
      <MapRedirectInner {...props} />
    </Suspense>
  );
}
