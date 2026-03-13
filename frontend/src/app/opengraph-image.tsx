import { ImageResponse } from 'next/og';

export const alt = 'CrimeBrasil — Mapa interativo de ocorrências criminais no Brasil';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          background: '#0a0f1a',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          position: 'relative',
        }}
      >
        {/* Bar chart logo group */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', marginBottom: '32px' }}>
          <div style={{ width: '20px', height: '80px', borderRadius: '4px', background: '#3b82f6' }} />
          <div style={{ width: '20px', height: '112px', borderRadius: '4px', background: '#7c3aed' }} />
          <div style={{ width: '20px', height: '60px', borderRadius: '4px', background: '#3b82f6' }} />
          <div style={{ width: '20px', height: '128px', borderRadius: '4px', background: '#ef4444' }} />
        </div>

        {/* Title */}
        <div style={{ display: 'flex', fontSize: '88px', fontWeight: 700, letterSpacing: '-2px', marginBottom: '20px' }}>
          <span style={{ color: '#f1f5f9' }}>Crime</span>
          <span style={{ color: '#3b82f6' }}>Brasil</span>
        </div>

        {/* Subtitle */}
        <div
          style={{
            fontSize: '30px',
            color: '#94a3b8',
            letterSpacing: '-0.5px',
            textAlign: 'center',
            maxWidth: '800px',
          }}
        >
          Mapa interativo de ocorrências criminais no Brasil
        </div>

        {/* URL hint */}
        <div
          style={{
            position: 'absolute',
            bottom: '36px',
            fontSize: '20px',
            color: '#475569',
            letterSpacing: '0.5px',
          }}
        >
          crimebrasil.com.br
        </div>
      </div>
    ),
    { ...size }
  );
}
