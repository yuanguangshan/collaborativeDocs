// src/document_do.js

// --- 依赖导入 ---
// 导入 Y.js 核心库，它提供了 CRDT 的数据结构，如 Y.Doc
import * as Y from 'yjs';
// 导入 lib0 库中的编码和解码工具，用于高效地处理二进制数据
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
// 从 y-protocols 中导入 Awareness（用户在线状态）协议相关的功能
// Awareness 用于同步非持久化状态，如光标位置、用户名、选区等
import {
    Awareness,
    applyAwarenessUpdate, // 将收到的 awareness 更新应用到本地 awareness 实例
    removeAwarenessStates, // 从 awareness 实例中移除指定客户端的状态
    encodeAwarenessUpdate // 将本地 awareness 的变更编码成可传输的二进制格式
} from 'y-protocols/awareness.js';
// 从 y-protocols 中导入 Sync（文档同步）协议相关的功能
import {
    readSyncMessage, // 读取并处理同步消息，自动更新 Y.Doc 并生成响应
    writeSyncStep1, // 写入同步协议的第一步消息（发送本地文档的状态向量）
    writeUpdate, // 将 Y.Doc 的更新数据写入消息中
} from 'y-protocols/sync.js';

// --- 自定义消息协议 ---
// 定义一个简单的消息信封协议，用于区分不同类型的消息
// 这样做的好处是可以在同一个 WebSocket 连接上传输多种类型的数据
const MESSAGE_SYNC = 0; // 消息类型 0: 代表这是一个文档同步消息
const MESSAGE_AWARENESS = 1; // 消息类型 1: 代表这是一个用户在线状态（光标等）的消息

// --- Durable Object 类定义 ---
// DocumentDurableObject 是一个为单个文档服务的、有状态的后端。
// 每个文档ID都会对应一个独立的此类的实例。
export class DocumentDurableObject {
    // 构造函数在 Durable Object 实例首次被创建或从休眠中唤醒时调用
    constructor(state, env) {
        // `state` 对象由 Cloudflare 运行时注入，用于访问存储和管理并发
        this.state = state;
        // `env` 对象包含环境变量和绑定
        this.env = env;
        // `sessions` 用于存储所有连接到此文档的 WebSocket 会话
        // Map 的键是 WebSocket 对象，值是包含会话信息的对象
        this.sessions = new Map();
        // `ydoc` 将持有 Y.js 的文档实例，它是所有协作数据的“唯一真实来源”
        this.ydoc = null;
        // `awareness` 将持有此文档关联的 Awareness 实例，管理所有用户的在线状态
        this.awareness = null;
        // `lastSave` 用于实现对存储的节流写入，避免过于频繁地操作
        this.lastSave = 0;

        // **关键模式**: 由于构造函数不能是异步的，我们将所有异步初始化工作
        // 放入一个单独的方法中，并用一个 Promise (`initializePromise`) 来跟踪其完成状态。
        // 在处理任何请求之前，我们都会先 `await` 这个 Promise。
        this.initializePromise = this.loadYDoc();
    }

    // 异步加载 Y.Doc 的内容，或创建一个新的
    async loadYDoc() {
        // 使用事务来确保对存储的读写操作是原子性的
        await this.state.storage.transaction(async (txn) => {
            // 从持久化存储中获取之前保存的 ydoc 状态
            const storedYDoc = await txn.get("ydoc");

            // 初始化 Y.Doc 和 Awareness 实例
            this.ydoc = new Y.Doc();
            this.awareness = new Awareness(this.ydoc);

            if (storedYDoc) {
                // 如果存储中有数据，说明这是一个已存在的文档
                console.log('从存储中加载现有文档');
                // 使用 `Y.applyUpdate` 将二进制数据恢复为 Y.Doc 的状态
                Y.applyUpdate(this.ydoc, new Uint8Array(storedYDoc));
            } else {
                // 如果存储中没有数据，说明这是一个全新的文档
                console.log('创建新文档');
            }

            // --- 设置事件监听器 ---

            // 监听 ydoc 的 'update' 事件。当文档内容发生任何变化时，此事件会被触发。
            this.ydoc.on('update', (update, origin) => {
                // `update` 是一个包含变更信息的二进制数据
                // `origin` 是触发此次更新的源头（例如某个 WebSocket 连接），用于避免消息回传
                console.log('文档已更新，向', this.sessions.size, '个客户端广播');
                // 将变更广播给所有其他连接的客户端
                this.broadcast(update, origin);
                // 安排一次保存操作，将最新状态持久化到存储中
                this.scheduleSave();
            });

            // 监听 awareness 的 'update' 事件。当任何用户的在线状态（光标等）变化时触发。
            this.awareness.on('update', ({ added, updated, removed }, origin) => {
                // `added`, `updated`, `removed` 是发生变化的客户端ID列表
                const changedClients = added.concat(updated, removed);
                if (changedClients.length > 0) {
                    console.log('以下客户端的 Awareness 已更新:', changedClients);
                    // 将这些变化编码成一个可传输的更新消息
                    const update = encodeAwarenessUpdate(this.awareness, changedClients);
                    // 将 awareness 更新广播给所有其他客户端
                    this.broadcastAwareness(update, origin);
                }
            });
        });
    }

    // 安排一次节流的保存操作
    scheduleSave() {
        const now = Date.now();
        // 检查距离上次保存是否已超过2秒，以避免过于频繁的写入
        if (now - this.lastSave > 2000) {
            this.lastSave = now;
            // 使用 `state.waitUntil` 可以在不阻塞当前请求响应的情况下，在后台执行异步任务。
            // 这对于保存操作非常理想，因为它不影响用户体验。
            this.state.waitUntil(this.saveYDoc());
        }
    }

    // 将 Y.Doc 的当前状态完整地保存到持久化存储中
    async saveYDoc() {
        try {
            await this.state.storage.transaction(async (txn) => {
                // `Y.encodeStateAsUpdate` 将整个 Y.Doc 编码成一个单一的、包含所有历史的更新。
                // 这使得从零恢复文档状态非常简单。
                const docState = Y.encodeStateAsUpdate(this.ydoc);
                await txn.put("ydoc", docState);
                console.log('文档已保存到存储');
            });
        } catch (error) {
            console.error('保存文档失败:', error);
        }
    }

    // `fetch` 是 Durable Object 的主入口点，处理所有传入的 HTTP/WebSocket 请求
    async fetch(request) {
        console.log('DO fetch 被调用:', request.url);
        console.log('请求头:', Object.fromEntries(request.headers.entries()));
        
        // 在处理任何逻辑之前，首先确保异步初始化已完成
        await this.initializePromise;

        // **核心**: 使用 `blockConcurrencyWhile` 来保证所有对该实例的操作都是串行执行的。
        // 这意味着我们无需担心竞态条件，极大地简化了状态管理。
        return this.state.blockConcurrencyWhile(async () => {
            // 检查请求是否是 WebSocket 升级请求
            const upgradeHeader = request.headers.get("Upgrade");
            console.log('Upgrade header:', upgradeHeader);
            
            if (upgradeHeader !== "websocket") {
                console.log('非 WebSocket 请求，返回 426');
                return new Response("Expected Upgrade: websocket", { status: 426 });
            }

            // 创建一个 WebSocket 对，一个用于客户端，一个用于服务器端（即此 DO 内部）
            console.log('创建 WebSocket 对');
            const { 0: client, 1: server } = new WebSocketPair();
            
            try {
                // 处理新的 WebSocket 会话
                await this.handleSession(server);
                console.log('WebSocket 会话创建成功');
                
                // 返回客户端 WebSocket，完成 WebSocket 升级握手
                return new Response(null, {
                    status: 101, // 101 Switching Protocols
                    webSocket: client
                });
            } catch (error) {
                console.error('创建 WebSocket 会话时出错:', error);
                return new Response("创建 WebSocket 会话时出错", { status: 500 });
            }
        });
    }

    // 处理一个新的 WebSocket 连接会话
    async handleSession(ws) {
        console.log('处理新的 WebSocket 会话');
        // 接受 WebSocket 连接，这在 Durable Object 中是必需的
        ws.accept();

        // 为会话创建一个唯一ID并存储它
        const sessionId = Math.random().toString(36).substr(2, 9);
        const session = {
            id: sessionId,
            ws,
            awareness: new Set(), // 可用于跟踪此会话相关的 awareness 状态
        };
        this.sessions.set(ws, session);
        console.log('会话', sessionId, '已添加。总会话数:', this.sessions.size);

        // --- 向新连接的客户端发送初始同步数据 ---
        try {
            // 1. 发送同步协议的第一步 (Sync Step 1)
            //    这会告诉客户端服务器当前的文档状态向量(State Vector)，
            //    客户端收到后会计算出差异，并将自己缺少的更新发回给服务器。
            const encoder1 = encoding.createEncoder();
            encoding.writeVarUint(encoder1, MESSAGE_SYNC); // 写入消息类型
            writeSyncStep1(encoder1, this.ydoc); // 写入 Sync Step 1 数据
            this.sendMessage(ws, encoding.toUint8Array(encoder1)); // 发送消息
            console.log('已向会话', sessionId, '发送同步第一步');

            // 2. 发送当前所有用户的 Awareness 状态
            const awarenessStates = this.awareness.getStates();
            if (awarenessStates.size > 0) {
                // 将所有已知的 awareness 状态编码成一个更新消息
                const awarenessUpdate = encodeAwarenessUpdate(this.awareness, Array.from(awarenessStates.keys()));
                this.sendAwareness(ws, awarenessUpdate); // 发送给新客户端
                console.log('已向会话', sessionId, '发送 awareness 状态');
            }
        } catch (error)
        {
            console.error('向会话', sessionId, '发送初始数据时出错:', error);
        }

        // --- 为 WebSocket 设置事件监听器 ---

        // 监听来自客户端的消息
        ws.addEventListener("message", (event) => {
            try {
                const message = new Uint8Array(event.data);
                this.handleMessage(ws, message); // 交给消息处理器处理
            } catch (err) {
                console.error('处理会话', sessionId, '的消息失败:', err);
                ws.close(1011, "处理消息时出错");
            }
        });

        // 监听连接关闭事件
        ws.addEventListener("close", (event) => {
            console.log('会话', sessionId, '已关闭:', event.code, event.reason);
            this.handleClose(ws); // 执行清理操作
        });
        
        // 监听错误事件
        ws.addEventListener("error", (err) => {
            console.error('会话', sessionId, '发生 WebSocket 错误:', err);
            this.handleClose(ws); // 执行清理操作
        });
    }

    // 处理从客户端收到的二进制消息
    handleMessage(ws, message) {
        const session = this.sessions.get(ws);
        if (!session) {
            console.warn('收到来自未知会话的消息');
            return;
        }

        try {
            const decoder = decoding.createDecoder(message);
            // 读取消息信封中的消息类型
            const messageType = decoding.readVarUint(decoder);

            // 根据消息类型进行分发处理
            switch (messageType) {
                case MESSAGE_SYNC: {
                    console.log('正在处理来自会话', session.id, '的同步消息');
                    const encoder = encoding.createEncoder();
                    encoding.writeVarUint(encoder, MESSAGE_SYNC); // 准备响应消息的信封
                    // `readSyncMessage` 是 y-protocols 的核心函数。它会：
                    // 1. 解码收到的同步消息（可能是 Sync Step 2 或直接的 Update）。
                    // 2. 将其中包含的更新应用到服务端的 `this.ydoc`。
                    // 3. 自动向 `encoder` 中写入必要的响应（例如，如果客户端需要更多更新）。
                    readSyncMessage(decoder, encoder, this.ydoc, ws);
                    
                    const response = encoding.toUint8Array(encoder);
                    // 如果 `encoder` 中写入了数据（长度>1是因为消息类型占了1个字节），则将其发回客户端
                    if (response.length > 1) {
                        this.sendMessage(ws, response);
                    }
                    break;
                }
                case MESSAGE_AWARENESS: {
                    console.log('正在处理来自会话', session.id, '的 awareness 消息');
                    // `readVarUint8Array` 用于读取消息体
                    const awarenessUpdate = decoding.readVarUint8Array(decoder);
                    // 将收到的 awareness 更新应用到服务端的共享 `awareness` 实例中。
                    // `ws` 作为 origin 参数，这样 `awareness.on('update')` 事件可以知道是谁触发了更新。
                    applyAwarenessUpdate(this.awareness, awarenessUpdate, ws);
                    break;
                }
                default:
                    console.warn('未知消息类型:', messageType, '来自会话', session.id);
            }
        } catch (error) {
            console.error('处理来自会话', session.id, '的消息时出错:', error);
        }
    }

    // 处理 WebSocket 连接关闭的清理工作
    handleClose(ws) {
        const session = this.sessions.get(ws);
        if (!session) return;

        console.log('正在清理会话', session.id);

        // 从共享的 Awareness 状态中移除这个已断开连接的客户端
        // 这是为了确保其他用户能看到这个用户的光标消失
        try {
            const awarenessStates = this.awareness.getStates();
            const clientIds = [];
            
            // 遍历所有 awareness 状态，找到属于这个会话的客户端ID
            for (const [id, state] of awarenessStates.entries()) {
                // 这里的检查逻辑可以根据客户端实现进行调整
                if (state && (state.origin === ws || state.clientID === session.id)) {
                    clientIds.push(id);
                }
            }
            
            if (clientIds.length > 0) {
                // `removeAwarenessStates` 会触发一个 'update' 事件，从而通知其他所有客户端
                removeAwarenessStates(this.awareness, clientIds, ws);
                console.log('已为会话', session.id, '移除 awareness 状态');
            }
        } catch (error) {
            console.error('为会话', session.id, '移除 awareness 状态时出错:', error);
        }
        
        // 从会话列表中删除此会话
        this.sessions.delete(ws);
        console.log('会话', session.id, '已移除。总会话数:', this.sessions.size);
    }

    // --- 消息发送辅助方法 ---

    // 发送单个消息的底层方法
    sendMessage(ws, message) {
        try {
            ws.send(message);
        } catch (err) {
            console.error('发送消息失败:', err);
            // 如果发送失败（例如连接已意外关闭），则执行清理
            this.handleClose(ws);
        }
    }

    // 发送一个带有 awareness 信封的消息
    sendAwareness(ws, message) {
        const envelope = encoding.createEncoder();
        encoding.writeVarUint(envelope, MESSAGE_AWARENESS); // 写入消息类型
        encoding.writeVarUint8Array(envelope, message); // 写入消息体
        this.sendMessage(ws, encoding.toUint8Array(envelope));
    }

    // 将文档更新广播给所有连接的客户端
    broadcast(update, origin) {
        if (this.sessions.size === 0) return;

        // 创建一个包含 Sync 消息的信封
        const envelope = encoding.createEncoder();
        encoding.writeVarUint(envelope, MESSAGE_SYNC);
        writeUpdate(envelope, update); // 将 Y.Doc 的更新写入信封
        const message = encoding.toUint8Array(envelope);

        let sentCount = 0;
        this.sessions.forEach((session, ws) => {
            // 避免将消息发回给触发更新的源头
            if (ws !== origin) {
                this.sendMessage(ws, message);
                sentCount++;
            }
        });
        
        console.log('已向', sentCount, '个会话广播同步更新');
    }

    // 将 awareness 更新广播给所有连接的客户端
    broadcastAwareness(update, origin) {
        if (this.sessions.size === 0) return;

        // 创建一个包含 Awareness 消息的信封
        const envelope = encoding.createEncoder();
        encoding.writeVarUint(envelope, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(envelope, update);
        const message = encoding.toUint8Array(envelope);

        let sentCount = 0;
        this.sessions.forEach((session, ws) => {
            // 避免将消息发回给触发更新的源头
            if (ws !== origin) {
                this.sendMessage(ws, message);
                sentCount++;
            }
        });
        
        console.log('已向', sentCount, '个会话广播 awareness 更新');
    }
}