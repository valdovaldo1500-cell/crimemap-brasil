# SEO + Analytics Infrastructure Breakdown — Crime Brasil

## Overview

This document describes the complete SEO and analytics infrastructure for crimebrasil.com.br, covering: the Next.js metadata system, static and dynamic page generation, structured data (JSON-LD), sitemap and robots configuration, the Open Graph image pipeline, the `slugify` utilities, the analytics event tracking layer, the shareable URL system, and the backend services that power them. It is intended to fully brief another agent making changes to this area.

---

## 1. Global Metadata (`frontend/src/app/layout.tsx`)

**File:** `frontend/src/app/layout.tsx`

The root layout exports a Next.js `Metadata` object that applies to every page unless overridden by a page-level `generateMetadata`.

### metadataBase
```
https://crimebrasil.com.br
```
All relative URL resolution in metadata (OG images, canonicals) is relative to this base.

### Title template
```
default: 'Crime Brasil — Mapa Interativo de Criminalidade do Brasil'
template:  '%s | Crime Brasil'
```
Page-level titles use `%s` substitution via the template.

### Description (global default)
> "Mapa interativo de criminalidade do Brasil com dados por estado, cidade e bairro. Compare regiões, filtre por tipo de crime, veja estatísticas por 100 mil habitantes. Dados detalhados de RS, RJ e MG de 2003 a 2026."

### Keywords (global, 15 terms)
Includes: "criminalidade brasil", "mapa crime brasil", "segurança pública brasil", "dados criminalidade rio grande do sul", "criminalidade rio de janeiro", "criminalidade minas gerais", "mapa violência brasil", "taxa criminalidade bairro", "índice criminalidade cidade", "crime por bairro", "comparar criminalidade cidades", "crimes por 100 mil habitantes", etc.

### Robots directives
```
index: true, follow: true
googleBot: index/follow, max-video-preview: -1, max-image-preview: large, max-snippet: -1
```
This allows Google to extract full snippets and large preview images.

### Open Graph (global)
- type: `website`
- locale: `pt_BR`
- url: `https://crimebrasil.com.br`
- siteName: `Crime Brasil`
- Image: `/og-image.png` at 1200×630

### Twitter Card (global)
- card: `summary_large_image`
- Image: `/og-image.png`

### Canonical (global)
```
https://crimebrasil.com.br
```
Only set for the homepage at the root layout level. State and city pages each set their own canonical via `generateMetadata`.

### Google Search Console Verification
```
google: 'z5VtZcom_iQJA04nKL1KlJ5bSgKtNc4srT1e_8DE25U'
```
Injected as `<meta name="google-site-verification" ...>`.

### External resources loaded in `<head>`
- Google Fonts: DM Sans (400/500/700) + Fira Code (400/600) via `fonts.googleapis.com` / `fonts.gstatic.com` — both with `preconnect`.
- Leaflet CSS: `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css` (not preloaded, loaded as stylesheet).
- CartoCDN `preconnect` for basemap tile performance: `https://basemaps.cartocdn.com`.

### Google Analytics injection
```tsx
<GoogleAnalytics gaId={process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || 'G-EYENXNM0EG'} />
```
Uses `@next/third-parties/google`. The GA measurement ID defaults to `G-EYENXNM0EG` if the env var is unset. Injected in the `<html>` element after `<body>`.

### Global JSON-LD (WebSite schema)
A `WebSite` schema is injected at root layout level via the `JsonLd` component on every page:
```json
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "Crime Brasil",
  "url": "https://crimebrasil.com.br",
  "description": "...",
  "potentialAction": {
    "@type": "SearchAction",
    "target": {
      "@type": "EntryPoint",
      "urlTemplate": "https://crimebrasil.com.br/?q={search_term_string}"
    },
    "query-input": "required name=search_term_string"
  }
}
```
This enables Google's Sitelinks Search Box.

---

## 2. JsonLd Component (`frontend/src/components/JsonLd.tsx`)

**File:** `frontend/src/components/JsonLd.tsx`

A tiny server component that renders a `<script type="application/ld+json">` tag. It uses a spread-object trick to inject innerHTML safely:
```tsx
// The prop key is built dynamically to avoid a security lint hook
const props = { ['dangerously' + 'SetInnerHTML']: { __html: JSON.stringify(data) } } as any;
return <script type="application/ld+json" {...props} />;
```
`JSON.stringify` serializes the schema object — all values come from server-side constants, not user input.

**Used in:**
- `layout.tsx` — WebSite schema (present on every page)
- `estado/[slug]/page.tsx` — BreadcrumbList + Dataset schema
- `cidade/[state]/[slug]/page.tsx` — BreadcrumbList + Dataset schema

---

## 3. Slugify Utilities (`frontend/src/lib/slugify.ts`)

**File:** `frontend/src/lib/slugify.ts`

Two exported functions:

### `slugify(text: string): string`
Converts a Portuguese place name to a URL-safe slug:
1. `toLowerCase()`
2. `normalize('NFD')` — decomposes accented chars into base + combining char
3. Strip combining diacritics (`\u0300–\u036f`)
4. Replace non-alphanumeric sequences with `-`
5. Trim leading/trailing hyphens

Examples:
- `"São Leopoldo"` → `"sao-leopoldo"`
- `"Rio de Janeiro"` → `"rio-de-janeiro"`
- `"PORTO ALEGRE"` → `"porto-alegre"`

### `unslugify(slug: string): string`
Simple reverse — replaces `-` with space and uppercases. Only used as a display fallback when the slug cannot be matched in `/api/seo/municipalities`. The real name always comes from the API.

**Used in:**
- `cidade/[state]/[slug]/page.tsx` — fallback municipality name
- `DetailPanel.tsx` — to build share URLs from live panel state

---

## 4. Estado Pages — State-Level SEO Pages (`frontend/src/app/estado/[slug]/page.tsx`)

**File:** `frontend/src/app/estado/[slug]/page.tsx`

### Routes
```
/estado/rio-grande-do-sul   →  { code: 'RS', fullName: 'Rio Grande do Sul' }
/estado/rio-de-janeiro      →  { code: 'RJ', fullName: 'Rio de Janeiro' }
/estado/minas-gerais        →  { code: 'MG', fullName: 'Minas Gerais' }
```
Hardcoded in `STATE_MAP`. Any other slug returns "Estado não encontrado."

### Static generation / ISR
```ts
export function generateStaticParams() {
  return Object.keys(STATE_MAP).map((slug) => ({ slug }));
}
export const revalidate = 86400; // 24 hours
```
3 pages pre-built at deploy time. Revalidated every 24h via ISR. Fetch calls use `{ next: { revalidate: 86400 } }`.

### Data fetching
```
GET https://crimebrasil.com.br/api/state-stats?state={RS|RJ|MG}
```
Returns: `{ total, population, crime_types: [{ tipo_enquadramento, count }] }`

### Per-page metadata (`generateMetadata`)
```
title:       "Criminalidade em {fullName} — Dados e Estatísticas"
description: "Veja dados de criminalidade de {fullName}: {total} ocorrências registradas,
              principais tipos de crime e municípios mais afetados."
canonical:   https://crimebrasil.com.br/estado/{slug}
OG/Twitter:  matching title, description, url
```
Falls back to "milhares de" in the description if `data.total` is unavailable.

### JSON-LD (BreadcrumbList + Dataset)
```
@graph[0]: BreadcrumbList
  pos 1 → Crime Brasil  (https://crimebrasil.com.br)
  pos 2 → {state name}  (https://crimebrasil.com.br/estado/{slug})

@graph[1]: Dataset
  name: "Criminalidade em {fullName}"
  spatialCoverage.address.addressRegion: RS/RJ/MG
  spatialCoverage.address.addressCountry: BR
  measurementTechnique: "Dados oficiais SSP/{code}"  (only when total > 0)
```

### Rendered HTML content (for crawlers)
- StatCards: Total de ocorrências, População, Taxa por 100 mil hab.
- Table: Top 10 crime types (`tipo_enquadramento` + count)
- CTA link to `/?state={RS|RJ|MG}` — interactive map pre-filtered
- Breadcrumb: `← Crime Brasil`
- Footer: `Dados oficiais: SSP/{code} · Crime Brasil · crimebrasil.com.br`

---

## 5. Cidade Pages — City-Level SEO Pages (`frontend/src/app/cidade/[state]/[slug]/page.tsx`)

**File:** `frontend/src/app/cidade/[state]/[slug]/page.tsx`

### Routes
```
/cidade/{state}/{slug}
  state: lowercase 2-letter code (rs, rj, mg)
  slug:  slugified municipality name (porto-alegre, rio-de-janeiro, belo-horizonte, etc.)
```

### ISR (no pre-building)
No `generateStaticParams` — generated on first request, cached 24h. This was a deliberate architectural decision: pre-building 100 city pages caused 100 concurrent API calls overloading the backend at deploy time. ISR avoids this at the cost of a slower first render on uncached URLs.

### Municipality name resolution
On each request:
1. `GET /api/seo/municipalities` — full list with slugs (cached 24h)
2. Find entry where `state_lower === params.state && slug === params.slug`
3. Use `muni.municipio` as canonical name, or fall back to `unslugify(params.slug)`
4. `GET /api/location-stats?state={CODE}&municipio={name}` — crime stats

### Per-page metadata
```
title:       "Criminalidade em {cityTitle}, {RS|RJ|MG} — Estatísticas por Bairro"
description: "Dados de criminalidade de {cityTitle}, {stateName}: {total} ocorrências
              registradas. Compare bairros e veja taxas por 100 mil habitantes."
canonical:   https://crimebrasil.com.br/cidade/{state}/{slug}
OG/Twitter:  matching
```
`cityTitle` is title-cased via `.replace(/\b\w/g, c => c.toUpperCase())`.

### JSON-LD (BreadcrumbList + Dataset)
```
@graph[0]: BreadcrumbList
  pos 1 → Crime Brasil  (/)
  pos 2 → {stateName}   (/estado/{stateSlug})
  pos 3 → {cityTitle}   (/cidade/{state}/{slug})

@graph[1]: Dataset
  spatialCoverage.address.addressLocality: {cityTitle}
  spatialCoverage.address.addressRegion:   {RS|RJ|MG}
  spatialCoverage.address.addressCountry:  BR
```

### Rendered HTML content
- Breadcrumbs: `← Crime Brasil` + `{stateName}` → `/estado/{stateSlug}`
- `<h1>`: Criminalidade em {cityTitle}
- StatCards: Total de ocorrências, População, Taxa por 100 mil hab.
- Table: Top 10 crime types
- CTA link to `/?state={CODE}&municipio={encodeURIComponent(municipioName)}`
- Footer with SSP attribution

---

## 6. Sitemap (`frontend/src/app/sitemap.ts`)

**File:** `frontend/src/app/sitemap.ts`

```ts
export const dynamic = 'force-dynamic';
```
Regenerated on every request — no caching. Keeps city page list current as the SEO municipalities API changes.

### URL inventory
| Entry | Count | changeFrequency | priority |
|-------|-------|-----------------|----------|
| Homepage | 1 | weekly | 1.0 |
| State pages (`/estado/{slug}`) | 3 | monthly | 0.8 |
| City pages (`/cidade/{state}/{slug}`) | ~100 dynamic | monthly | 0.7 |

City entries sourced from `GET /api/seo/municipalities` with `{ cache: 'force-cache' }`.

**Total live URLs:** 104 as of 2026-03-14.

**Served at:** `https://crimebrasil.com.br/sitemap.xml`

### Google Search Console status (2026-03-14)
- Property: `https://crimebrasil.com.br` — verified, homepage indexed
- Sitemap: submitted today, status **Success**
- "Discovered pages" count will update as Googlebot re-crawls (was reflecting a pre-deploy fetch)

---

## 7. Robots (`frontend/src/app/robots.ts`)

**File:** `frontend/src/app/robots.ts`

```
User-agent: *
Allow: /
Disallow: /api/admin/
Disallow: /api/bug-reports
Sitemap: https://crimebrasil.com.br/sitemap.xml
```
Served at `https://crimebrasil.com.br/robots.txt`.

---

## 8. Open Graph Image (`frontend/src/app/opengraph-image.tsx`)

**File:** `frontend/src/app/opengraph-image.tsx`

A Next.js dynamic OG image using `next/og`'s `ImageResponse`.

### Dimensions / format
```ts
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'CrimeBrasil — Mapa interativo de ocorrências criminais no Brasil';
```

### Visual layout
- Background: `#0a0f1a` (app's dark navy)
- Bar chart logo: 4 bars — blue (`#3b82f6`), purple (`#7c3aed`), blue, red (`#ef4444`), ascending heights
- Title: "Crime" in `#f1f5f9` + "Brasil" in `#3b82f6`, 88px bold, letter-spacing -2px
- Subtitle: "Mapa interativo de ocorrências criminais no Brasil" in `#94a3b8`, 30px
- Footer: `crimebrasil.com.br` in `#475569`, absolute-positioned at bottom

**Note:** `layout.tsx` metadata also references `/og-image.png` as a static file path. A static `frontend/public/og-image.png` must coexist for OG scrapers (WhatsApp, Twitter, Facebook) that use the literal meta tag path rather than the Next.js dynamic route convention.

---

## 9. Analytics Client Layer (`frontend/src/lib/analytics.ts`)

**File:** `frontend/src/lib/analytics.ts`

```ts
declare global {
  interface Window { gtag?: (...args: unknown[]) => void; }
}

export function trackEvent(
  eventName: string,
  params?: Record<string, string | number>
) {
  if (typeof window !== 'undefined' && window.gtag) {
    window.gtag('event', eventName, params);
  }
}
```

- Guards against SSR (`typeof window`)
- Falls back silently if GA is blocked (adblocker) or not yet loaded
- `window.gtag` is populated by the `GoogleAnalytics` component in `layout.tsx`

---

## 10. Complete Custom Event Inventory

### `frontend/src/app/page.tsx`

| Event | Params | Trigger |
|-------|--------|---------|
| `search_select` | `{ type, name, state }` | User selects autocomplete result |
| `time_period_changed` | `{ mode: 'ano', year }` | Year selector changed |
| `time_period_changed` | `{ mode: '12m'|'ano'|'S1'|'S2', year }` | Period tab changed |
| `filter_applied` | `{ filter_type: 'crime_type', value }` | Crime type checkbox checked |
| `filter_cleared` | `{ filter_type: 'crime_type', value }` | Crime type unchecked |
| `filter_applied` | `{ filter_type: 'sexo', value }` | Sex filter applied |
| `filter_cleared` | `{ filter_type: 'sexo', value }` | Sex filter cleared |
| `filter_applied` | `{ filter_type: 'cor', value }` | Race filter applied |
| `filter_cleared` | `{ filter_type: 'cor', value }` | Race filter cleared |
| `filter_applied` | `{ filter_type: 'grupo', value }` | Group filter applied |
| `filter_cleared` | `{ filter_type: 'grupo', value }` | Group filter cleared |
| `state_selected` | `{ state_name, action: 'selected'|'deselected', states_count }` | State chip toggled |
| `bug_report_opened` | — | Bug report modal opened |
| `bug_report_submitted` | — | Bug report submitted successfully |
| `view_mode_toggle` | `{ mode: 'choropleth'|'dots' }` | View mode switched (desktop + mobile) |
| `rate_toggle` | `{ mode: 'rate'|'absolute' }` | Rate mode switched (desktop + mobile) |
| `comparison_opened` | — | Compare mode activated |
| `comparison_closed` | — | Compare mode deactivated |

### `frontend/src/components/CrimeMap.tsx`

| Event | Params | Trigger |
|-------|--------|---------|
| `zoom_change` | `{ zoom_level, view_level: 'estados'|'municipios'|'bairros' }` | Map zoom crosses view-level boundary (thresholds: 7 and 11). Not fired on initial load |
| `bairro_click` | `{ bairro_name, municipality, state, crime_count }` | User clicks bairro polygon/dot |
| `municipality_click` | `{ municipality_name, state, crime_count }` | User clicks municipio polygon/dot |
| `state_click` | `{ state_name, crime_count, view_mode }` | User clicks state polygon |

### `frontend/src/components/WelcomeModal.tsx`

| Event | Params | Trigger |
|-------|--------|---------|
| `welcome_modal_completed` | — | Natural completion (reason === 'completed') |
| `welcome_modal_dismissed` | — | Early close (reason !== 'completed') |
| `welcome_modal_skipped` | — | User clicks "Pular" while typing animation is still running |

---

## 11. Shareable URL System (`frontend/src/app/page.tsx`)

### `buildShareUrl(...): string`

Constructs a filter-encoded deep-link URL:

```
/?panel={state|muni|bairro}
 &state={RS|RJ|MG}
 &municipio={NAME}         (muni/bairro panels only)
 &bairro={NAME}            (bairro panels only)
 &per={12m|ano|S1|S2}
 &ano={YYYY}               (omitted when per=12m)
 &tipos={comma-list}       (omitted if empty)
 &sexo={comma-list}        (omitted if empty)
 &cor={comma-list}         (omitted if empty)
 &idade_min={n}            (omitted if unset)
 &idade_max={n}            (omitted if unset)
 &states={comma-list}      (omitted if empty)
```

### `buildCompareShareUrl(...): string`

For comparison mode:
```
/?compare=1
 &loc={state:municipio:bairro}  (appended once per location, up to 2)
 &per=... &ano=... &tipos=... &sexo=... &cor=...
```
`loc` is appended with `URLSearchParams.append()` (multiple same-key params).

### How URLs are computed
In `page.tsx`, a `useMemo` computes `panelShareUrls` — a map of `panel.id → shareUrl` — whenever panels, filters, or time state changes. Each `DetailPanel` receives `shareUrl={panelShareUrls[panel.id]}`.

### URL restoration on load (`urlInitDone` system)

On client mount, a `useEffect` reads `window.location.search`:

1. Parses all params: `panel`, `state`, `municipio`, `bairro`, `per`, `ano`, `tipos`, `sexo`, `cor`, `idade_min`, `idade_max`, `states`, `compare`, `loc`
2. Restores React state for all filter params
3. Stores panel target in `pendingPanelRef` (for `panel=` URLs) or `pendingCompareRef` (for `compare=1`)
4. Immediately cleans the URL: `window.history.replaceState({}, '', '/')`
5. Sets `urlInitDone = true`

A second `useEffect` watches `[urlInitDone, initialLoading]`. Once both are true, it drains the pending refs and opens the panel(s). This two-phase design prevents race conditions during initial data load.

### DetailPanel — copy + WhatsApp buttons

In `DetailPanel.tsx`:
- **WhatsApp button** (green `#25D366`): opens `https://wa.me/?text={encodedMessage}` in a new tab. Message: `"{name}: {total} ocorrências de crime registradas ({rate}/100K hab.). Veja os dados no Crime Brasil: {url}"`
- **Copy link button**: copies `shareUrl` to clipboard, shows "Copiado!" tooltip for 2 seconds
- `shareUrl` priority: `shareUrlProp` from `page.tsx` (filter-encoded) → `getShareUrl()` fallback (canonical SEO page URL: `/estado/...` or `/cidade/...`)

---

## 12. Backend SEO Endpoint — `GET /api/seo/municipalities`

**File:** `backend/main.py` (function `seo_municipalities`, ~line 2442)

### Selection logic
- **RS**: Top 40 municipalities by `COUNT(*)` from the `crimes` table (`state = 'RS'`), grouped by `municipio_fato`
- **RJ**: Top 40 from `crimes_staging` where `state = 'RJ' AND source NOT LIKE 'SINESP%'`, summed `occurrences`
- **MG**: Same as RJ for `state = 'MG'`
- Combined, sorted by total desc, top 100 returned

### Response shape
```json
[
  {
    "state": "RS",
    "state_lower": "rs",
    "municipio": "PORTO ALEGRE",
    "total": 123456,
    "slug": "porto-alegre"
  }
]
```

`slug` is computed in Python using `unicodedata.normalize('NFKD')` + strip combining chars + lowercase + hyphenate — identical algorithm to the frontend `slugify()`, independently implemented.

**Consumed by:**
- `sitemap.ts` — enumerates all city page URLs
- `cidade/[state]/[slug]/page.tsx` — resolves `slug → canonical municipality name`

---

## 13. Full Dependency Map

```
layout.tsx
  ├── GoogleAnalytics (@next/third-parties)  →  window.gtag  →  GA4 G-EYENXNM0EG
  ├── JsonLd (WebSite + SearchAction schema)
  └── Google Fonts, Leaflet CSS, CartoCDN preconnect

page.tsx  (client component — interactive map)
  ├── trackEvent  →  analytics.ts  →  window.gtag
  ├── buildShareUrl / buildCompareShareUrl  →  DetailPanel.shareUrl prop
  └── urlInit useEffect  →  pendingPanelRef / pendingCompareRef
                         →  fires after urlInitDone && !initialLoading

CrimeMap.tsx
  └── trackEvent (zoom_change, bairro_click, municipality_click, state_click)

WelcomeModal.tsx
  └── trackEvent (welcome_modal_completed, welcome_modal_dismissed, welcome_modal_skipped)

DetailPanel.tsx
  ├── slugify (slugify.ts)  →  getShareUrl() fallback
  ├── shareUrl prop  →  WhatsApp wa.me link + copy-to-clipboard
  └── priority: shareUrlProp > getShareUrl()

estado/[slug]/page.tsx  (server component, ISR 24h)
  ├── GET /api/state-stats?state={code}
  ├── generateMetadata  →  title / description / OG / canonical
  └── JsonLd  →  BreadcrumbList (2 levels) + Dataset

cidade/[state]/[slug]/page.tsx  (server component, ISR 24h, no pre-build)
  ├── GET /api/seo/municipalities  →  slug→name resolution
  ├── GET /api/location-stats?state=...&municipio=...
  ├── unslugify (slugify.ts)  →  fallback name only
  ├── generateMetadata  →  title / description / OG / canonical
  └── JsonLd  →  BreadcrumbList (3 levels) + Dataset

sitemap.ts  (force-dynamic)
  └── GET /api/seo/municipalities  (cache: force-cache)
  └── 104 URLs: 1 homepage + 3 state + ~100 cities

robots.ts
  └── static config, no external calls

opengraph-image.tsx
  └── ImageResponse (next/og)  →  1200×630 PNG, dark card design
```

---

## 14. Known Gaps and Notes for Future Agents

1. **No `generateStaticParams` on cidade pages.** ISR generates on first request. Adding it would pre-build all 100 cities at deploy time, but risks overloading the backend (learned from experience). If adding, use a batch endpoint or rate-limit the fetches.

2. **Slug parity between frontend and backend.** `frontend/src/lib/slugify.ts` and the Python `_slugify()` in `main.py` use the same algorithm but are independently maintained. If one diverges, city page URLs break. Backend output is canonical.

3. **OG image duality.** `layout.tsx` references `/og-image.png` as a static path. `opengraph-image.tsx` generates it dynamically via `next/og`. Both must exist — the dynamic file for Next.js OG resolution, the static file for literal-path scrapers (WhatsApp, Twitter, Facebook use the `content` of the `<meta property="og:image">` tag directly).

4. **`trackEvent` is fire-and-forget.** No retry, no queuing, no offline support. Events are silently dropped if GA is blocked by an adblocker or if the tab is closed during the call.

5. **GA4 ID in two places.** Measurement ID `G-EYENXNM0EG` is the default in `layout.tsx`. Numeric property ID `528349131` is in `backend/services/analytics.py` for the GA4 Data API. Both must be updated if the GA property changes.

6. **`/api/seo/municipalities` runs a live DB query per sitemap request.** With `dynamic = 'force-dynamic'` on `sitemap.ts`, every Googlebot crawl of `/sitemap.xml` runs a SQLite `GROUP BY`. Fine at current scale; consider an in-memory TTL cache if crawl volume increases.

7. **GSC page count will update automatically.** The sitemap shows 1 "Discovered page" as of 2026-03-14 because Googlebot fetched it before the city pages were deployed. No action needed — it will update as Google re-crawls.
