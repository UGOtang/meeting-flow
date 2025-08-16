'use client';

import { useState, useRef, useEffect } from 'react';
import { Loro } from 'loro-crdt';

// ... Cursor 组件代码保持不变 ...
const Cursor = ({ x, y, name, color }) => (
    <div
      className="cursor"
      style={{
        transform: `translate(${x}px, ${y}px)`,
        '--cursor-color': color,
      }}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24" fill="var(--cursor-color)" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"></path><path d="M13 13l6 6"></path></svg>
      <div className="cursor-label" style={{ backgroundColor: color }}>
        {name}
      </div>
    </div>
  );

export default function CursorChat() {
  const docRef = useRef(null);
  const wsRef = useRef(null);
  const [cursors, setCursors] = useState({});
  const userInfo = useRef({
    id: "user_" + Math.random().toString(36).substring(2, 9),
    name: "User-" + Math.floor(Math.random() * 100),
    color: `hsl(${Math.random() * 360}, 90%, 65%)`,
  });

  useEffect(() => {
    console.log(`[INIT] 组件初始化，用户 ID: ${userInfo.current.id}`);
    
    const doc = new Loro();
    const cursorsMap = doc.getMap("cursors");
    docRef.current = { doc, cursorsMap };

    const ws = new WebSocket('ws://192.168.5.182:8080');
    wsRef.current = ws;

    ws.onopen = () => console.log('[WS] ✅ WebSocket 已连接');
    ws.onerror = (err) => console.error('[WS] ❌ WebSocket 错误', err);
    ws.onclose = () => console.log('[WS] 🔌 WebSocket 已关闭');

    ws.onmessage = async (event) => {
      const remoteUpdate = new Uint8Array(await event.data.arrayBuffer());
      console.log(`[WS] 📥 收到远程更新，大小: ${remoteUpdate.byteLength} bytes`);
      doc.import(remoteUpdate);
    };

    const sub = doc.subscribe((event) => {
      console.log('[LORO] 🔄 Loro 文档发生变化', { local: event.local });
      const newCursorsState = cursorsMap.getDeepValue();
      setCursors(newCursorsState);
      
      console.log('[REACT] 🎨 正在更新 React State:', newCursorsState);
      
      if (event.local) {
        const localUpdate = doc.exportFrom(event.version);
        console.log(`[LORO] 📤 导出本地更新，大小: ${localUpdate.byteLength} bytes`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(localUpdate);
          console.log('[WS] 🚀 已发送本地更新到服务器');
        }
      }
    });

    const handleMouseMove = (event) => {
      // 为了避免日志刷屏，这个日志可以只在调试时打开
      // console.log(`[EVENT] 鼠标移动: ${event.clientX}, ${event.clientY}`);
      cursorsMap.set(userInfo.current.id, {
        x: event.clientX,
        y: event.clientY,
        ...userInfo.current,
      });
    };
    
    const handleMouseLeave = () => {
      console.log('[EVENT] 鼠标离开窗口');
      cursorsMap.delete(userInfo.current.id);
    }
    
    window.addEventListener('mousemove', handleMouseMove);
    document.body.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      console.log(`[CLEANUP] 组件卸载，清理用户 ${userInfo.current.id}`);
      sub.unsubscribe();
      cursorsMap.delete(userInfo.current.id); // 发送最后一次更新
      ws.close();
      window.removeEventListener('mousemove', handleMouseMove);
      document.body.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, []);

  // 在 JSX 中添加日志，检查渲染状态
  console.log('[RENDER] 正在渲染组件，Cursors State:', cursors);
  const otherUsersCursors = Object.entries(cursors).filter(([id]) => id !== userInfo.current.id);

  return (
    <div className="cursor-chat-container">
      {otherUsersCursors.length > 0 && console.log(`[RENDER] 发现 ${otherUsersCursors.length} 个其他用户光标`)}
      {otherUsersCursors.map(([id, data]) => (
          <Cursor key={id} {...data} />
        ))}
    </div>
  );
}