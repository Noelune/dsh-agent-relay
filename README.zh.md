# dsh-agent-relay

> 多 Agent 协作中继（DeepSeek Harness 插件）：让本机各 Agent（dsh / Codex / Claude / Hermes / OpenClaw…）经一个轻量、HMAC 认证的 broker 互相收发消息。默认单机回环、零第三方依赖、5 分钟跑通闭环。

[![npm version](https://img.shields.io/npm/v/dsh-agent-relay)](https://www.npmjs.com/package/dsh-agent-relay)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 为什么需要它

Agent 框架给每个 Agent 一张"嘴"，却没有"对讲机"。dsh、Codex、Claude、Hermes 共处一台机器时，彼此之间没有互发消息的通道——除非你自己搭。**dsh-agent-relay 就是这条通道**：一个完整可部署的 starter-kit（broker + dsh 插件 + CLI 客户端 + Python 客户端 + setup 脚本），任何人都能在几分钟内部署。

- **不是编排引擎**：不管 workflow/DAG/调度，只负责"把消息送到"。
- **不是记忆系统**：不落库消息内容（除未读排队外）。共享记忆请用 [unified-agent-memory](https://github.com/Noelune/unified-agent-memory)。
- **不是聊天服务器**：没有房间概念，只有在线/离线心跳。

## 特性

- **协议先行**：一份版本化 wire protocol（[docs/PROTOCOL.md](docs/PROTOCOL.md)），所有适配器（JS 插件 / JS CLI / Python 客户端）按同一协议实现，天然互通。
- **默认单机、零配置**：broker 默认监听 127.0.0.1:19121，无需服务器 / TLS / 云。
- **HMAC-SHA256 认证**：时间戳防重放、连续失败 5 次锁定 5 分钟、按 IP 限流。
- **可靠投递**：增量轮询游标、7 天 TTL、JSONL 落盘重启不丢、2/4/8s 退避重试、消息 id 幂等（发送端重试 + 接收端去重）。
- **dsh 一等公民**：cordis 插件注册 relay_send / relay_recv / relay_peers / relay_history 模型工具，另附可选侧边栏状态面板。
- **隐私设计**：broker 与插件只记 id 与事件，不记消息内容。
- **分布式（可选进阶）**：一台 broker、多台机器，文档强制要求 TLS。

## 快速开始（5 步，单机）

    # 1. 克隆
    git clone https://github.com/Noelune/dsh-agent-relay.git && cd dsh-agent-relay
    # 2. 生成配置与随机密钥
    node setup/setup.js init
    # 3. 启动 broker
    node setup/setup.js start
    # 4. 另开终端，接入两个 agent
    export DSH_RELAY_SECRET=<broker/config.yaml 里的 secret>
    node adapters/cli/relay.mjs register --agent alpha --secret $DSH_RELAY_SECRET
    node adapters/cli/relay.mjs register --agent beta  --secret $DSH_RELAY_SECRET
    # 5. 互发消息
    node adapters/cli/relay.mjs send beta "hello from alpha" --agent alpha --secret $DSH_RELAY_SECRET
    node adapters/cli/relay.mjs recv --agent beta --secret $DSH_RELAY_SECRET

装 dsh 插件（替代 CLI 接入）：

    dsh plugin --profile web add dsh-agent-relay
    export DSH_RELAY_AGENT=dsh-agent DSH_RELAY_SECRET=<secret>
    # 重启 web profile 后，模型即获得 relay_send / relay_recv / relay_peers 工具

完整部署：docs/DEPLOY.md · 协议：docs/PROTOCOL.md · 架构：docs/ARCHITECTURE.md · 安全：docs/SECURITY.md

## 用 DSH 部署（Agent 驱动）

想省事？装好插件后，让 DSH 完整阅读 [docs/AGENT-DEPLOY.md](docs/AGENT-DEPLOY.md) 并端到端执行：它生成 broker 密钥、启动 broker、接入 dsh 插件（及 CLI / Python 客户端）、跑 `selfcheck` 并汇报结果。

npm 包已自带 broker + setup + adapters，**单机部署无需 git clone**。若 broker 已在运行，插件只需配 `DSH_RELAY_SECRET`（和一个稳定的 `DSH_RELAY_AGENT`）。

## 仓库结构

| 路径 | 内容 |
|---|---|
| broker/ | 中继服务（零依赖 Node；config / HMAC 认证 / JSONL 存储 / HTTP 服务）+ Dockerfile |
| lib/ | dsh 插件：模型工具 + relay 客户端库（CLI 复用） |
| adapters/cli/ | 零依赖 Node CLI 客户端 |
| adapters/hermes/ | 纯标准库 Python 客户端 + Hermes 风格接入示例 |
| adapters/openclaw/ | OpenClaw 接入说明 |
| setup/ | setup.js（init/start/selfcheck）、selfcheck.js、可选 docker-compose 演示 |
| docs/ | PROTOCOL（规范）/ ARCHITECTURE / DEPLOY / SECURITY |

## 环境要求

- Node.js ≥ 20（broker / CLI / dsh 插件）
- Python ≥ 3.10（仅 Python 客户端需要，可选）
- dsh 0.1.0-rc.6（已测试；dsh 插件需要）

## 维护状态

- 维护者：[Noelune](https://github.com/Noelune)
- **社区维护**：接受 issue/PR，不承诺 SLA；缺陷修复通常 1–2 周内响应，安全漏洞优先。
- 兼容性：针对 **dsh 0.1.0-rc.6** 测试；dsh 本体为 rc 版，API 变动在 CHANGELOG.md 记录升级说明。
- 许可：**MIT**，允许商用。

## 安全

详见 docs/SECURITY.md。要点：HMAC 防伪造、TLS 防窃听；默认用回环模式；**绝不要把明文 broker 暴露到网络**。所有收到的 relay 消息一律视为不可信数据，而非指令。

## 贡献

欢迎 PR。提交前请运行 npm test；CI 每次 push 自动跑单测、gitleaks 密钥扫描与许可证检查。
