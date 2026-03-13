import type { Metadata } from 'next';
import { GoogleAnalytics } from '@next/third-parties/google';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://crimebrasil.com.br'),
  title: {
    default: 'Crime Brasil — Mapa Interativo de Criminalidade do Brasil',
    template: '%s | Crime Brasil',
  },
  description:
    'Mapa interativo de criminalidade do Brasil com dados por estado, cidade e bairro. Compare regiões, filtre por tipo de crime, veja estatísticas por 100 mil habitantes. Dados detalhados de RS, RJ e MG de 2003 a 2026.',
  keywords: [
    'criminalidade brasil',
    'mapa crime brasil',
    'estatísticas criminalidade',
    'segurança pública brasil',
    'dados criminalidade rio grande do sul',
    'criminalidade rio de janeiro',
    'criminalidade minas gerais',
    'mapa violência brasil',
    'taxa criminalidade bairro',
    'índice criminalidade cidade',
    'crime por bairro',
    'segurança bairro',
    'criminalidade por região',
    'comparar criminalidade cidades',
    'crimes por 100 mil habitantes',
  ],
  authors: [{ name: 'Israel' }],
  creator: 'Israel',
  publisher: 'Crime Brasil',
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    url: 'https://crimebrasil.com.br',
    siteName: 'Crime Brasil',
    title: 'Crime Brasil — Mapa Interativo de Criminalidade do Brasil',
    description:
      'Explore dados de criminalidade por estado, cidade e bairro. Compare regiões, filtre por tipo de crime e veja estatísticas por 100 mil habitantes.',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Crime Brasil - Mapa de Criminalidade',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Crime Brasil — Mapa Interativo de Criminalidade',
    description: 'Explore dados de criminalidade por estado, cidade e bairro.',
    images: ['/og-image.png'],
  },
  alternates: {
    canonical: 'https://crimebrasil.com.br',
  },
  verification: {
    google: 'z5VtZcom_iQJA04nKL1KlJ5bSgKtNc4srT1e_8DE25U',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Fira+Code:wght@400;600&display=swap"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
        <link rel="preconnect" href="https://basemaps.cartocdn.com" />
      </head>
      <body>
        {children}
      </body>
      <GoogleAnalytics gaId={process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || 'G-EYENXNM0EG'} />
    </html>
  );
}
