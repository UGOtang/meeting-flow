'use client';

import { useRef, useCallback, useEffect, useMemo } from 'react';
import { useLoroCursorSync, type Cursor } from '@/hooks/useLoroCursorSync';

const card: React.CSSProperties = {
  background: '#fff',
  borderRadius: 12,
  padding: 16,
  boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
  border: '1px solid #e5e7eb',
};

const dot: React.CSSProperties = {
  display: 'inline-block',
  width: 10, height: 10, borderRadius: 999, marginRight: 8, verticalAlign: 'middle',
};

const boardStyle: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  height: 420,
  background: '#fff',
  border: '2px solid #e5e7eb',
  borderRadius: 12,
  boxShadow: '0 6px 16px rgba(0,0,0,0.06)',
  overflow: 'hidden',
  cursor: 'crosshair',
};

const gridBg: React.CSSProperties = {
  position: 'absolute',
  inset: 0 as any,
  opacity: 0.08,
  backgroundImage: 'radial-gradient(circle, #000 1px, transparent 1px)',
  backgroundSize: '20px 20px',
};

function CursorView({ c }: { c: Cursor }) {
  const style: React.CSSProperties = {
    position: 'absolute',
    pointerEvents: 'none',
    willChange: 'transform',
    transform: `translate3d(${c.x - 8}px, ${c.y - 8}px, 0)`,
    transition: 'transform 80ms ease-out', // 小过渡，观感丝滑
  };
  return (
    <div style={style}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill={c.color}>
        <path d="M12 2L2 7L12 12L22 7L12 2Z" />
        <path d="M12 12L2 17L12 22L22 17L12 12Z" opacity="0.6" />
      </svg>
      <div
        style={{
          position: 'absolute',
          top: 18, left: 18,
          padding: '2px 6px',
          borderRadius: 6,
          fontSize: 10, color: '#fff', fontWeight: 600,
          background: c.color,
          whiteSpace: 'nowrap',
          boxShadow: `0 6px 14px ${c.color}33`,
        }}
      >
        {c.name}
      </div>
    </div>
  );
}

export default function CursorBoard() {
  const {
    isConnected,
    cursors,
    selfCursor,
    userColor, userName,
    updateCursor, removeCursor, forceResend,
  } = useLoroCursorSync({
    wsUrl: process.env.NEXT_PUBLIC_WS_URL,
    // room: 'demo',
    sendIntervalMs: 70,       // 关键参数：网络节流
    keepAliveMs: 8000,
  });

  const containerRef = useRef<HTMLDivElement>(null);

  // rAF 节流仅用于读取鼠标并更新“本地 UI”
  const rAFRef = useRef<number | null>(null);
  const onMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (rAFRef.current == null) {
      rAFRef.current = requestAnimationFrame(() => {
        rAFRef.current = null;
        updateCursor(x, y); // UI 即时 + 网络节流
      });
    }
  }, [updateCursor]);

  const onLeave = useCallback(() => {
    removeCursor();
  }, [removeCursor]);

  // 首次进入：把光标放在中心并强制发一次（确保对端能立刻看到）
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !isConnected) return;
    const rect = el.getBoundingClientRect();
    const cx = Math.max(8, rect.width / 2);
    const cy = Math.max(8, rect.height / 2);
    updateCursor(cx, cy);
    forceResend('initial center');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  // 其他用户（Map→Array）
  const others = useMemo(() => Array.from<Cursor>(cursors.values()), [cursors]);

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', padding: 24 }}>
      <div style={{ ...card, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111827' }}>🖱️ Loro + WS 光标同步（丝滑版）</h1>
        <div style={{ marginTop: 10, fontSize: 14, color: '#374151' }}>
          <span style={{ ...dot, background: userColor }} />
          当前用户：<b>{userName}</b>
          <span style={{ marginLeft: 16 }}>
            <span style={{ ...dot, background: isConnected ? '#22c55e' : '#ef4444' }} />
            {isConnected ? '已连接' : '未连接'}
          </span>
          <span style={{ marginLeft: 16 }}>在线光标（含自己）：{others.length + (selfCursor ? 1 : 0)}</span>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>
          说明：本地光标动画不经 CRDT，网络每 ~70ms 发送一次；收到多条更新只导入一次，不卡顿。
        </div>
      </div>

      <div style={{ ...card }}>
        <div
          ref={containerRef}
          style={boardStyle}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
        >
          <div style={gridBg} />

          <div style={{ position: 'absolute', top: 12, left: 12, color: '#6b7280', fontSize: 12 }}>
            在白色面板内移动鼠标，应该是丝滑的 ✨
          </div>

          {/* 别人的光标 */}
          {others.map((c) => <CursorView key={c.id} c={c} />)}

          {/* 自己的光标（即时） */}
          {selfCursor && <CursorView c={selfCursor} />}
        </div>
      </div>
    </div>
  );
}
