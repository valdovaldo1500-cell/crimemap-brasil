import type { Metadata } from 'next';
import Script from 'next/script';
import './globals.css';

const GA_ID = 'G-EYENXNM0EG';

export const metadata: Metadata = {
  metadataBase: new URL('https://crimebrasil.com.br'),
  title: 'Crime Brasil — Mapa de Ocorrências Criminais',
  description: 'Mapa interativo de ocorrências criminais no Brasil',
  openGraph: {
    title: 'Crime Brasil — Mapa de Ocorrências Criminais',
    description: 'Mapa interativo de ocorrências criminais no Brasil',
    url: 'https://crimebrasil.com.br',
    siteName: 'CrimeBrasil',
    locale: 'pt_BR',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Crime Brasil — Mapa de Ocorrências Criminais',
    description: 'Mapa interativo de ocorrências criminais no Brasil',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Fira+Code:wght@400;600&display=swap" rel="stylesheet" />
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      </head>
      <body>
        {children}
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
          strategy="afterInteractive"
        />
        <Script id="ga4-init" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${GA_ID}');
          `}
        </Script>
      </body>
    </html>
  );
}
