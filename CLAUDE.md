# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

kiro-rs 是一个用 Rust 编写的 Anthropic Claude API 兼容代理服务，将 Anthropic API 请求转换为 Kiro API 请求。支持多凭据管理、自动故障转移、流式响应和 Web 管理界面。

**技术栈**: Rust (Axum 0.8 + Tokio) + React 18 + TypeScript + Tailwind CSS

## 常用命令

```bash
# 构建（必须先构建前端）
cd admin-ui && pnpm install && pnpm build
cargo build --release

# 开发运行
cargo run -- -c config.json --credentials credentials.json

# 测试
cargo test
cargo test <test_name>           # 运行单个测试

# 代码检查
cargo fmt          # 格式化
cargo clippy       # lint

# 启用敏感日志构建（排障用，输出 token 用量等诊断信息）
cargo run --features sensitive-logs -- -c config.json --credentials credentials.json

# 前端开发
cd admin-ui
pnpm install
pnpm dev           # 开发服务器
pnpm build         # 生产构建
```

## 请求处理流程

```
POST /v1/messages (Anthropic 格式)
  → auth_middleware: 验证 x-api-key / Bearer token（subtle 常量时间比较）
  → post_messages handler:
      1. 判断 WebSearch 触发条件，决定本地处理或剔除后转发
      2. converter::convert_request() 转换为 Kiro 请求格式
      3. provider.call_api() 发送请求（含重试和故障转移）
      4. stream.rs 解析 AWS Event Stream → 转换为 Anthropic SSE 格式返回
```

## 核心设计模式

1. **Provider Pattern** - `kiro/provider.rs`: 统一的 API 提供者接口，处理请求转发和重试。支持凭据级代理（每个凭据可配独立 HTTP/SOCKS5 代理，缓存对应 HTTP Client 避免重复创建）
2. **Multi-Token Manager** - `kiro/token_manager.rs`: 多凭据管理，按优先级故障转移，后台异步刷新 Token（支持 Social 和 IdC 两种认证方式）。余额缓存 5 分钟 TTL，过期时异步刷新不阻塞请求
3. **Protocol Converter** - `anthropic/converter.rs`: Anthropic ↔ Kiro 双向协议转换，包括模型映射（sonnet/opus/haiku → Kiro 模型 ID）、JSON Schema 规范化（修复 MCP 工具的 `required: null` / `properties: null`）、工具占位符生成、图片格式转换
4. **Event Stream Parser** - `kiro/parser/`: AWS Event Stream 二进制协议解析（header + payload + CRC32C 校验）
5. **Buffered Stream** - `anthropic/stream.rs`: 两种流模式 — `StreamContext`（直接转发）和 `BufferedStreamContext`（缓冲所有事件，等 `contextUsageEvent` 到达后修正 input_tokens 再一次性发送）

## 共享状态

```rust
AppState {
    api_key: String,                          // Anthropic API 认证密钥
    kiro_provider: Option<Arc<KiroProvider>>,  // 核心 API 提供者（Arc 线程安全共享）
    profile_arn: Option<String>,               // AWS Profile ARN
    compression_config: CompressionConfig,     // 输入压缩配置
}
```

通过 Axum `State` extractor 注入到所有 handler 中。

## 凭据故障转移与冷却

- 凭据按 `priority` 字段排序，优先使用高优先级凭据
- 请求失败时 `report_failure()` 触发故障转移到下一个可用凭据
- 冷却分类管理：`FailureLimit` / `InsufficientBalance` / `ModelUnavailable` / `QuotaExceeded`
- `MODEL_TEMPORARILY_UNAVAILABLE` 触发全局熔断，禁用所有凭据

## API 端点

**代理端点**:
- `GET /v1/models` - 获取可用模型列表
- `POST /v1/messages` - 创建消息（Anthropic 格式）
- `POST /v1/messages/count_tokens` - Token 计数
- `/cc/v1/*` - Claude Code 兼容端点（同上，路径别名）

**Admin API** (需配置 `adminApiKey`):
- 凭据 CRUD、状态监控、余额查询

## 重要注意事项

1. **构建顺序**: 必须先构建前端 `admin-ui`，再编译 Rust 后端（静态文件通过 `rust-embed` 嵌入，derive 宏为 `#[derive(Embed)]`）
2. **凭据格式**: 支持单凭据（向后兼容）和多凭据（数组格式，支持 priority 字段）
3. **重试策略**: 单凭据最多重试 2 次，单请求最多重试 5 次
4. **WebSearch 工具**: 仅当请求明确触发 WebSearch（`tool_choice` 强制 / 仅提供 `web_search` 单工具 / 消息前缀匹配）时走本地 WebSearch；否则从 `tools` 中剔除 `web_search` 后转发上游（避免误路由）
5. **安全**: 使用 `subtle` 库进行常量时间比较防止时序攻击；Admin API Key 空字符串视为未配置
6. **Prefill 处理**: Claude 4.x 已弃用 assistant prefill，末尾 assistant 消息被静默丢弃
7. **sensitive-logs 特性**: 编译时 feature flag，启用后输出 token 用量诊断日志和请求体大小（默认关闭，仅用于排障）
8. **网络错误分类**: 连接关闭/重置、发送失败等网络错误被归类为瞬态上游错误，返回 502（不记录请求体）
9. **Rust edition**: 项目使用 Rust 2024 edition
