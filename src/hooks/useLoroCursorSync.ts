'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LoroDoc, type Subscription } from 'loro-crdt';

export interface Cursor {
  id: string;
  x: number;
  y: number;
  color: string;
  name: string;
  lastUpdate: number;
}

interface Options {
  wsUrl?: string;
  room?: string;
  expireMs?: number;        // 多久无更新判定过期
  cleanupEveryMs?: number;  // 清理扫描频率
  keepAliveMs?: number;     // 心跳刷新频率（不动鼠标也续命）
}

function buildWsUrl(raw?: string, room?: string) {
  if (raw) {
    const u = new URL(raw);
    if (room) u.searchParams.set('room', room);
    return u.toString();
  }
  const proto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3001';
  const u = new URL(`${proto}://${host}`);
  if (!host.includes(':')) u.port = '3001';
  if (room) u.searchParams.set('room', room);
  return u.toString();
}

export function useLoroCursorSync(options: Options = {}) {
  const {
    wsUrl,
    room,
    expireMs = 30_000,      // 30秒过期
    cleanupEveryMs = 5_000,
    keepAliveMs = 10_000,   // 10秒心跳
  } = options;

  const userId = useRef(`user-${Math.random().toString(36).slice(2, 9)}`).current;
  const userName = useRef(`用户${Math.floor(Math.random() * 1000)}`).current;
  const userColor = useRef(`hsl(${Math.random() * 360}, 70%, 60%)`).current;

  const [isConnected, setIsConnected] = useState(false);
  const [cursors, setCursors] = useState<Map<string, Cursor>>(new Map());

  const wsRef = useRef<WebSocket | null>(null);
  const docRef = useRef<LoroDoc | null>(null);
  const unsubRef = useRef<Subscription | (() => void) | null>(null);
  const keepAliveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const backoffRef = useRef(1000); // 重连退避
  const versionRef = useRef<Uint8Array | null>(null); // 记录版本，避免重复发送

  console.log(`[INIT] userId=${userId}, userName=${userName}, userColor=${userColor}`);

  // 更新光标显示状态
  const updateCursorsDisplay = useCallback(() => {
    const doc = docRef.current;
    if (!doc) return;
    
    try {
      const map = doc.getMap('cursors');
      const next = new Map<string, Cursor>();
      const now = Date.now();
      
      for (const [key, value] of map.entries()) {
        if (value && typeof value === 'object') {
          const v: any = value;
          if (typeof v.x === 'number' && typeof v.y === 'number' && typeof v.id === 'string') {
            const cursor: Cursor = {
              id: v.id,
              x: v.x,
              y: v.y,
              color: v.color || '#4ECDC4',
              name: v.name || 'Unknown',
              lastUpdate: v.lastUpdate || now,
            };
            
            // 过滤过期光标
            if (now - cursor.lastUpdate <= expireMs) {
              next.set(key, cursor);
            } else {
              console.log(`[EXPIRE] 清理过期光标: ${cursor.name} (${cursor.id})`);
              map.delete(key); // 从文档中删除过期光标
            }
          }
        }
      }
      
      setCursors(next);
      console.log(`[CURSORS] 更新显示: ${Array.from(next.keys()).join(', ')}`);
    } catch (e) {
      console.error('[CURSORS] 更新显示错误:', e);
    }
  }, [expireMs]);

  // 发送文档更新
  const sendDocumentUpdate = useCallback((reason: string) => {
    const doc = docRef.current;
    const ws = wsRef.current;
    
    if (!doc || !ws || ws.readyState !== WebSocket.OPEN) {
      console.log(`[SEND SKIP] ${reason}, doc=${!!doc}, ws=${!!ws}, wsOpen=${!!ws && ws.readyState === WebSocket.OPEN}`);
      return;
    }

    try {
      // 获取完整的文档快照
      const snapshot = doc.exportSnapshot();
      
      // 检查是否有变化（简单的字节对比）
      if (versionRef.current && 
          versionRef.current.length === snapshot.length &&
          versionRef.current.every((val, i) => val === snapshot[i])) {
        console.log(`[SEND SKIP] ${reason} - 无变化`);
        return;
      }
      
      versionRef.current = snapshot;
      
      const message = {
        type: 'loro_snapshot',
        data: Array.from(snapshot),
        userId: userId,
        room: room || 'default'
      };
      
      ws.send(JSON.stringify(message));
      console.log(`[SEND] ${reason}, snapshot bytes=${snapshot.length}`);
    } catch (e) {
      console.error('[SEND ERROR]', reason, e);
    }
  }, [userId, room]);

  // 初始化 Loro 文档
  useEffect(() => {
    console.log('[DOC] 初始化 Loro 文档');
    const doc = new LoroDoc();
    docRef.current = doc;

    // 订阅文档变化
    const sub = doc.subscribe((event: any) => {
      console.log('[DOC] 文档变化事件:', { local: event?.local, origin: event?.origin });
      
      // 更新光标显示
      updateCursorsDisplay();
      
      // 如果是本地变化，发送到服务器
      if (event?.local) {
        // 延迟发送，避免频繁发送
        setTimeout(() => sendDocumentUpdate('local change'), 50);
      }
    });

    unsubRef.current = sub;

    return () => {
      console.log('[DOC] 清理 Loro 文档');
      const u = unsubRef.current;
      if (typeof u === 'function') u();
      else if (u && 'unsubscribe' in u && typeof (u as any).unsubscribe === 'function') {
        (u as any).unsubscribe();
      }
      unsubRef.current = null;
      docRef.current = null;
    };
  }, [updateCursorsDisplay, sendDocumentUpdate]);

  // 心跳机制
  useEffect(() => {
    keepAliveTimerRef.current = setInterval(() => {
      const doc = docRef.current;
      if (!doc || !isConnected) return;
      
      const map = doc.getMap('cursors');
      const mine = map.get(userId) as any;
      
      if (mine && typeof mine === 'object') {
        // 更新心跳时间
        const updated = { ...mine, lastUpdate: Date.now() };
        map.set(userId, updated);
        console.log(`[HEARTBEAT] 更新心跳: ${userName}`);
      }
    }, keepAliveMs);

    return () => {
      if (keepAliveTimerRef.current) {
        clearInterval(keepAliveTimerRef.current);
        keepAliveTimerRef.current = null;
      }
    };
  }, [userId, userName, keepAliveMs, isConnected]);

  // 定时清理过期光标
  useEffect(() => {
    const timer = setInterval(() => {
      updateCursorsDisplay();
    }, cleanupEveryMs);
    
    return () => clearInterval(timer);
  }, [updateCursorsDisplay, cleanupEveryMs]);

  // WebSocket 连接
  const connect = useCallback(() => {
    const urlToUse = buildWsUrl(wsUrl, room);
    console.log(`[WS] 尝试连接: ${urlToUse}`);
    
    try {
      const ws = new WebSocket(urlToUse);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[WS] 连接成功');
        setIsConnected(true);
        backoffRef.current = 1000; // 重置退避时间
        
        // 连接成功后立即发送当前状态
        setTimeout(() => {
          sendDocumentUpdate('connection opened');
        }, 100);
      };

      ws.onclose = (ev) => {
        console.warn(`[WS] 连接关闭: ${ev.code} ${ev.reason}`);
        setIsConnected(false);
        
        // 自动重连
        const delay = Math.min(backoffRef.current, 30_000);
        console.log(`[WS] ${delay}ms 后重连`);
        setTimeout(connect, delay);
        backoffRef.current = Math.min(backoffRef.current * 2, 30_000);
      };

      ws.onerror = (err) => {
        console.error('[WS] 连接错误:', err);
        setIsConnected(false);
      };

      ws.onmessage = async (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          console.log(`[RECV] 收到消息:`, { type: msg.type, userId: msg.userId, dataLength: msg.data?.length });
          
          const doc = docRef.current;
          if (!doc) return;

          if (msg.type === 'loro_snapshot' && Array.isArray(msg.data)) {
            // 忽略自己发送的消息
            if (msg.userId === userId) {
              console.log('[RECV] 忽略自己的消息');
              return;
            }
            
            try {
              const snapshot = new Uint8Array(msg.data);
              
              // 导入远程快照，这会触发文档更新事件
              doc.import(snapshot);
              console.log(`[RECV] 成功导入快照, bytes=${snapshot.length}`);
              
              // 强制更新显示
              updateCursorsDisplay();
            } catch (importError) {
              console.error('[RECV] 导入快照失败:', importError);
            }
          }
        } catch (e) {
          console.error('[WS] 消息解析错误:', e);
        }
      };
    } catch (e) {
      console.error('[WS] 创建连接失败:', e);
      setTimeout(connect, Math.min(backoffRef.current, 30_000));
      backoffRef.current = Math.min(backoffRef.current * 2, 30_000);
    }
  }, [room, wsUrl, userId, sendDocumentUpdate, updateCursorsDisplay]);

  // 启动连接
  useEffect(() => {
    connect();
    return () => {
      try { 
        wsRef.current?.close(); 
      } catch {}
    };
  }, [connect]);

  // 更新光标位置
  const updateCursor = useCallback((x: number, y: number) => {
    const doc = docRef.current;
    if (!doc) {
      console.warn('[UPDATE] 文档未初始化');
      return;
    }
    
    try {
      const map = doc.getMap('cursors');
      const cursor = {
        id: userId,
        x: Math.round(x),
        y: Math.round(y),
        color: userColor,
        name: userName,
        lastUpdate: Date.now(),
      };
      
      map.set(userId, cursor);
      console.log(`[UPDATE] 更新光标位置: (${x}, ${y})`);
    } catch (e) {
      console.error('[UPDATE] 更新光标失败:', e);
    }
  }, [userColor, userName, userId]);

  // 移除光标
  const removeCursor = useCallback(() => {
    const doc = docRef.current;
    if (!doc) return;
    
    try {
      doc.getMap('cursors').delete(userId);
      console.log(`[REMOVE] 移除光标: ${userId}`);
    } catch (e) {
      console.error('[REMOVE] 移除光标失败:', e);
    }
  }, [userId]);

  // 强制重发
  const forceResend = useCallback((reason = 'manual force resend') => {
    // 清除版本记录，强制发送
    versionRef.current = null;
    sendDocumentUpdate(reason);
  }, [sendDocumentUpdate]);

  return {
    userId, 
    userName, 
    userColor,
    isConnected,
    cursors,
    updateCursor,
    removeCursor,
    forceResend,
  };
}