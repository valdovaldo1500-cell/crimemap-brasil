import type { Metadata } from 'next';
import Link from 'next/link';
import JsonLd from '@/components/JsonLd';
import FilterBanner from '@/components/FilterBanner';

const API_BASE = 'https://crimebrasil.com.br';

const STATE_MAP: Record<string, { code: string; fullName: string }> = {
  'rio-grande-do-sul': { code: 'RS', fullName: 'Rio Grande do Sul' },
  'rio-de-janeiro': { code: 'RJ', fullName: 'Rio de Janeiro' },
  'minas-gerais': { code: 'MG', fullName: 'Minas Gerais' },
};

export function generateStaticParams() {
  return Object.keys(STATE_MAP).map((slug) => ({ slug }));
}

// ISR: generate on first request, revalidate every 24h
export const revalidate = 86400;

async function fetchStateStats(stateCode: string) {
  try {
    const res = await fetch(`${API_BASE}/api/state-stats?state=${stateCode}`, {
      next: { revalidate: 86400 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const state = STATE_MAP[params.slug];
  if (!state) return {};
  const data = await fetchStateStats(state.code);
  const total = data?.total ? data.total.toLocaleString('pt-BR') : 'milhares de';
  return {
    title: `Criminalidade em ${state.fullName} — Dados e Estatísticas`,
    description: `Veja dados de criminalidade de ${state.fullName}: ${total} ocorrências registradas, principais tipos de crime e municípios mais afetados.`,
    alternates: {
      canonical: `https://crimebrasil.com.br/estado/${params.slug}`,
    },
    openGraph: {
      title: `Criminalidade em ${state.fullName} — Crime Brasil`,
      description: `Dados de criminalidade de ${state.fullName}: ${total} ocorrências registradas.`,
      url: `https://crimebrasil.com.br/estado/${params.slug}`,
    },
  };
}

function formatNum(n: number) {
  return n.toLocaleString('pt-BR');
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: '#131c2e',
        border: '1px solid #1e2d45',
        borderRadius: '0.75rem',
        padding: '1.25rem',
      }}
    >
      <p style={{ color: '#64748b', fontSize: '0.75rem', marginBottom: '0.375rem' }}>{label}</p>
      <p style={{ fontSize: '1.5rem', fontWeight: 700, color: '#e2e8f0' }}>{value}</p>
    </div>
  );
}

export default async function EstadoPage({ params }: { params: { slug: string } }) {
  const state = STATE_MAP[params.slug];
  if (!state) {
    return <div style={{ color: '#fff', padding: '2rem' }}>Estado não encontrado.</div>;
  }

  const data = await fetchStateStats(state.code);
  const topTypes: { tipo_enquadramento: string; count: number }[] =
    data?.crime_types?.slice(0, 10) ?? [];
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
          { '@type': 'ListItem', position: 2, name: state.fullName, item: `https://crimebrasil.com.br/estado/${params.slug}` },
        ],
      },
      {
        '@type': 'Dataset',
        name: `Criminalidade em ${state.fullName}`,
        description: `Dados de criminalidade do estado de ${state.fullName}: ocorrências registradas, tipos de crime e municípios mais afetados.`,
        url: `https://crimebrasil.com.br/estado/${params.slug}`,
        spatialCoverage: { '@type': 'Place', name: state.fullName, address: { '@type': 'PostalAddress', addressRegion: state.code, addressCountry: 'BR' } },
        ...(total ? { measurementTechnique: 'Dados oficiais SSP/' + state.code } : {}),
      },
    ],
  };

  return (
    <>
      <JsonLd data={jsonLd} />
    <div
      style={{
        minHeight: '100vh',
        background: '#0a0f1a',
        color: '#e2e8f0',
        fontFamily: "'DM Sans', sans-serif",
        padding: '2rem 1rem',
      }}
    >
      <div style={{ maxWidth: '800px', margin: '0 auto' }}>
        <Link
          href="/"
          style={{
            color: '#64748b',
            textDecoration: 'none',
            fontSize: '0.875rem',
            display: 'inline-block',
            marginBottom: '1.5rem',
          }}
        >
          ← Crime Brasil
        </Link>

        <h1
          style={{
            fontSize: 'clamp(1.5rem, 4vw, 2.5rem)',
            fontWeight: 700,
            marginBottom: '0.5rem',
            lineHeight: 1.2,
          }}
        >
          Criminalidade em {state.fullName}
        </h1>
        <p style={{ color: '#94a3b8', marginBottom: '2rem' }}>
          Dados oficiais de segurança pública · Crime Brasil
        </p>

        <FilterBanner panelType="state" state={state.code} />

        {data && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: '1rem',
              marginBottom: '2rem',
            }}
          >
            <StatCard label="Total de ocorrências" value={formatNum(total)} />
            {population && <StatCard label="População" value={formatNum(population)} />}
            {rate && <StatCard label="Taxa por 100 mil hab." value={formatNum(rate)} />}
          </div>
        )}

        {topTypes.length > 0 && (
          <section style={{ marginBottom: '2rem' }}>
            <h2
              style={{
                fontSize: '1.25rem',
                fontWeight: 600,
                marginBottom: '1rem',
                color: '#cbd5e1',
              }}
            >
              Principais tipos de crime
            </h2>
            <div
              style={{
                background: '#131c2e',
                borderRadius: '0.75rem',
                overflow: 'hidden',
                border: '1px solid #1e2d45',
              }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#0d1526' }}>
                    <th
                      style={{
                        padding: '0.75rem 1rem',
                        textAlign: 'left',
                        fontSize: '0.75rem',
                        color: '#64748b',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      Tipo
                    </th>
                    <th
                      style={{
                        padding: '0.75rem 1rem',
                        textAlign: 'right',
                        fontSize: '0.75rem',
                        color: '#64748b',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                      }}
                    >
                      Ocorrências
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {topTypes.map((t, i) => (
                    <tr
                      key={i}
                      style={{
                        borderTop: '1px solid #1e2d45',
                        background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
                      }}
                    >
                      <td style={{ padding: '0.625rem 1rem', fontSize: '0.875rem' }}>
                        {t.tipo_enquadramento}
                      </td>
                      <td
                        style={{
                          padding: '0.625rem 1rem',
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          color: '#93c5fd',
                        }}
                      >
                        {formatNum(t.count)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <div
          style={{
            background: 'linear-gradient(135deg, #1e3a5f 0%, #1a2744 100%)',
            borderRadius: '1rem',
            padding: '2rem',
            textAlign: 'center',
            border: '1px solid #2563eb33',
            marginBottom: '2rem',
          }}
        >
          <p style={{ color: '#93c5fd', marginBottom: '1rem', fontSize: '1rem' }}>
            Explore dados por cidade e bairro no mapa interativo
          </p>
          <Link
            href={`/?state=${state.code}`}
            style={{
              display: 'inline-block',
              background: '#2563eb',
              color: '#fff',
              padding: '0.75rem 2rem',
              borderRadius: '0.5rem',
              textDecoration: 'none',
              fontWeight: 600,
              fontSize: '1rem',
            }}
          >
            Ver no mapa interativo →
          </Link>
        </div>

        <p style={{ color: '#475569', fontSize: '0.75rem', textAlign: 'center' }}>
          Dados oficiais: SSP/{state.code} · Crime Brasil ·{' '}
          <Link href="/" style={{ color: '#60a5fa', textDecoration: 'none' }}>
            crimebrasil.com.br
          </Link>
        </p>
      </div>
    </div>
    </>
  );
}
