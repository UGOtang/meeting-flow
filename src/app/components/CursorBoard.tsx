'use client';

import { useRef, useCallback, useEffect } from 'react';
import { useLoroCursorSync, type Cursor } from '@/hooks/useLoroCursorSync';

const card: React.CSSProperties = {
  background: '#fff',
  borderRadius: 12,
  padding: 16,
  boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
  border: '1px solid #e5e7eb',
};

const badgeDot: React.CSSProperties = {
  display: 'inline-block',
  width: 10,
  height: 10,
  borderRadius: 999,
  marginRight: 8,
  verticalAlign: 'middle',
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
  opacity: 0.1,
  backgroundImage: 'radial-gradient(circle, #000 1px, transparent 1px)',
  backgroundSize: '20px 20px',
};

export default function CursorBoard() {
  const {
    isConnected, 
    cursors,
    userColor, 
    userName,
    userId,
    updateCursor, 
    removeCursor,
    forceResend,
  } = useLoroCursorSync({
    wsUrl: process.env.NEXT_PUBLIC_WS_URL,
    room: 'demo-room', // 确保使用相同的房间
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const lastUpdateRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const sentInitialRef = useRef(false);

  // 节流的鼠标移动处理
  const rAFRef = useRef<number | null>(null);
  const pendingRef = useRef<{ x: number; y: number } | null>(null);

  const flushUpdate = useCallback(() => {
    rAFRef.current = null;
    if (!pendingRef.current) return;
    
    const { x, y } = pendingRef.current;
    pendingRef.current = null;
    
    // 避免重复发送相同位置
    const last = lastUpdateRef.current;
    if (last && Math.abs(last.x - x) < 2 && Math.abs(last.y - y) < 2 && 
        Date.now() - last.time < 100) {
      return;
    }
    
    lastUpdateRef.current = { x, y, time: Date.now() };
    updateCursor(x, y);
  }, [updateCursor]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    
    pendingRef.current = { x, y };
    
    if (rAFRef.current === null) {
      rAFRef.current = requestAnimationFrame(flushUpdate);
    }
  }, [flushUpdate]);

  const onMouseLeave = useCallback(() => {
    // 取消待处理的更新
    if (rAFRef.current !== null) {
      cancelAnimationFrame(rAFRef.current);
      rAFRef.current = null;
      pendingRef.current = null;
    }
    
    removeCursor();
    lastUpdateRef.current = null;
    console.log('[UI] 鼠标离开，移除光标');
  }, [removeCursor]);

  const onMouseEnter = useCallback(() => {
    if (!containerRef.current || !isConnected) return;
    
    // 鼠标进入时设置一个初始位置
    const rect = containerRef.current.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    updateCursor(centerX, centerY);
    console.log('[UI] 鼠标进入，设置初始位置');
  }, [isConnected, updateCursor]);

  // 连接成功后的初始化
  useEffect(() => {
    if (!isConnected || sentInitialRef.current) return;
    
    const timer = setTimeout(() => {
      const el = containerRef.current;
      if (!el) return;
      
      const rect = el.getBoundingClientRect();
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      
      console.log('[UI] 连接成功，设置中心位置:', { centerX, centerY });
      updateCursor(centerX, centerY);
      
      // 强制重发确保对方收到
      setTimeout(() => {
        forceResend('initial center after connection');
      }, 200);
      
      sentInitialRef.current = true;
    }, 100);

    return () => clearTimeout(timer);
  }, [isConnected, updateCursor, forceResend]);

  // 调试：监听光标变化
  useEffect(() => {
    const cursorList = Array.from(cursors.values()).map(c => `${c.name}(${c.x},${c.y})`);
    console.log(`[UI] 光标状态更新: connected=${isConnected}, cursors=[${cursorList.join(', ')}]`);
  }, [isConnected, cursors]);

  // 清理 RAF
  useEffect(() => {
    return () => {
      if (rAFRef.current !== null) {
        cancelAnimationFrame(rAFRef.current);
      }
    };
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', padding: 24 }}>
      {/* 状态卡片 */}
      <div style={{ ...card, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111827' }}>
          🖱️ Loro + Next.js 光标同步演示
        </h1>
        <div style={{ marginTop: 12, fontSize: 14, color: '#374151' }}>
          <div style={{ marginBottom: 8 }}>
            <span style={{ ...badgeDot, background: userColor }} />
            当前用户：<strong>{userName}</strong> <code>({userId})</code>
            <span style={{ marginLeft: 16 }}>
              <span
                style={{
                  ...badgeDot,
                  background: isConnected ? '#22c55e' : '#ef4444',
                  marginRight: 6,
                }}
              />
              {isConnected ? '✅ 已连接 WebSocket' : '❌ 未连接 WebSocket'}
            </span>
          </div>
          <div>
            <span style={{ marginRight: 16 }}>
              在线光标数量：<strong>{cursors.size}</strong>
            </span>
            <span>
              房间：<code>demo-room</code>
            </span>
          </div>
        </div>
        
        <div style={{ marginTop: 12, fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>
          <div>💡 <strong>测试方法：</strong>在新标签页中打开相同页面，移动鼠标查看实时同步效果</div>
          <div>🔧 <strong>调试信息：</strong>打开浏览器控制台查看详细日志</div>
          <div>🌐 <strong>WebSocket地址：</strong> <code>{process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3001'}</code></div>
        </div>
      </div>

      {/* 光标同步面板 */}
      <div style={{ ...card }}>
        <div
          ref={containerRef}
          style={boardStyle}
          onMouseMove={onMouseMove}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        >
          {/* 背景网格 */}
          <div style={gridBg} />

          {/* 说明文字 */}
          <div style={{ 
            position: 'absolute', 
            top: 16, 
            left: 16, 
            color: '#6b7280', 
            fontSize: 13,
            background: 'rgba(255,255,255,0.8)',
            padding: '6px 10px',
            borderRadius: 6,
            backdropFilter: 'blur(4px)'
          }}>
            在此区域移动鼠标，查看跨标签页的实时光标同步
          </div>

          {/* 连接状态指示器 */}
          {!isConnected && (
            <div style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              background: 'rgba(239, 68, 68, 0.1)',
              border: '2px dashed #ef4444',
              borderRadius: 8,
              padding: '20px 24px',
              color: '#dc2626',
              fontSize: 14,
              fontWeight: 600,
              textAlign: 'center'
            }}>
              ⚠️ WebSocket 未连接<br/>
              <span style={{ fontSize: 12, fontWeight: 400 }}>
                请检查服务器是否运行
              </span>
            </div>
          )}

          {/* 渲染所有光标 */}
          {Array.from(cursors.values()).map((cursor) => (
            <div
              key={cursor.id}
              style={{
                position: 'absolute',
                left: cursor.x - 8,
                top: cursor.y - 8,
                pointerEvents: 'none',
                transform: 'translate(0, 0)',
                transition: cursor.id === userId ? 'none' : 'all 0.1s ease-out', // 自己的光标不用过渡
                zIndex: cursor.id === userId ? 20 : 10, // 自己的光标在最上层
              }}
            >
              {/* 光标图标 */}
              <svg 
                width="16" 
                height="16" 
                viewBox="0 0 24 24" 
                fill={cursor.color}
                style={{
                  filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.2))',
                }}
              >
                <path d="M12 2L2 7L12 12L22 7L12 2Z" />
                <path d="M12 12L2 17L12 22L22 17L12 12Z" opacity="0.6" />
              </svg>

              {/* 用户名标签 */}
              <div
                style={{
                  position: 'absolute',
                  top: 20,
                  left: 20,
                  padding: '4px 8px',
                  borderRadius: 6,
                  fontSize: 11,
                  color: '#fff',
                  background: cursor.color,
                  whiteSpace: 'nowrap',
                  boxShadow: `0 4px 12px ${cursor.color}40`,
                  fontWeight: 600,
                  lineHeight: 1,
                  border: cursor.id === userId ? '2px solid #fff' : 'none', // 高亮自己
                }}
              >
                {cursor.name}
                {cursor.id === userId && ' (你)'}
              </div>

              {/* 光标脉冲效果 */}
              <div
                style={{
                  position: 'absolute',
                  top: -4,
                  left: -4,
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: cursor.color,
                  opacity: 0.2,
                  animation: 'pulse 2s infinite',
                }}
              />
            </div>
          ))}

          {/* 光标计数 */}
          {cursors.size > 0 && (
            <div style={{
              position: 'absolute',
              bottom: 16,
              right: 16,
              background: 'rgba(0,0,0,0.7)',
              color: '#fff',
              padding: '6px 12px',
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 600,
              backdropFilter: 'blur(4px)'
            }}>
              {cursors.size} 个活跃光标
            </div>
          )}
        </div>

        {/* 底部说明 */}
        <div style={{ marginTop: 12, fontSize: 12, color: '#6b7280', lineHeight: 1.4 }}>
          <div><strong>🔍 故障排查：</strong></div>
          <div>• 确保 WebSocket 服务器在 <code>localhost:3001</code> 运行</div>
          <div>• 检查浏览器控制台是否有 [SEND]/[RECV] 日志输出</div>
          <div>• 确认多个标签页连接到相同的房间 (<code>demo-room</code>)</div>
          <div>• 如果仍有问题，尝试刷新页面重新连接</div>
        </div>
      </div>

      {/* CSS 动画 */}
      <style jsx>{`
        @keyframes pulse {
          0%, 100% {
            opacity: 0.2;
            transform: scale(1);
          }
          50% {
            opacity: 0.1;
            transform: scale(1.2);
          }
        }
      `}</style>
    </div>
  );
}