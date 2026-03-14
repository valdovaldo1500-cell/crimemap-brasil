import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const title = searchParams.get('title') || 'Crime Brasil';
  const subtitle = searchParams.get('subtitle') || 'Mapa interativo de criminalidade do Brasil';
  const detail = searchParams.get('detail') || '';

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
        <div style={{ display: 'flex', fontSize: '40px', fontWeight: 700, letterSpacing: '-1px', marginBottom: '32px' }}>
          <span style={{ color: '#f1f5f9' }}>Crime</span>
          <span style={{ color: '#3b82f6' }}>Brasil</span>
        </div>

        {/* Card */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            background: '#131c2e',
            border: '1px solid #1e3a5f',
            borderRadius: '16px',
            padding: '32px 48px',
            maxWidth: '900px',
            width: '100%',
          }}
        >
          <div
            style={{
              fontSize: detail ? '52px' : '60px',
              fontWeight: 700,
              color: '#f1f5f9',
              letterSpacing: '-1px',
              textAlign: 'center',
              lineHeight: 1.15,
              marginBottom: '14px',
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: '26px',
              color: '#94a3b8',
              textAlign: 'center',
              marginBottom: detail ? '18px' : '0',
            }}
          >
            {subtitle}
          </div>
          {detail && (
            <div
              style={{
                fontSize: '30px',
                fontWeight: 600,
                color: '#60a5fa',
                textAlign: 'center',
              }}
            >
              {detail}
            </div>
          )}
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
