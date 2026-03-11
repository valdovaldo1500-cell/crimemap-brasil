'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

type Segment = { text: string; bold?: true; italic?: true };

const SEGMENTS: Segment[] = [
  { text: "Seja bem-vindo!\n\nQuando minha sogra estava se mudando, procuramos uma ferramenta que mostrasse dados reais de criminalidade por região — e não encontramos nada.\nEntão criei CrimeBrasil.com.br — O mapa de criminalidade mais completo do país!\n\n• Dados de criminalidade por estado, cidade e bairro\n• Compare diferentes regiões lado a lado\n• Veja estatísticas totais ou por 100 mil habitantes\n• Dados detalhados do RS, RJ e MG, cobrindo 2003 a 2026.\n\nAjude a manter o site no ar — " },
  { text: "compartilhe!", bold: true },
  { text: "\n\n— " },
  { text: "Israel Lehnen Silva", italic: true },
];

const FULL_MESSAGE = SEGMENTS.map(s => s.text).join('');

function renderSegments(charIndex: number): React.ReactNode[] {
  let remaining = charIndex;
  return SEGMENTS.map((seg, i) => {
    if (remaining <= 0) return null;
    const visible = seg.text.slice(0, remaining);
    remaining -= seg.text.length;
    if (seg.bold) return <strong key={i} style={{ color: '#ffffff', fontWeight: 700 }}>{visible}</strong>;
    if (seg.italic) return <em key={i} style={{ color: '#aaffcc', fontStyle: 'italic' }}>{visible}</em>;
    return <span key={i}>{visible}</span>;
  });
}

const CHAR_DELAY = 30;
const PARAGRAPH_PAUSE = 200;

export default function WelcomeModal() {
  const [visible, setVisible] = useState(false);
  const [charIndex, setCharIndex] = useState(0);
  const [typingDone, setTypingDone] = useState(false);
  const [showExplore, setShowExplore] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pauseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipBtnRef = useRef<HTMLButtonElement>(null);
  const exploreBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && !localStorage.getItem('crimebrasil_welcomed')) {
      setVisible(true);
    }
  }, []);

  const finishTyping = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (pauseRef.current) clearTimeout(pauseRef.current);
    setCharIndex(FULL_MESSAGE.length);
    setTypingDone(true);
    setTimeout(() => setShowExplore(true), 100);
  }, []);

  useEffect(() => {
    if (!visible || typingDone) return;

    let idx = charIndex;

    const tick = () => {
      if (idx >= FULL_MESSAGE.length) {
        finishTyping();
        return;
      }

      // Check for double-newline (paragraph break) — pause briefly
      if (
        FULL_MESSAGE[idx] === '\n' &&
        idx + 1 < FULL_MESSAGE.length &&
        FULL_MESSAGE[idx + 1] === '\n'
      ) {
        clearInterval(intervalRef.current!);
        setCharIndex(idx + 2);
        idx += 2;
        pauseRef.current = setTimeout(() => {
          intervalRef.current = setInterval(tick, CHAR_DELAY);
        }, PARAGRAPH_PAUSE);
        return;
      }

      idx += 1;
      setCharIndex(idx);
    };

    intervalRef.current = setInterval(tick, CHAR_DELAY);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (pauseRef.current) clearTimeout(pauseRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, typingDone]);

  useEffect(() => {
    if (typingDone) {
      exploreBtnRef.current?.focus();
    }
  }, [typingDone]);

  // Trap focus between Pular and Explorar
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      dismiss();
      return;
    }
    if (e.key === 'Tab' && typingDone) {
      const focusables = [skipBtnRef.current, exploreBtnRef.current].filter(Boolean) as HTMLElement[];
      if (focusables.length < 2) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
  }, [typingDone]); // eslint-disable-line react-hooks/exhaustive-deps

  const dismiss = useCallback(() => {
    localStorage.setItem('crimebrasil_welcomed', 'true');
    setVisible(false);
  }, []);

  if (!visible) return null;

  const displayedText = FULL_MESSAGE.slice(0, charIndex);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Mensagem de boas-vindas"
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)' }}
      onKeyDown={handleKeyDown}
    >
      <div
        className="w-full flex flex-col"
        style={{
          maxWidth: 650,
          background: '#0d0d0d',
          border: '1px solid #2a2a2a',
          borderRadius: 4,
          boxShadow: '0 0 30px rgba(0, 255, 136, 0.08), 0 20px 60px rgba(0,0,0,0.6)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Terminal chrome */}
        <div
          className="flex items-center justify-between px-4"
          style={{
            height: 36,
            background: '#1a1a1a',
            borderBottom: '1px solid #2a2a2a',
            borderRadius: '4px 4px 0 0',
          }}
        >
          <div className="flex items-center gap-1.5">
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f56' }} />
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ffbd2e' }} />
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#27c93f' }} />
          </div>
          <span style={{ fontFamily: "'Fira Code', 'Courier New', monospace", fontSize: 11, color: '#555', letterSpacing: '0.02em' }}>
            crime-brasil ~ /mensagem
          </span>
          <button
            ref={skipBtnRef}
            onClick={finishTyping}
            style={{
              fontFamily: "'Fira Code', 'Courier New', monospace",
              fontSize: 11,
              color: '#555',
              background: 'transparent',
              border: '1px solid #333',
              borderRadius: 3,
              padding: '2px 8px',
              cursor: 'pointer',
              transition: 'color 0.15s, border-color 0.15s',
            }}
            onMouseEnter={e => { (e.target as HTMLElement).style.color = '#aaa'; (e.target as HTMLElement).style.borderColor = '#555'; }}
            onMouseLeave={e => { (e.target as HTMLElement).style.color = '#555'; (e.target as HTMLElement).style.borderColor = '#333'; }}
          >
            Pular ▸
          </button>
        </div>

        {/* Text area */}
        <div
          style={{
            padding: '1.5rem',
            maxHeight: '65vh',
            overflowY: 'auto',
          }}
        >
          <div
            style={{
              fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', 'Courier New', monospace",
              fontSize: 14,
              lineHeight: 1.75,
              color: '#00e87a',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {displayedText}
            <span
              style={{
                display: 'inline-block',
                animation: 'blink-cursor 1.06s step-end infinite',
                color: '#00e87a',
                marginLeft: 1,
              }}
            >
              █
            </span>
          </div>

          {/* Explore button */}
          <div
            style={{
              marginTop: '1.5rem',
              textAlign: 'center',
              opacity: showExplore ? 1 : 0,
              transition: 'opacity 0.5s ease',
              pointerEvents: showExplore ? 'auto' : 'none',
            }}
          >
            <button
              ref={exploreBtnRef}
              onClick={dismiss}
              style={{
                fontFamily: "'Fira Code', 'Courier New', monospace",
                fontSize: 14,
                fontWeight: 600,
                color: '#0d0d0d',
                background: '#00e87a',
                border: 'none',
                borderRadius: 4,
                padding: '10px 28px',
                cursor: 'pointer',
                letterSpacing: '0.03em',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { (e.target as HTMLElement).style.background = '#00ff88'; }}
              onMouseLeave={e => { (e.target as HTMLElement).style.background = '#00e87a'; }}
            >
              Explorar o mapa →
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes blink-cursor {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
