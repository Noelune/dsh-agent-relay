import io
p='README.md'
s=io.open(p,encoding='utf-8',newline='').read()
orig=s

def rep(old,new,count=1):
    global s
    assert old in s, 'MISSING: '+old[:60]
    s=s.replace(old,new,count)

rep(u'''- **HMAC-SHA256 严密鉴权体系 (Cryptographic Verification)**  
  所有 HTTP 接口调用均经由 HMAC-SHA256 签名校验，内置 300 秒时间戳重放防护、连续 5 次鉴权失败引发的 5 分钟安全锁定机制及单 IP 速率限制。''',
u'''- **HMAC-SHA256 鉴权体系 (Cryptographic Verification)**  
  所有接口调用均经由 HMAC-SHA256 签名校验，内置 300 秒时间戳重放防护与常量时间比较；投递层再以「每次认领一枚租约令牌」约束确认与续租。速率限制与鉴权失败锁定属于已删除的 v1 世代，现在没有这两道闸，所以边界由「只绑回环」承担。''')

rep(u'''Relay 只服务 v2/v3 两代签名（v2 无 keyId 头、v3 带 keyId 头，共用同一组
`docs/PROTOCOL-V2.md` 定义的 v2/v3 线协议。v2 使用 lease/ack 投递，v3 在
`/v1/*` 路由）；v1 线协议已删除，携带旧头的请求会被明确拒绝并给出指引。''',
u'''全部路由都在 `/v1/*` 之下，说同一套 v2/v3 线协议（规范见
[docs/PROTOCOL-V2.md](docs/PROTOCOL-V2.md)）：签名有两种形态——不带 keyId 头走 v2
串，带 `X-Agent-Relay-Key-Id` 走 v3 串——但共用同一个密钥环与同一套租约/ack 投递。
v1 世代（`X-Relay-*` 头、`/register`、`/peers`、游标轮询）已整代删除，不带 v2/v3 头的
请求会收到 400 并附协议指引。''')

rep(u'args = ["C:/Users/<you>/review_repos/dsh-agent-relay/mcp/relay-mcp.mjs"]',
    u'args = ["<repo>/mcp/relay-mcp.mjs"]   # 本仓库的绝对路径')

rep(u'''1. **自动配置生成**：生成安全 HMAC 密钥并写入 `~/.dsh/relay.json`。''',
u'''1. **自动配置生成**：生成随机 HMAC 密钥并写入 broker 的 `config.yaml`；成员的运行时配置是 `~/.dsh/agent-relay.json`（只记 vault 条目名，不记明文密钥）。''')

rep(u'''3. **多 Agent 凭据装配**：自动为 `dsh`、`Codex` (AGENTS.md)、`Claude Code` (CLAUDE.md) 与 Python 客户端配置环境变量 `DSH_RELAY_AGENT` 与 `DSH_RELAY_SECRET`。''',
u'''3. **多 Agent 凭据装配**：为 `dsh`、`Codex`、`Claude Code` 与 Python 客户端各自落地身份与凭据来源（环境变量 `AGENT_RELAY_*`／`DSH_RELAY_*`、指向已有 dotenv、或 DPAPI 保管库条目），不新造明文密钥副本。成员身份由取件行为体现，**没有注册这一步**。''')

rep(u'''# 注册 Agent 并测试消息收发''', u'''# 收发验证（无需注册：身份就是签名里的 agent 名）''')

rep(u'''```text
canonical = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
v2: HMAC-SHA256(secret, agent + "
" + ts + "
" + METHOD + "
" + path + "
" + sha256hex(body))
v3: 同上，但第二段插入 keyId
```

跨语言字节级一致性由''', u'''签名串（canonical JSON + HMAC-SHA256，v3 在第二段插入 keyId）的字节级定义只在
[docs/PROTOCOL-V2.md](docs/PROTOCOL-V2.md) 维护，此处不再复制一份等着漂移。
跨语言字节级一致性由''')

rep(u'''| `lib/` | dsh 插件核心：v2/v3 客户端 (`client-v2.js`)、DSH 的五个 `agent_relay_*` 工具、workspace 租约/隔离、插件纯逻辑核心 |''',
u'''| `lib/` | 可发布的客户端层：v2/v3 客户端 (`client-v2.js`)、协议单一来源 (`protocol.js`)、配置分层 (`relay-config.mjs`)、凭据解析 (`credentials.mjs`)、DSH 的五个 `agent_relay_*` 工具、workspace 租约/隔离 |
| `mcp/` | MCP stdio 入口 `relay-mcp.mjs`：5 个工具，宿主按会话拉起，不需要常驻轮询进程 |''')

rep(u'''| `setup/` | 环境初始化脚本 `setup.js` (init/start/selfcheck) 与 Docker Compose 演示环境 |
| `docs/` | PROTOCOL (规范说明), ARCHITECTURE (架构说明), DEPLOY (部署指南), SECURITY (安全文档) |''',
u'''| `adapters/relay-agent.mjs` | 短生命周期工作进程：认领→交给 `--backend-cmd`→ack→队列空即退出（`wake_command` 的默认目标） |
| `setup/` | `setup.js` (init/start/selfcheck)、`add-member.mjs`、`sync-secrets.mjs`、`doctor.mjs`（一条命令体检）、`enable-wake.mjs`（按需唤醒开关，默认预演）、`migrate-v2.mjs`、`capture-adapter.mjs`、Docker Compose 演示 |
| `docs/` | PROTOCOL-V2（线协议规范，唯一权威）、ARCHITECTURE（系统结构与取舍）、DEPLOY（部署）、SECURITY（威胁模型）、AGENT-DEPLOY（给 Agent 的部署任务书） |''')

assert s != orig
io.open(p,'w',encoding='utf-8',newline='').write(s)
print('README.md patched ok')
