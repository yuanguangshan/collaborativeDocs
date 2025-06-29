// src/worker.js

import html from '../public/index.html';
import { DocumentDurableObject } from './document_do.js';

export { DocumentDurableObject };

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathParts = url.pathname.split('/').filter(part => part); // 移除空字符串

        console.log('Worker received request:', request.url);
        console.log('Path parts:', pathParts);

        if (pathParts.length === 0) {
            return new Response('Not Found. Please access /<document-name>', { status: 404 });
        }

        const documentId = pathParts[0]; // 第一个路径段作为文档ID
        const upgradeHeader = request.headers.get("Upgrade");
        const isWebSocket = upgradeHeader === "websocket";

        console.log('Document ID:', documentId);
        console.log('Is WebSocket:', isWebSocket);

        // WebSocket 请求处理
        if (isWebSocket) {
            console.log('Routing WebSocket to DO for document:', documentId);
            const doId = env.DOCUMENT_DO.idFromName(documentId);
            const stub = env.DOCUMENT_DO.get(doId);
            return stub.fetch(request);
        }

        // API 请求处理（如果有其他子路径）
        if (pathParts.length > 1) {
            console.log('Routing API request to DO for document:', documentId);
            const doId = env.DOCUMENT_DO.idFromName(documentId);
            const stub = env.DOCUMENT_DO.get(doId);
            return stub.fetch(request);
        }

        // 默认返回 HTML 页面
        console.log('Serving HTML page for document:', documentId);
        return new Response(html, {
            headers: { 'Content-Type': 'text/html;charset=UTF-8' },
        });
    },
};