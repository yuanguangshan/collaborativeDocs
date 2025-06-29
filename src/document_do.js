// src/document_do.js

import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {
    Awareness,
    applyAwarenessUpdate,
    removeAwarenessStates,
    encodeAwarenessUpdate
} from 'y-protocols/awareness.js';
import {
    readSyncMessage,
    writeSyncStep1,
    writeUpdate,
} from 'y-protocols/sync.js';

// 定义消息类型常量
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

export class DocumentDurableObject {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.sessions = new Map();
        this.ydoc = null;
        this.awareness = null;
        this.lastSave = 0;

        this.initializePromise = this.loadYDoc();
    }

    async loadYDoc() {
        await this.state.storage.transaction(async (txn) => {
            const storedYDoc = await txn.get("ydoc");

            this.ydoc = new Y.Doc();
            this.awareness = new Awareness(this.ydoc);

            if (storedYDoc) {
                console.log('Loading existing document from storage');
                Y.applyUpdate(this.ydoc, new Uint8Array(storedYDoc));
            } else {
                console.log('Creating new document');
            }

            this.ydoc.on('update', (update, origin) => {
                console.log('Document updated, broadcasting to', this.sessions.size, 'clients');
                this.broadcast(update, origin);
                this.scheduleSave();
            });

            this.awareness.on('update', ({ added, updated, removed }, origin) => {
                const changedClients = added.concat(updated, removed);
                if (changedClients.length > 0) {
                    console.log('Awareness updated for clients:', changedClients);
                    const update = encodeAwarenessUpdate(this.awareness, changedClients);
                    this.broadcastAwareness(update, origin);
                }
            });
        });
    }

    scheduleSave() {
        const now = Date.now();
        if (now - this.lastSave > 2000) {
            this.lastSave = now;
            this.state.waitUntil(this.saveYDoc());
        }
    }

    async saveYDoc() {
        try {
            await this.state.storage.transaction(async (txn) => {
                const docState = Y.encodeStateAsUpdate(this.ydoc);
                await txn.put("ydoc", docState);
                console.log('Document saved to storage');
            });
        } catch (error) {
            console.error('Failed to save document:', error);
        }
    }

    async fetch(request) {
        console.log('DO fetch called:', request.url);
        console.log('Headers:', Object.fromEntries(request.headers.entries()));
        
        await this.initializePromise;

        return this.state.blockConcurrencyWhile(async () => {
            const upgradeHeader = request.headers.get("Upgrade");
            console.log('Upgrade header:', upgradeHeader);
            
            if (upgradeHeader !== "websocket") {
                console.log('Not a WebSocket request, returning 426');
                return new Response("Expected Upgrade: websocket", { status: 426 });
            }

            console.log('Creating WebSocket pair');
            const { 0: client, 1: server } = new WebSocketPair();
            
            try {
                await this.handleSession(server);
                console.log('WebSocket session created successfully');
                
                return new Response(null, {
                    status: 101,
                    webSocket: client
                });
            } catch (error) {
                console.error('Error creating WebSocket session:', error);
                return new Response("Error creating WebSocket session", { status: 500 });
            }
        });
    }

    async handleSession(ws) {
        console.log('Handling new WebSocket session');
        ws.accept();

        const sessionId = Math.random().toString(36).substr(2, 9);
        const session = {
            id: sessionId,
            ws,
            awareness: new Set(),
        };
        this.sessions.set(ws, session);
        console.log('Session', sessionId, 'added. Total sessions:', this.sessions.size);

        // 发送初始同步数据
        try {
            // 1. 发送 Sync Step 1
            const encoder1 = encoding.createEncoder();
            encoding.writeVarUint(encoder1, MESSAGE_SYNC);
            writeSyncStep1(encoder1, this.ydoc);
            this.sendMessage(ws, encoding.toUint8Array(encoder1));
            console.log('Sent sync step 1 to session', sessionId);

            // 2. 发送当前 Awareness 状态
            const awarenessStates = this.awareness.getStates();
            if (awarenessStates.size > 0) {
                const awarenessUpdate = encodeAwarenessUpdate(this.awareness, Array.from(awarenessStates.keys()));
                this.sendAwareness(ws, awarenessUpdate);
                console.log('Sent awareness state to session', sessionId);
            }
        } catch (error) {
            console.error('Error sending initial data to session', sessionId, ':', error);
        }

        // 监听消息
        ws.addEventListener("message", (event) => {
            try {
                const message = new Uint8Array(event.data);
                this.handleMessage(ws, message);
            } catch (err) {
                console.error('Failed to handle message for session', sessionId, ':', err);
                ws.close(1011, "Error handling message");
            }
        });

        // 监听关闭和错误事件
        ws.addEventListener("close", (event) => {
            console.log('Session', sessionId, 'closed:', event.code, event.reason);
            this.handleClose(ws);
        });
        
        ws.addEventListener("error", (err) => {
            console.error('WebSocket error for session', sessionId, ':', err);
            this.handleClose(ws);
        });
    }

    handleMessage(ws, message) {
        const session = this.sessions.get(ws);
        if (!session) {
            console.warn('Received message from unknown session');
            return;
        }

        try {
            const decoder = decoding.createDecoder(message);
            const messageType = decoding.readVarUint(decoder);

            switch (messageType) {
                case MESSAGE_SYNC: {
                    console.log('Handling sync message from session', session.id);
                    const encoder = encoding.createEncoder();
                    encoding.writeVarUint(encoder, MESSAGE_SYNC);
                    readSyncMessage(decoder, encoder, this.ydoc, ws);
                    
                    const response = encoding.toUint8Array(encoder);
                    if (response.length > 1) {
                        this.sendMessage(ws, response);
                    }
                    break;
                }
                case MESSAGE_AWARENESS: {
                    console.log('Handling awareness message from session', session.id);
                    const awarenessUpdate = decoding.readVarUint8Array(decoder);
                    applyAwarenessUpdate(this.awareness, awarenessUpdate, ws);
                    break;
                }
                default:
                    console.warn('Unknown message type:', messageType, 'from session', session.id);
            }
        } catch (error) {
            console.error('Error handling message from session', session.id, ':', error);
        }
    }

    handleClose(ws) {
        const session = this.sessions.get(ws);
        if (!session) return;

        console.log('Cleaning up session', session.id);

        // 从 Awareness 中移除该会话的状态
        try {
            const awarenessStates = this.awareness.getStates();
            const clientIds = [];
            
            for (const [id, state] of awarenessStates.entries()) {
                // 检查状态是否属于这个连接
                if (state && (state.origin === ws || state.clientID === session.id)) {
                    clientIds.push(id);
                }
            }
            
            if (clientIds.length > 0) {
                removeAwarenessStates(this.awareness, clientIds, ws);
                console.log('Removed awareness states for session', session.id);
            }
        } catch (error) {
            console.error('Error removing awareness states for session', session.id, ':', error);
        }
        
        this.sessions.delete(ws);
        console.log('Session', session.id, 'removed. Total sessions:', this.sessions.size);
    }

    sendMessage(ws, message) {
        try {
            ws.send(message);
        } catch (err) {
            console.error('Failed to send message:', err);
            this.handleClose(ws);
        }
    }

    sendAwareness(ws, message) {
        const envelope = encoding.createEncoder();
        encoding.writeVarUint(envelope, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(envelope, message);
        this.sendMessage(ws, encoding.toUint8Array(envelope));
    }

    broadcast(update, origin) {
        if (this.sessions.size === 0) return;

        const envelope = encoding.createEncoder();
        encoding.writeVarUint(envelope, MESSAGE_SYNC);
        writeUpdate(envelope, update);
        const message = encoding.toUint8Array(envelope);

        let sentCount = 0;
        this.sessions.forEach((session, ws) => {
            if (ws !== origin) {
                this.sendMessage(ws, message);
                sentCount++;
            }
        });
        
        console.log('Broadcasted sync update to', sentCount, 'sessions');
    }

    broadcastAwareness(update, origin) {
        if (this.sessions.size === 0) return;

        const envelope = encoding.createEncoder();
        encoding.writeVarUint(envelope, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(envelope, update);
        const message = encoding.toUint8Array(envelope);

        let sentCount = 0;
        this.sessions.forEach((session, ws) => {
            if (ws !== origin) {
                this.sendMessage(ws, message);
                sentCount++;
            }
        });
        
        console.log('Broadcasted awareness update to', sentCount, 'sessions');
    }
}