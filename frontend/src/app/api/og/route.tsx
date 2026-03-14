import { ImageResponse } from 'next/og';

export const runtime = 'edge';

export async function GET() {
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
        {/* Bar chart logo */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', marginBottom: '28px' }}>
          <div style={{ width: '18px', height: '70px', borderRadius: '4px', background: '#3b82f6' }} />
          <div style={{ width: '18px', height: '100px', borderRadius: '4px', background: '#7c3aed' }} />
          <div style={{ width: '18px', height: '52px', borderRadius: '4px', background: '#3b82f6' }} />
          <div style={{ width: '18px', height: '114px', borderRadius: '4px', background: '#ef4444' }} />
        </div>

        {/* Brand */}
        <div style={{ display: 'flex', fontSize: '72px', fontWeight: 700, letterSpacing: '-2px' }}>
          <span style={{ color: '#f1f5f9' }}>Crime</span>
          <span style={{ color: '#3b82f6' }}>Brasil</span>
        </div>

        {/* URL hint */}
        <div
          style={{
            position: 'absolute',
            bottom: '32px',
            fontSize: '20px',
            color: '#475569',
          }}
        >
          crimebrasil.com.br
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
