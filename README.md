# 全球实时协作文档

这是一个基于 Cloudflare Workers 和 Durable Objects 构建的高性能、全球分布式的实时协作文档应用。在 Gemini 和 Claude 的帮助下，我们克服了诸多挑战，最终实现了这个项目。

## ✨ 项目亮点

- **无冲突协同编辑**: 多个用户可以同时编辑同一文档，所有更改都会被无缝合并，不会出现数据覆盖或冲突。
- **毫秒级实时同步**: 基于 WebSocket 和边缘计算架构，用户的编辑操作能够以极低的延迟同步给所有协作者。
- **持久化存储**: 所有文档内容都会被自动、安全地存储，即使服务器重启或服务中断，数据也不会丢失。
- **全球分布式**: 部署在 Cloudflare 的全球边缘网络，用户可以就近接入，享受最快的访问速度。
- **无服务器架构**: 无需管理传统服务器，系统可根据使用量自动弹性伸缩，极大简化了运维成本。

## 🚀 技术实现

本项目巧妙地结合了多种前沿技术，构建了一个简洁而强大的实时系统。

### 核心架构

- **Cloudflare Workers**: 作为应用的入口，负责处理 HTTP 请求和 WebSocket 连接请求。它通过检查请求头中的 `Upgrade: websocket` 来智能路由流量，将普通网页访问返回前端 HTML，将 WebSocket 连接请求转发给对应的 Durable Object。

- **Cloudflare Durable Objects**: 这是实现有状态协同编辑的核心。每一个独立的文档都由一个专属的 Durable Object 实例进行管理。这种架构天然地解决了状态隔离问题，其内置的 `blockConcurrencyWhile` 机制确保了所有操作（如用户编辑、新用户连接）都是串行处理的，从根本上杜绝了竞态条件。

### 协同编辑与数据同步

- **CRDTs (无冲突复制数据类型)**: 我们在项目中采用了业界领先的 `Y.js` 库来实现协同编辑。客户端不再发送完整的文档内容，而是发送描述变化的增量操作（Operation）。

- **Y.js 协议**: 后端的 Durable Object 能够完全理解并处理 `y-protocols`（包括 `sync` 和 `awareness` 协议）。它接收客户端发来的增量更新，将其合并到服务端的 `Y.Doc` 中，并将合并后的结果广播给所有其他连接的客户端，从而实现无冲突同步。

- **Awareness (在线状态)**: 通过 `awareness` 协议，我们实现了用户在线状态、光标位置等实时信息的同步，提供了更丰富的协作体验。

### 持久化方案

- **Durable Object Storage**: 我们利用 Durable Object 内置的、事务性的存储 API (`state.storage`)。每当文档内容发生变化时，我们会将整个 `Y.Doc` 文档的状态序列化为二进制数据，并将其持久化到 Cloudflare 的存储中。在 Durable Object 首次启动时，它会安全地从存储中加载数据，即使在加载过程中遇到损坏的数据，也能优雅地降级，以一个全新的空文档状态启动，保证了系统的高可用性。

## 🔧 如何运行

1.  **安装依赖**: `npm install`
2.  **本地开发**: `npx wrangler dev`
3.  **部署到 Cloudflare**: `npx wrangler deploy`

部署后，通过访问 `https://<你的Worker地址>/<任意文档名>` 即可开始使用。

作者：[@yuanguangshan](https://github.com/yuanguangshan)
