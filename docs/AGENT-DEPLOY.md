# dsh-agent-relay — Agent 自主部署任务书

> **这份文档是给执行部署的 Agent（DSH / Codex / Claude / Qoder 等）读的 prompt，不是给人看的教程。**
> 人类读者请直接看 [DEPLOY.md](DEPLOY.md)；这里只额外提供三样东西：决策点、完成标准（DoD）、汇报格式。
> 你要亲自完成 broker 初始化、启动、成员接入与验证，并把结果整理成第 4 节的报告。不要让用户替你敲命令。

---

## 0. 角色与边界

把多 Agent 协作中继部署到本机，让各成员经 broker 安全互发消息。

- 你负责：初始化配置与密钥、启动 broker、接入成员、开启按需唤醒、验证闭环。
- 只动与 relay 相关的文件与配置；不碰各 Agent 的其他配置、会话历史、技能文件。
- 拓扑只有一种：broker 与全部成员同机、走回环。不要试图改 `host: 0.0.0.0` 或把它搬到公网。
- 完成标准见第 3 节，全部满足才算完成；任何一项做不到就在汇报里明写，不要绕过或降级完成。

## 1. 决策点（能从环境推断就用默认，不能推断才问用户，一次问完）

| 决策 | 默认 | 说明 |
|---|---|---|
| 接入哪些成员 | 只接已检测到的 | 检测不到的不接，别替用户发明名字 |
| 端口 | `127.0.0.1:19121` | 被占用就改 `broker.port`，并同步各成员 endpoint |
| 是否开启按需唤醒 | 逐成员确认 | 只有 `wake_command` 列出的成员能在无人轮询时收信 |
| 凭据落点 | 复用部署已有的 dotenv / DPAPI 保管库 | 不要为便利新写一份明文密钥 |

## 2. 流程（一步一验，命令与解释都在 DEPLOY.md）

1. **就位检查**：`broker/src/index.js`、`setup/setup.js`、`lib/index.js`、`adapters/cli/relay.mjs` 存在；缺文件说明包不完整，换 `git clone https://github.com/Noelune/dsh-agent-relay.git` 重来。Node 必须 ≥ 22.13。
2. **初始化与启动**：DEPLOY.md 第 2 节（`setup.js init` → `setup.js start` → `setup/doctor.mjs`）。已有 `config.yaml` 就复用其中的密钥，保持幂等。
3. **接成员**：DEPLOY.md 第 3 节（`add-member.mjs` 一次写全三处；改完重启 broker；用 `sync-secrets.mjs` 校漂移）。成员的接入面按宿主能力选 MCP / CLI / Python，三者都不需要常驻轮询进程。
4. **让离线成员可投递**：DEPLOY.md 第 4 节（`enable-wake.mjs --agent <name>` 先干跑，确认后加 `--apply`）。
5. **验证闭环**：DEPLOY.md 第 5 节。至少做一次 `v2 send` → `v2 pull` → `v2 ack completed` → `v2 status`，并确认 send 响应里的 `target_online` / `will_wake` 与实际一致。
6. **收尾**：再跑一次 `node setup/doctor.mjs`，把它的每一行原样纳入第 4 节的汇报。

## 3. Definition of Done

- [ ] `config.yaml` 存在、含 ≥32 位随机 secret，且未被纳入版本控制；日志与汇报里不出现密钥明文。
- [ ] broker 在 `127.0.0.1:19121`（或用户指定的端口）监听，`doctor` 无 fail 项。
- [ ] 每个已接入成员都能被 `doctor` 看到；在线判据是「90 秒内取过件」，不是「注册过」。
- [ ] 一条消息端到端投递成功：`send` 返回 `created: true` → 接收方 `pull` 拿到 → `ack completed` → `status` 显示 `completed`。
- [ ] 重试与租约语义验证过：`ack retry` 会 attempts+1 并重新入队，达到 `maxAttempts` 变 `failed`；带 `lease_token` 的 ack 才生效。
- [ ] 对「无人轮询的成员」：要么开了 `wake_command`（`will_wake: true` 可证），要么在汇报里明确写出它当前收不到信。
- [ ] 未确认请求默认留存 7 天（`ttl_seconds` 可 60 秒～30 天），终态消息 30 天后清除；消息正文只存在于 broker 投递队列，不落应用日志。

## 4. 汇报格式

```
## 部署完成报告

**broker**：127.0.0.1:<port>（config 路径）· 协议 v<N> · 存储 sqlite
**密钥**：已生成 / 复用（<N> hex，不回显）· 落点：dotenv / DPAPI 保管库条目 <label>

| 成员 | 接入面 | 在线 | 可被唤醒 | 验证 |
|---|---|---|---|---|
| dsh | 插件 | ✅/❌ | ✅/❌ | send→pull→ack completed |

**doctor**：逐项列出（ok/warn/fail 与原因）
**备注**：未满足的 DoD 项、需要用户决定的事项、下一步（例如重启各 Agent 会话让插件生效）
```

## 5. 防坑清单

1. **密钥即凭据**：不进版本库、不进日志、不进汇报；分发用带外方式。给成员配凭据时优先指向已有 dotenv 或保管库条目，别造第二份明文副本。
2. **别把 broker 搬上公网**：回环是设计前提。`host: 0.0.0.0` 在这里不是「更开放」，是「没有 TLS 的假安全」。
3. **名字要稳定**：成员身份就是它的名字（小写），每次换名等于换一个人，历史与幂等键都会错位。
4. **端口占用**：改 `broker.port` 后必须同步所有成员的 endpoint，否则表现为「连得上但 401/超时」。
5. **Windows**：路径用 `C:/` 或 `C:\` 形式；含中文的路径要整体加引号；不要在 heredoc 里拼多行配置。
6. **验证要真做**：`doctor` 绿灯不等于投递闭环——至少跑一次真实 send→pull→ack，尤其是刚配 `wake_command` 的成员。
7. **不碰无关配置**：各 Agent 的其他设置、会话历史、技能文件不在本任务范围内。

## 6. 与 unified-agent-memory 的关系

dsh-agent-relay 只负责**消息中继**，不存记忆。共享事实请用
[unified-agent-memory](https://github.com/Noelune/unified-agent-memory)（Obsidian vault
为最高事实源）。两者可同时部署：relay 让成员互发消息，unified-agent-memory 让它们共享事实。
