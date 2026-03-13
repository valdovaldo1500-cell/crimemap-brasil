import { MetadataRoute } from 'next';

export const dynamic = 'force-dynamic';

const API_BASE = 'https://crimebrasil.com.br';

type SeoMunicipality = {
  state_lower: string;
  slug: string;
};

async function fetchSeoMunicipalities(): Promise<SeoMunicipality[]> {
  try {
    const res = await fetch(`${API_BASE}/api/seo/municipalities`, { cache: 'force-cache' });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const munis = await fetchSeoMunicipalities();

  const statePages: MetadataRoute.Sitemap = [
    'rio-grande-do-sul',
    'rio-de-janeiro',
    'minas-gerais',
  ].map((slug) => ({
    url: `${API_BASE}/estado/${slug}`,
    lastModified: new Date(),
    changeFrequency: 'monthly' as const,
    priority: 0.8,
  }));

  const cityPages: MetadataRoute.Sitemap = munis.map((m) => ({
    url: `${API_BASE}/cidade/${m.state_lower}/${m.slug}`,
    lastModified: new Date(),
    changeFrequency: 'monthly' as const,
    priority: 0.7,
  }));

  return [
    {
      url: API_BASE,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
    ...statePages,
    ...cityPages,
  ];
}
