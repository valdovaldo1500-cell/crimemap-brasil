import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CrimeMap RS - Mapa de Ocorrencias',
  description: 'Mapa interativo de ocorrencias criminais no Rio Grande do Sul',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
