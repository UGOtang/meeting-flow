'use client';

// hooks/useCursorSync.ts
import { useEffect, useRef, useState, useCallback } from 'react';
import { Loro, LoroDoc } from 'loro-crdt';

interface Cursor {
  id: string;
  x: number;
  y: number;
  color: string;
  name: string;
  lastUpdate: number;
}

interface UseCursorSyncOptions {
  wsUrl?: string;
  userId?: string;
  userName?: string;
  userColor?: string;
  cleanupInterval?: number;
}

export function useCursorSync(options: UseCursorSyncOptions = {}) {
  const {
    wsUrl = 'ws://192.168.5.182:3001',
    userId = `user-${Math.random().toString(36).substr(2, 9)}`,
    userName = `用户${Math.floor(Math.random() * 1000)}`,
    userColor = '#4ECDC4',
    cleanupInterval = 5000
  } = options;

  const [doc, setDoc] = useState<LoroDoc | null>(null);
  const [cursors, setCursors] = useState<Map<string, Cursor>>(new Map());
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const cleanupIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // 初始化 Loro 文档
  useEffect(() => {
    const loroDoc = new Loro();
    setDoc(loroDoc);

    // 监听文档变化
    const unsubscribe = loroDoc.subscribe((event) => {
      // 当文档发生变化时更新光标
      updateCursorsFromDoc(loroDoc);
    });

    // 建立 WebSocket 连接
    connectWebSocket(loroDoc);

    // 设置清理定时器
    cleanupIntervalRef.current = setInterval(() => {
      cleanupExpiredCursors(loroDoc);
    }, cleanupInterval);

    return () => {
      unsubscribe();
      disconnect();
      if (cleanupIntervalRef.current) {
        clearInterval(cleanupIntervalRef.current);
      }
    };
  }, []);

  // 连接 WebSocket
  const connectWebSocket = useCallback((loroDoc: LoroDoc) => {
    try {
      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onopen = () => {
        console.log('WebSocket 连接已建立');
        setIsConnected(true);
        setConnectionError(null);
        
        // 清除重连定时器
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      };

      wsRef.current.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          handleServerMessage(loroDoc, message);
        } catch (error) {
          console.error('处理服务器消息错误:', error);
        }
      };

      wsRef.current.onclose = (event) => {
        console.log('WebSocket 连接已关闭', event.code, event.reason);
        setIsConnected(false);
        
        // 自动重连
        if (event.code !== 1000) { // 不是正常关闭
          scheduleReconnect(loroDoc);
        }
      };

      wsRef.current.onerror = (error) => {
        console.error('WebSocket 错误:', error);
        setConnectionError('连接错误');
        setIsConnected(false);
      };

    } catch (error) {
      console.error('创建 WebSocket 连接错误:', error);
      setConnectionError('无法创建连接');
      scheduleReconnect(loroDoc);
    }
  }, [wsUrl]);

  // 处理服务器消息
  const handleServerMessage = useCallback((loroDoc: LoroDoc, message: any) => {
    switch (message.type) {
      case 'init':
        // 初始化文档状态
        try {
          const snapshot = new Uint8Array(message.data);
          loroDoc.import(snapshot);
        } catch (error) {
          console.error('导入初始状态错误:', error);
        }
        break;
        
      case 'update':
        // 应用文档更新
        try {
          const update = new Uint8Array(message.data);
          loroDoc.import(update);
        } catch (error) {
          console.error('应用更新错误:', error);
        }
        break;
        
      case 'cursor':
        // 直接处理光标更新
        const cursor = message.data as Cursor;
        if (cursor.id !== userId) {
          setCursors(prev => {
            const newCursors = new Map(prev);
            newCursors.set(cursor.id, cursor);
            return newCursors;
          });
        }
        break;
        
      default:
        console.warn('未知消息类型:', message.type);
    }
  }, [userId]);

  // 安排重连
  const scheduleReconnect = useCallback((loroDoc: LoroDoc) => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    
    reconnectTimeoutRef.current = setTimeout(() => {
      console.log('尝试重新连接...');
      connectWebSocket(loroDoc);
    }, 3000);
  }, [connectWebSocket]);

  // 断开连接
  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close(1000, '正常关闭');
      wsRef.current = null;
    }
    
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    
    setIsConnected(false);
  }, []);

  // 从文档更新光标状态
  const updateCursorsFromDoc = useCallback((loroDoc: LoroDoc) => {
    try {
      const cursorsMap = loroDoc.getMap('cursors');
      const newCursors = new Map<string, Cursor>();
      
      for (const [key, value] of cursorsMap.entries()) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          // 安全地转换值为 Cursor 类型
          const cursorData = value as any;
          if (cursorData.id && typeof cursorData.x === 'number' && typeof cursorData.y === 'number') {
            const cursor: Cursor = {
              id: cursorData.id,
              x: cursorData.x,
              y: cursorData.y,
              color: cursorData.color || '#4ECDC4',
              name: cursorData.name || 'Unknown',
              lastUpdate: cursorData.lastUpdate || Date.now()
            };
            
            // 过滤掉过期的光标
            if (Date.now() - cursor.lastUpdate < cleanupInterval) {
              newCursors.set(key, cursor);
            }
          }
        }
      }
      
      setCursors(newCursors);
    } catch (error) {
      console.error('更新光标状态错误:', error);
    }
  }, [cleanupInterval]);

  // 清理过期光标
  const cleanupExpiredCursors = useCallback((loroDoc: LoroDoc) => {
    try {
      const cursorsMap = loroDoc.getMap('cursors');
      const now = Date.now();
      
      for (const [key, value] of cursorsMap.entries()) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const cursorData = value as any;
          if (cursorData.lastUpdate && now - cursorData.lastUpdate > cleanupInterval) {
            cursorsMap.delete(key);
          }
        }
      }
    } catch (error) {
      console.error('清理过期光标错误:', error);
    }
  }, [cleanupInterval]);

  // 更新光标位置
  const updateCursor = useCallback((x: number, y: number) => {
    if (!doc || !isConnected) return;

    const cursor: Cursor = {
      id: userId,
      x,
      y,
      color: userColor,
      name: userName,
      lastUpdate: Date.now()
    };

    try {
      // 更新本地文档
      const cursorsMap = doc.getMap('cursors');
      cursorsMap.set(userId, cursor);

      // 发送到服务器
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        const update = doc.exportFrom();
        wsRef.current.send(JSON.stringify({
          type: 'update',
          data: Array.from(update)
        }));
      }
    } catch (error) {
      console.error('更新光标错误:', error);
    }
  }, [doc, isConnected, userId, userColor, userName]);

  // 移除光标
  const removeCursor = useCallback(() => {
    if (!doc || !isConnected) return;

    try {
      const cursorsMap = doc.getMap('cursors');
      cursorsMap.delete(userId);

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        const update = doc.exportFrom();
        wsRef.current.send(JSON.stringify({
          type: 'update',
          data: Array.from(update)
        }));
      }
    } catch (error) {
      console.error('移除光标错误:', error);
    }
  }, [doc, isConnected, userId]);

  return {
    cursors,
    isConnected,
    connectionError,
    updateCursor,
    removeCursor,
    disconnect,
    userId,
    userName,
    userColor
  };
}