import type { Metadata } from 'next';
import Link from 'next/link';
import { unslugify } from '@/lib/slugify';
import FilterBanner from '@/components/FilterBanner';
import MapLinkButton from '@/components/MapLinkButton';
import MapRedirect from '@/components/MapRedirect';
import JsonLd from '@/components/JsonLd';

const API_BASE = 'https://crimebrasil.com.br';

const STATE_NAMES: Record<string, string> = {
  rs: 'Rio Grande do Sul',
  rj: 'Rio de Janeiro',
  mg: 'Minas Gerais',
};

const STATE_CODES: Record<string, string> = {
  rs: 'RS',
  rj: 'RJ',
  mg: 'MG',
};

const STATE_SLUGS_FULL: Record<string, string> = {
  rs: 'rio-grande-do-sul',
  rj: 'rio-de-janeiro',
  mg: 'minas-gerais',
};

export const revalidate = 86400;

async function fetchLocationStats(stateCode: string, municipio: string, bairro: string) {
  try {
    const params = new URLSearchParams({ state: stateCode, municipio, bairro });
    const res = await fetch(`${API_BASE}/api/location-stats?${params}`, { next: { revalidate: 86400 } });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: { state: string; city: string; bairro: string };
}): Promise<Metadata> {
  const stateCode = STATE_CODES[params.state];
  const stateName = STATE_NAMES[params.state];
  if (!stateCode || !stateName) return {};

  const municipioName = unslugify(params.city);
  const bairroName = unslugify(params.bairro);

  const cityTitle = municipioName.toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase());
  const bairroTitle = bairroName.toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase());

  const data = await fetchLocationStats(stateCode, municipioName, bairroName);
  const total = data?.total ? data.total.toLocaleString('pt-BR') : 'milhares de';

  return {
    title: `Criminalidade em ${bairroTitle}, ${cityTitle} — Estatísticas por Bairro`,
    description: `Dados de criminalidade do bairro ${bairroTitle} em ${cityTitle}, ${stateName}: ${total} ocorrências registradas. Veja a taxa por 100 mil habitantes.`,
    alternates: {
      canonical: `https://crimebrasil.com.br/bairro/${params.state}/${params.city}/${params.bairro}`,
    },
    openGraph: {
      title: `Criminalidade em ${bairroTitle}, ${cityTitle} — Crime Brasil`,
      description: `${total} ocorrências registradas no bairro ${bairroTitle}, ${cityTitle}, ${stateName}.`,
      url: `https://crimebrasil.com.br/bairro/${params.state}/${params.city}/${params.bairro}`,
    },
  };
}

function formatNum(n: number) {
  return n.toLocaleString('pt-BR');
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: '#131c2e', border: '1px solid #1e2d45', borderRadius: '0.75rem', padding: '1.25rem' }}>
      <p style={{ color: '#64748b', fontSize: '0.75rem', marginBottom: '0.375rem' }}>{label}</p>
      <p style={{ fontSize: '1.5rem', fontWeight: 700, color: '#e2e8f0' }}>{value}</p>
    </div>
  );
}

export default async function BairroPage({
  params,
}: {
  params: { state: string; city: string; bairro: string };
}) {
  const stateCode = STATE_CODES[params.state];
  const stateName = STATE_NAMES[params.state];

  if (!stateCode || !stateName) {
    return <div style={{ color: '#fff', padding: '2rem' }}>Bairro não encontrado.</div>;
  }

  const municipioName = unslugify(params.city);
  const bairroName = unslugify(params.bairro);

  const cityTitle = municipioName.toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase());
  const bairroTitle = bairroName.toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase());

  const data = await fetchLocationStats(stateCode, municipioName, bairroName);

  const topTypes: { tipo_enquadramento: string; count: number }[] = data?.crime_types?.slice(0, 10) ?? [];
  const population: number | null = data?.population ?? null;
  const total: number = data?.total ?? 0;
  const rate = population && total ? Math.round((total / population) * 100000) : null;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Crime Brasil', item: 'https://crimebrasil.com.br' },
          { '@type': 'ListItem', position: 2, name: stateName, item: `https://crimebrasil.com.br/estado/${STATE_SLUGS_FULL[params.state]}` },
          { '@type': 'ListItem', position: 3, name: cityTitle, item: `https://crimebrasil.com.br/cidade/${params.state}/${params.city}` },
          { '@type': 'ListItem', position: 4, name: bairroTitle, item: `https://crimebrasil.com.br/bairro/${params.state}/${params.city}/${params.bairro}` },
        ],
      },
      {
        '@type': 'Dataset',
        name: `Criminalidade no bairro ${bairroTitle}, ${cityTitle}`,
        description: `Dados de criminalidade do bairro ${bairroTitle} em ${cityTitle}, ${stateName}.`,
        url: `https://crimebrasil.com.br/bairro/${params.state}/${params.city}/${params.bairro}`,
        spatialCoverage: { '@type': 'Place', name: `${bairroTitle}, ${cityTitle}`, address: { '@type': 'PostalAddress', addressLocality: cityTitle, addressRegion: stateCode, addressCountry: 'BR' } },
      },
    ],
  };

  return (
    <>
      <JsonLd data={jsonLd} />
      <div style={{ minHeight: '100vh', background: '#0a0f1a', color: '#e2e8f0', fontFamily: "'DM Sans', sans-serif", padding: '2rem 1rem' }}>
        <div style={{ maxWidth: '800px', margin: '0 auto' }}>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
            <Link href="/" style={{ color: '#64748b', textDecoration: 'none', fontSize: '0.875rem' }}>← Crime Brasil</Link>
            <Link href={`/estado/${STATE_SLUGS_FULL[params.state]}`} style={{ color: '#64748b', textDecoration: 'none', fontSize: '0.875rem' }}>{stateName}</Link>
            <Link href={`/cidade/${params.state}/${params.city}`} style={{ color: '#64748b', textDecoration: 'none', fontSize: '0.875rem' }}>{cityTitle}</Link>
          </div>

          <h1 style={{ fontSize: 'clamp(1.5rem, 4vw, 2.5rem)', fontWeight: 700, marginBottom: '0.5rem', lineHeight: 1.2 }}>
            Criminalidade em {bairroTitle}
          </h1>
          <p style={{ color: '#94a3b8', marginBottom: '2rem' }}>
            {cityTitle} · {stateName} · Dados oficiais de segurança pública · Crime Brasil
          </p>

          <MapRedirect panelType="bairro" state={stateCode} municipio={municipioName} bairro={bairroName} />
          <FilterBanner panelType="bairro" state={stateCode} municipio={municipioName} bairro={bairroName} />

          {data && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
              <StatCard label="Total de ocorrências" value={formatNum(total)} />
              {population && <StatCard label="População do bairro" value={formatNum(population)} />}
              {rate && <StatCard label="Taxa por 100 mil hab." value={formatNum(rate)} />}
            </div>
          )}

          {topTypes.length > 0 && (
            <section style={{ marginBottom: '2rem' }}>
              <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem', color: '#cbd5e1' }}>
                Principais tipos de crime
              </h2>
              <div style={{ background: '#131c2e', borderRadius: '0.75rem', overflow: 'hidden', border: '1px solid #1e2d45' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#0d1526' }}>
                      <th style={{ padding: '0.75rem 1rem', textAlign: 'left', fontSize: '0.75rem', color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tipo</th>
                      <th style={{ padding: '0.75rem 1rem', textAlign: 'right', fontSize: '0.75rem', color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ocorrências</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topTypes.map((t, i) => (
                      <tr key={i} style={{ borderTop: '1px solid #1e2d45', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                        <td style={{ padding: '0.625rem 1rem', fontSize: '0.875rem' }}>{t.tipo_enquadramento}</td>
                        <td style={{ padding: '0.625rem 1rem', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#93c5fd' }}>{formatNum(t.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <MapLinkButton panelType="bairro" state={stateCode} municipio={municipioName} bairro={bairroName} description="Explore dados completos do bairro no mapa interativo" />

          <p style={{ color: '#475569', fontSize: '0.75rem', textAlign: 'center' }}>
            Dados oficiais: SSP/{stateCode} · Crime Brasil ·{' '}
            <Link href="/" style={{ color: '#60a5fa', textDecoration: 'none' }}>crimebrasil.com.br</Link>
          </p>
        </div>
      </div>
    </>
  );
}
