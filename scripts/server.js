// server.js
const { WebSocketServer } = require('ws');
const { URL } = require('url');

const PORT = process.env.PORT || 3001;

class CursorSyncServer {
  constructor() {
    this.rooms = new Map(); // 房间 -> Set<WebSocket>
    this.clientRooms = new Map(); // WebSocket -> 房间名
    this.roomStates = new Map(); // 房间 -> 最新的完整状态快照
    this.setupServer();
  }

  setupServer() {
    const wss = new WebSocketServer({ 
      port: PORT,
      perMessageDeflate: false
    });

    wss.on('connection', (ws, request) => {
      console.log(`[SERVER] 新连接: ${request.socket.remoteAddress}`);
      
      // 解析房间参数
      const url = new URL(request.url, `http://${request.headers.host}`);
      const room = url.searchParams.get('room') || 'default';
      
      // 将客户端加入房间
      this.joinRoom(ws, room);
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(ws, message);
        } catch (error) {
          console.error('[SERVER] 消息解析错误:', error);
        }
      });

      ws.on('close', () => {
        console.log('[SERVER] 客户端断开连接');
        this.leaveRoom(ws);
      });

      ws.on('error', (error) => {
        console.error('[SERVER] WebSocket 错误:', error);
        this.leaveRoom(ws);
      });

      // 发送欢迎消息
      ws.send(JSON.stringify({
        type: 'welcome',
        room: room,
        message: `已加入房间: ${room}`
      }));
    });

    console.log(`🚀 光标同步服务器启动在端口 ${PORT}`);
    console.log(`📡 WebSocket 地址: ws://localhost:${PORT}`);
    console.log(`🏠 支持房间参数: ws://localhost:${PORT}?room=your-room`);
  }

  // 加入房间
  joinRoom(ws, room) {
    // 如果客户端已经在其他房间，先离开
    this.leaveRoom(ws);
    
    // 初始化房间
    if (!this.rooms.has(room)) {
      this.rooms.set(room, new Set());
    }
    
    // 加入新房间
    this.rooms.get(room).add(ws);
    this.clientRooms.set(ws, room);
    
    console.log(`[SERVER] 客户端加入房间: ${room}, 房间人数: ${this.rooms.get(room).size}`);
  }

  // 离开房间
  leaveRoom(ws) {
    const currentRoom = this.clientRooms.get(ws);
    if (currentRoom && this.rooms.has(currentRoom)) {
      this.rooms.get(currentRoom).delete(ws);
      
      // 如果房间空了，删除房间
      if (this.rooms.get(currentRoom).size === 0) {
        this.rooms.delete(currentRoom);
        console.log(`[SERVER] 删除空房间: ${currentRoom}`);
      } else {
        console.log(`[SERVER] 客户端离开房间: ${currentRoom}, 剩余人数: ${this.rooms.get(currentRoom).size}`);
      }
    }
    this.clientRooms.delete(ws);
  }

  // 处理客户端消息
  handleMessage(ws, message) {
    const { type, data, userId, room } = message;
    
    console.log(`[SERVER] 收到消息: type=${type}, userId=${userId}, room=${room}, dataSize=${data?.length || 0}`);
    
    switch (type) {
      case 'loro_snapshot':
        // 保存房间状态
        this.updateRoomState(room || this.clientRooms.get(ws), message.data);
        this.broadcastToRoom(ws, message);
        break;
        
      case 'request_full_state':
        // 发送完整房间状态
        this.sendFullState(ws, room || this.clientRooms.get(ws));
        break;
        
      case 'ping':
        // 心跳响应
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
        
      default:
        console.warn(`[SERVER] 未知消息类型: ${type}`);
    }
  }

  // 向房间内其他客户端广播消息
  broadcastToRoom(senderWs, message) {
    const room = this.clientRooms.get(senderWs);
    if (!room || !this.rooms.has(room)) {
      console.warn('[SERVER] 发送者不在任何房间中');
      return;
    }

    const roomClients = this.rooms.get(room);
    const messageStr = JSON.stringify(message);
    let sentCount = 0;

    roomClients.forEach(ws => {
      if (ws !== senderWs && ws.readyState === 1) { // WebSocket.OPEN = 1
        try {
          ws.send(messageStr);
          sentCount++;
        } catch (error) {
          console.error('[SERVER] 发送消息失败:', error);
          // 移除无效的连接
          roomClients.delete(ws);
          this.clientRooms.delete(ws);
        }
      }
    });

    console.log(`[SERVER] 广播到房间 ${room}: 发送给 ${sentCount} 个客户端`);
  }

  // 更新房间状态
  updateRoomState(room, data) {
    if (!room || !data) return;
    
    this.roomStates.set(room, {
      data: data,
      timestamp: Date.now()
    });
    
    console.log(`[SERVER] 更新房间 ${room} 状态, 数据大小: ${data.length}`);
  }

  // 发送完整房间状态
  sendFullState(ws, room) {
    if (!room) {
      console.warn('[SERVER] 无法发送完整状态，房间名为空');
      return;
    }

    const roomState = this.roomStates.get(room);
    
    if (!roomState) {
      console.log(`[SERVER] 房间 ${room} 暂无状态，发送空状态`);
      // 发送空状态响应
      ws.send(JSON.stringify({
        type: 'full_state_response',
        room: room,
        data: [],
        isEmpty: true
      }));
      return;
    }

    console.log(`[SERVER] 发送房间 ${room} 完整状态给客户端，数据大小: ${roomState.data.length}`);
    
    try {
      ws.send(JSON.stringify({
        type: 'full_state_response',
        room: room,
        data: roomState.data,
        timestamp: roomState.timestamp
      }));
    } catch (error) {
      console.error('[SERVER] 发送完整状态失败:', error);
    }
  }

  // 获取服务器状态
  getStats() {
    const totalClients = Array.from(this.rooms.values())
      .reduce((sum, clients) => sum + clients.size, 0);
    
    const roomStats = Array.from(this.rooms.entries())
      .map(([room, clients]) => ({ room, clients: clients.size }));

    return {
      totalClients,
      totalRooms: this.rooms.size,
      rooms: roomStats
    };
  }

  // 定期输出统计信息
  startStatsLogger() {
    setInterval(() => {
      const stats = this.getStats();
      if (stats.totalClients > 0) {
        console.log(`[STATS] 总客户端: ${stats.totalClients}, 房间数: ${stats.totalRooms}`);
        stats.rooms.forEach(({ room, clients }) => {
          console.log(`  - 房间 "${room}": ${clients} 个客户端`);
        });
      }
    }, 30000); // 30秒输出一次
  }
}

// 启动服务器
const server = new CursorSyncServer();
server.startStatsLogger();

// 优雅关闭处理
function gracefulShutdown() {
  console.log('\n[SERVER] 正在关闭服务器...');
  
  // 通知所有客户端服务器即将关闭
  for (const [room, clients] of server.rooms.entries()) {
    const shutdownMessage = JSON.stringify({
      type: 'server_shutdown',
      message: '服务器正在关闭'
    });
    
    clients.forEach(ws => {
      if (ws.readyState === 1) {
        try {
          ws.send(shutdownMessage);
          ws.close(1000, '服务器关闭');
        } catch (error) {
          console.error('[SERVER] 关闭客户端连接时出错:', error);
        }
      }
    });
  }
  
  setTimeout(() => {
    console.log('[SERVER] 服务器已关闭');
    process.exit(0);
  }, 1000);
}

// 监听关闭信号
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// 错误处理
process.on('uncaughtException', (error) => {
  console.error('[SERVER] 未捕获的异常:', error);
  gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[SERVER] 未处理的 Promise 拒绝:', reason);
});

console.log('[SERVER] 服务器已启动，按 Ctrl+C 停止');

module.exports = CursorSyncServer;
