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

function FilterBannerInner(_props: FilterBannerProps) {
  return null;
}

export default function FilterBanner(props: FilterBannerProps) {
  return (
    <Suspense fallback={null}>
      <FilterBannerInner {...props} />
    </Suspense>
  );
}
