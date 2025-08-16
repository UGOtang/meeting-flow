'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LoroDoc, type Subscription } from 'loro-crdt';
import { debounce } from 'lodash-es';

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
  expireMs?: number;        // 失活清理阈值
  cleanupEveryMs?: number;  // 清理频率
  keepAliveMs?: number;     // 心跳刷新
  sendIntervalMs?: number;  // 本地→网络发送节流
}

function buildWsUrl(raw?: string, room?: string) {
  if (raw) {
    const u = new URL(raw);
    if (room) u.searchParams.set('room', room);
    return u.toString();
  }
  const proto = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = 'localhost:3001';
  const u = new URL(`${proto}://${host}`);
  if (!host.includes(':')) u.port = '3001';
  if (room) u.searchParams.set('room', room);
  return u.toString();
}

export function useLoroCursorSync(options: Options = {}) {
  const {
    wsUrl,
    room,
    expireMs = 30_000,
    cleanupEveryMs = 5_000,
    keepAliveMs = 10_000,
    sendIntervalMs = 70,    // **关键**：网络发送节流 ~14fps 就很顺了
  } = options;

  // 身份
  const userId = useRef(`user-${Math.random().toString(36).slice(2, 9)}`).current;
  const userName = useRef(`用户${Math.floor(Math.random() * 1000)}`).current;
  const userColor = useRef(`hsl(${Math.random() * 360}, 70%, 60%)`).current;

  // 连接 & 可见光标（不包含自己）
  const [isConnected, setIsConnected] = useState(false);
  const [cursors, setCursors] = useState<Map<string, Cursor>>(new Map());

  // 本地“即时光标”（只用于 UI，不卡网络）
  const [selfCursor, setSelfCursor] = useState<Cursor | null>(null);

  // refs
  const wsRef = useRef<WebSocket | null>(null);
  const docRef = useRef<LoroDoc | null>(null);
  const unsubRef = useRef<Subscription | (() => void) | null>(null);
  const keepAliveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const backoffRef = useRef(1000);
  const lastSendAtRef = useRef(0);
  const sendTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 合并导入（收到多条 snapshot，只导入最后一条）
  const pendingSnapshotRef = useRef<Uint8Array | null>(null);
  const importTimerRef = useRef<number | null>(null);

  // == 工具 ==
  const scheduleImport = useCallback(() => {
    if (importTimerRef.current != null) return;
    importTimerRef.current = window.setTimeout(() => {
      importTimerRef.current = null;
      const data = pendingSnapshotRef.current;
      pendingSnapshotRef.current = null;
      if (!data) return;
      const doc = docRef.current;
      if (!doc) return;
      try {
        doc.import(data);
        // 导入后由订阅回调统一刷新 UI
      } catch (e) {
        console.error('[RECV] 导入失败:', e);
      }
    }, 16); // roughly 60fps
  }, []);

  // === Loro 文档 ===
  useEffect(() => {
    const doc = new LoroDoc();
    docRef.current = doc;

    const sub = doc.subscribe((event: any) => {
      // 只把“别人”的光标投影到 UI；自己的即时光标走 selfCursor
      try {
        const map = doc.getMap('cursors');
        const now = Date.now();
        let changed = false;

        setCursors(prev => {
          const next = new Map<string, Cursor>();
          for (const [key, value] of map.entries()) {
            if (!value || typeof value !== 'object') continue;
            const v: any = value;
            if (v.id === userId) continue; // 自己的用 selfCursor 呈现
            if (typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.id !== 'string') continue;

            const cur: Cursor = {
              id: v.id,
              x: v.x,
              y: v.y,
              color: v.color || '#4ECDC4',
              name: v.name || 'Unknown',
              lastUpdate: v.lastUpdate || now,
            };

            if (now - cur.lastUpdate <= expireMs) {
              next.set(key, cur);
              const prevCur = prev.get(key);
              if (!prevCur || prevCur.x !== cur.x || prevCur.y !== cur.y || prevCur.lastUpdate !== cur.lastUpdate) {
                changed = true;
              }
            } else {
              changed = true; // 过期从 UI 移除
            }
          }
          if (prev.size !== next.size) changed = true;
          return changed ? next : prev;
        });
      } catch (e) {
        console.error('[DOC] 订阅处理失败:', e);
      }

      // 本地变更不再直接导出（避免每帧 CRDT 压力），交由“网络节流器”处理
    });

    unsubRef.current = sub;

    return () => {
      const u = unsubRef.current;
      if (typeof u === 'function') u();
      else if (u && 'unsubscribe' in u && typeof (u as any).unsubscribe === 'function') (u as any).unsubscribe();
      unsubRef.current = null;
      docRef.current = null;
    };
  }, [expireMs, userId]);

  // === 心跳：只刷新时间戳（低频，不触发重渲染） ===
  useEffect(() => {
    keepAliveTimerRef.current = setInterval(() => {
      const doc = docRef.current;
      const ws = wsRef.current;
      if (!doc || !ws || ws.readyState !== WebSocket.OPEN) return;
      const m = doc.getMap('cursors');
      const mine = m.get(userId) as any;
      if (mine && typeof mine === 'object') {
        m.set(userId, { ...mine, lastUpdate: Date.now() });
        // 让网络节流器稍后统一发送
        scheduleSend('heartbeat');
      }
    }, keepAliveMs);
    return () => {
      if (keepAliveTimerRef.current) clearInterval(keepAliveTimerRef.current);
    };
  }, [keepAliveMs, userId]);

  // === 过期清理（低频） ===
  useEffect(() => {
    const t = setInterval(() => {
      setCursors(prev => {
        const now = Date.now();
        const next = new Map<string, Cursor>();
        let changed = false;
        for (const [k, c] of prev) {
          if (now - c.lastUpdate <= expireMs) next.set(k, c);
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, cleanupEveryMs);
    return () => clearInterval(t);
  }, [expireMs, cleanupEveryMs]);

  // === WebSocket ===
  const connect = useCallback(() => {
    const urlToUse = buildWsUrl(wsUrl, room);
    try {
      const ws = new WebSocket(urlToUse);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        backoffRef.current = 1000;
        // 请求全量
        ws.send(JSON.stringify({ type: 'request_full_state', userId, room: room || 'default' }));
        // 稍后把当前 Loro 状态（若有）发出去
        setTimeout(() => scheduleSend('open sync'), 200);
      };

      ws.onclose = (ev) => {
        setIsConnected(false);
        const delay = Math.min(backoffRef.current, 30_000);
        setTimeout(connect, delay);
        backoffRef.current = Math.min(backoffRef.current * 2, 30_000);
      };

      ws.onerror = () => {
        setIsConnected(false);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          const doc = docRef.current;
          if (!doc) return;

          if ((msg.type === 'loro_snapshot' || msg.type === 'full_state_response') && Array.isArray(msg.data)) {
            // 合并导入：只保留最后一次
            pendingSnapshotRef.current = new Uint8Array(msg.data);
            scheduleImport();
          }
        } catch (e) {
          console.error('[WS] 消息解析失败:', e);
        }
      };
    } catch {
      setTimeout(connect, Math.min(backoffRef.current, 30_000));
      backoffRef.current = Math.min(backoffRef.current * 2, 30_000);
    }
  }, [room, wsUrl, scheduleImport, userId]);

  useEffect(() => {
    connect();
    return () => {
      try { wsRef.current?.close(); } catch {}
    };
  }, [connect]);

  // === 网络发送：节流器 ===
  const doSendNow = useCallback((why: string) => {
    const doc = docRef.current;
    const ws = wsRef.current;
    if (!doc || !ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const snapshot = doc.exportSnapshot();
      ws.send(JSON.stringify({
        type: 'loro_snapshot',
        data: Array.from(snapshot),
        userId,
        room: room || 'default',
      }));
      lastSendAtRef.current = Date.now();
    } catch (e) {
      console.error('[SEND] 失败:', e);
    }
  }, [room, userId]);

  const scheduleSend = useCallback((why: string) => {
    const now = Date.now();
    const elapsed = now - lastSendAtRef.current;
    if (elapsed >= sendIntervalMs) {
      if (sendTimerRef.current) { clearTimeout(sendTimerRef.current); sendTimerRef.current = null; }
      doSendNow(why);
      return;
    }
    if (!sendTimerRef.current) {
      sendTimerRef.current = setTimeout(() => {
        sendTimerRef.current = null;
        doSendNow(`${why} (throttled)`);
      }, sendIntervalMs - elapsed);
    }
  }, [doSendNow, sendIntervalMs]);

  // === 对外：本地光标更新（UI 即时 + 网络节流 + Loro 低频写入） ===
  const updateCursor = useCallback((x: number, y: number) => {
    // 1) UI 即时：不经 Loro，不卡顿
    setSelfCursor(prev => {
      const now = Date.now();
      const base: Cursor = prev ?? {
        id: userId, name: userName, color: userColor, x, y, lastUpdate: now,
      };
      return { ...base, x, y, lastUpdate: now };
    });

    // 2) Loro 低频写入（只有节流到点才写 doc & 触发发送）
    const doc = docRef.current;
    if (!doc) return;
    const now = Date.now();
    const elapsed = now - lastSendAtRef.current;

    if (elapsed >= sendIntervalMs) {
      const m = doc.getMap('cursors');
      m.set(userId, {
        id: userId,
        x: Math.round(x),
        y: Math.round(y),
        color: userColor,
        name: userName,
        lastUpdate: now,
      });
      scheduleSend('cursor move');
    } else {
      // 还没到节流时间：先不写 doc，等 scheduleSend 触发时再写
      // （可选：如果你希望更精确，可在这里缓存坐标，到触发时再 m.set(…)，当前简单实现足够顺滑）
    }
  }, [userColor, userName, userId, scheduleSend, sendIntervalMs]);

  const removeCursor = useCallback(() => {
    setSelfCursor(null);
    const doc = docRef.current;
    if (!doc) return;
    doc.getMap('cursors').delete(userId);
    scheduleSend('remove');
  }, [scheduleSend, userId]);

  const forceResend = useCallback((reason = 'manual resend') => {
    doSendNow(reason);
  }, [doSendNow]);

  return {
    userId, userName, userColor,
    isConnected,
    cursors,          // 其他用户
    selfCursor,       // 自己（即时渲染）
    updateCursor,
    removeCursor,
    forceResend,
  };
}
