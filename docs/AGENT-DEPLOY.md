# dsh-agent-relay — DSH 自主部署任务书

> **本文档是给 DSH（DeepSeek Harness）的部署 prompt，不是给人看的教程。**
> 首次安装 `dsh-agent-relay` 插件后，DSH 必须完整阅读本文档，并**亲自完成部署操作**。
> 部署采用 Agent 驱动方式：由你（DSH）完成 broker 初始化、启动、Agent 接入与验证。不要依赖"复制粘贴"的手动流程，也不要让用户自己敲命令。

---

## 0. 你的角色与任务

你是**部署执行者**。任务：把多 Agent 协作中继（dsh-agent-relay）部署到本机，让各 Agent（dsh / Codex / Claude / Hermes / 其他）能经 broker 安全互发消息。

- 你负责：初始化配置与密钥、启动 broker、接入各 Agent、验证闭环。
- 只动与 relay 相关的文件与配置；不改动各 Agent 的其他配置、会话历史、技能文件。
- 完成标准见第 3 节验证清单，全部满足才算完成。

---

## 1. 前置信息（先解析，禁止猜测）

### 1.1 两种部署模式

| 模式 | 适用 | 说明 |
|---|---|---|
| **单机（默认）** | 本机多 Agent | broker 与 Agent 同机，全回环 `127.0.0.1:19121`，零网络暴露 |
| **分布式（进阶）** | 多台机器 | 一台服务器 + 各机器 Agent；**必须 TLS**，secret 分发要谨慎 |

### 1.2 部署决策（能从环境推断就用默认，不能推断才向用户确认，一次问完）

1. **模式**：默认单机回环；用户要跨机器才选分布式。
2. **broker host/port**：默认 `127.0.0.1:19121`；改端口只需改 `broker/config.yaml`。
3. **接入哪些 Agent**：默认接入已检测到的（dsh 插件 / CLI 客户端 / Python 客户端），检测不到的不接。

### 1.3 可用组件（npm 包已自带全部，无需 git clone）

| 组件 | 位置 | 用途 |
|---|---|---|
| broker | `<包目录>/broker/` | 零依赖 Node 中继服务（HMAC 认证 / JSONL 存储 / HTTP 服务） |
| setup | `<包目录>/setup/` | `setup.js`：`init`（生成密钥+配置）/ `start`（启动）/ `selfcheck`（验证） |
| dsh 插件 | `<包目录>/lib/` | `relay_send` / `relay_recv` / `relay_peers` / `relay_history` 模型工具 |
| CLI 客户端 | `<包目录>/adapters/cli/relay.mjs` | 脚本 / Codex / Claude 包装用 |
| Python 客户端 | `<包目录>/adapters/hermes/relay_client.py` | 纯标准库，Hermes 风格接入 |

> **路径注意**：`<包目录>` = 你（DSH）能找到本插件包的位置。若是 npm 安装，通常在
> `<profile>/node_modules/dsh-agent-relay/`；若是 git clone，就是仓库根目录。用实际解析结果，不要假设。

---

## 2. 部署流程（按顺序执行，一步一验）

### Step 0 读任务书、定模式
- 完整读完本文档。
- 确认模式（1.2）：单机回环（默认）还是分布式。
- 记录 `<包目录>` 与决定。

### Step 1 确认组件就位
- 检查 `<包目录>/broker/src/index.js`、`<包目录>/setup/setup.js`、`<包目录>/lib/index.js` 存在。
- 缺失 → 说明包不完整，改用 `git clone https://github.com/Noelune/dsh-agent-relay.git` 后重试。

### Step 2 生成配置与密钥
- 运行 `node <包目录>/setup/setup.js init`。
- 生成 `broker/config.yaml`，内含一个随机 64-hex 密钥。**绝不提交、不外泄、不写入任何日志**。
- 若已存在 config.yaml：保留，直接复用其中的 secret（幂等）。

### Step 3 启动 broker
- 前台启动：`node <包目录>/setup/setup.js start`（会按 config.yaml 绑定）。
- 或后台/容器：见 `docs/DEPLOY.md` 的 Docker 小节。
- 启动后验证：`node <包目录>/setup/setup.js selfcheck` → `all checks passed`。
- **单机模式**：确认 broker 绑定 `127.0.0.1`（config.yaml `host: 127.0.0.1`），不要改成 `0.0.0.0` 除非后面有 TLS。

### Step 4 接入 Agent
- **dsh（插件）**：
  - `dsh plugin --profile web add dsh-agent-relay`
  - 配置共享密钥：`DSH_RELAY_SECRET=<config.yaml 里的 secret>`（环境变量或插件设置），以及稳定的 `DSH_RELAY_AGENT=<名字>`。
- **CLI 客户端**（脚本 / Codex / Claude 包装）：
  - `node adapters/cli/relay.mjs register --agent alpha --secret <secret>`
  - 用 `peers` 确认上线。
- **Python 客户端**（Hermes 风格）：
  - `from relay_client import RelayClient; client = RelayClient(broker_url="http://127.0.0.1:19121", agent="beta", secret="<secret>"); client.register()`
- 每个接入的 Agent 名字要**稳定唯一**；重启后重新 `register`（心跳续期）。

### Step 5 验证闭环
- `node <包目录>/setup/setup.js selfcheck` → `all checks passed`。
- 端到端：两个 Agent 互发一条消息，接收方 `recv` 能取到（`node adapters/cli/relay.mjs send <b> "hello" --agent <a> --secret <s>`，再 `recv`）。
- 若接了 dsh 插件：确认 `relay_peers` 工具能看到已注册 Agent。

### Step 6 汇报
按第 4 节格式输出部署报告。

---

## 3. 验证清单（Definition of Done，全部满足才算完成）

- [ ] `broker/config.yaml` 存在，含 ≥32 位随机 secret，且未被纳入版本控制。
- [ ] broker 启动，`selfcheck` 全部 ok（config 有效 / broker 可达 / 插件模块加载）。
- [ ] 至少两个 Agent 注册成功，`peers` 能看到它们。
- [ ] 一条消息端到端送达（发送方收到 `accepted:true`，接收方 `recv` 取到）。
- [ ] 单机模式 broker 绑定回环地址；未向公网暴露明文端口。
- [ ] 未在任何日志、配置、汇报中出现 secret 明文以外的敏感信息。
- [ ] 消息内容仅存于 broker 的 TTL 限定期限投递队列（JSONL，默认 7 天清理），绝不写入应用日志；插件只记内存 id 级历史。

---

## 4. 汇报格式（部署完成后输出）

```
## 部署完成报告

**模式**：单机回环 / 分布式
**broker**：<host>:<port>（config.yaml 路径）
**密钥**：已生成/复用（长度 <N> hex，绝不回显）

| Agent | 接入方式 | 注册名 | 验证 |
|---|---|---|---|
| dsh | 插件 | <agent> | ✅/❌ |
| CLI | adapters/cli | alpha | ✅/❌ |
| Python | adapters/hermes | beta | ✅/❌ |

**selfcheck**：全部 ok / 列出失败项
**备注**：未满足的清单项、需要用户确认的事项（如分布式服务器、端口占用）、下一步（重启各 Agent 会话使插件生效）
```

---

## 5. 防坑清单（常见问题，执行前先过一遍）

1. **密钥即凭据**：`broker/config.yaml` 含共享密钥，**绝不提交版本库、绝不进日志/汇报**。分布式部署用带外方式（密码管理器/密封信封）分发。
2. **单机默认回环**：broker 默认 `127.0.0.1`。**绝不要把明文 broker 暴露到公网**——HMAC 只防伪造不防窃听。
3. **分布式必须 TLS**：跨机器部署时，broker 保持回环绑定，用反向代理（nginx/Caddy）终结 HTTPS，再转发到 `127.0.0.1:19121`。
4. **端口占用**：19121 被占用时报错——改 `broker/config.yaml` 的 `port`，并同步各 Agent 的 `DSH_RELAY_BROKER_URL`。
5. **Agent 名字稳定唯一**：接入时用固定名字，避免每次随机。
6. **幂等反复部署**：config.yaml 已存在时保留复用；重复 `register` 无害（心跳续期）。
7. **Windows**：路径用 `C:/` 或 `C:\` 形式；Node ≥ 20；不要在 shell heredoc 里拼多行配置。
8. **不碰无关配置**：各 Agent 的其他配置、会话历史、技能文件不在本任务范围。
9. **无法满足的项**：任何一步遇到障碍（端口被占、权限不足、包不完整），停下来在汇报里说明，不要绕过或降级完成。

---

## 6. 与 unified-agent-memory 的关系

dsh-agent-relay 只负责**消息中继**，不存记忆。共享记忆请用
[unified-agent-memory](https://github.com/Noelune/unified-agent-memory)（Obsidian vault 为最高事实源）。
两者可同时部署：relay 让 Agent 互发消息，unified-agent-memory 让它们共享事实。
