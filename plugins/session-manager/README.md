# dsh-session-manager

DSH 可以归档会话，但**从不删除**：`sessionPersistence` 没有 `delete`、`sessionController` 没有 `delete`、`workspaceRegistry` 只有 archive/pin。这个插件把「会话管理」补齐：真删（带可恢复的回收站）、批量归档 / 解除归档、批量删除、以及删除工作区时怎么处理其中的会话。

> 旧名 `dsh-plugin-session-delete`（v1）已更名为 `dsh-session-manager`（v2）。v1 删掉的回收站条目（`.session-delete.json`）仍能被读取和恢复。

## 用起来是什么样

**删除**：侧栏会话行的 `...` 菜单最底部多一项 **删除会话**（红色文字 + 14px 垃圾桶图标，行高/内距与「置顶会话」等系统项完全一致，带分隔线，落在「复制会话 ID」之后）。
点它 → 帧级确认框（`shell.overlay`，不在菜单里，所以关菜单后仍在）→ 二选一：

- **移到回收站**：`~/.dsh/.session-trash/<时间戳>__<sessionId>/`，目录里附 `.session-manager.json`（原始路径、workspace、标题、大小、恢复命令）。
- **彻底删除**：`rm -rf` 等价，不可撤销。

删完弹一条结果提示；回收站模式下提示里带 **撤销** 按钮，直接调恢复接口。

**恢复**：设置 → **会话管理** → 回收站页（下面详述）。

## 设置页：会话管理

设置面板里多一页 **会话管理**（`settings.section`，order 600），三个标签：

- **会话**：Host 已知的全部会话（`/sessions`），带运行中/已归档徽章、所在工作区、时间。搜索框 + 四个过滤 chip（全部 / 未归档 / 已归档 / 未分组）+ 全选。勾选后可以 **归档 / 解除归档 / 移到回收站 / 彻底删除**——批量走 `/batch/archive`、`/batch/delete`，逐个执行并回报每条的成败；两个删除动作都要**再点一次确认**（按钮文案变成「再点一次彻底删除」）。
- **回收站**：所有被删会话（标题、删除时间、大小、sessionId），每条 **恢复 / 彻底删除**，底部 **清空回收站**（两步确认）。
- **设置**：两个策略单选——删除工作区时怎么处理其中的会话（交给系统 / 归档 / 删除），以及本插件删除会话时默认走回收站还是彻底删除。改一下即时写盘，页面底部显示配置文件路径。

恢复做的事：目录搬回原位 → 删掉残留 `.session-manager.json` → `Workspace.attachSession(id)` 挂回原 workspace → 客户端 `sessions.refresh()` 重拉基线。侧栏那一行立刻回来，不需要刷新页面。

## 删除工作区时的会话策略

侧栏没有工作区级菜单插槽，所以这条策略在 Host 侧实现：插件订阅 `domain/changed`，记住每个工作区的 id / path / 标题 / 会话列表；当 `workspace` 域的 `workspaces` 表出现 `deleted` 时，取出该工作区快照按配置处理其中的会话：

| `workspaceDeleteMode` | 行为 |
| --- | --- |
| `system`（默认） | 什么都不做，会话落到侧栏「未分组」，与系统原生行为一致 |
| `archive` | 全部归档（`archiveSession(id, { stopActivity: true })`），进「已归档」，随时可批量解除 |
| `delete` | 全部删除，走 `deleteMode` 指定的回收站或彻底删除 |

配置文件 `~/.dsh/session-manager.config.json`（也可在设置页改）：

```json
{ "workspaceDeleteMode": "system", "deleteMode": "trash" }
```

优先级：内置默认 < 加载器条目 `config` < 配置文件。

## 一次删除做了四件事

| 目标 | 位置 | 手段 |
| --- | --- | --- |
| 内存里的 live 会话 | SessionStore / AgentService 的 `store` | `detachEntered(entry)`，触发 `session/disposed` |
| 会话文件 | `$DSH_HOME/sessions/<cwd编码>/<sessionId>/` | 移到回收站或删除 |
| 投影缓存 | `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json` | 删除 |
| workspace 记账 | `workspace.json` 内存态 | `Workspace.detachSession(id)` + `unpinSession` + `unarchiveSession` |

只删磁盘文件不摘记账，侧栏那一行会一直挂着；只摘记账不删文件，磁盘上的数据会变成孤儿。所以两者都做。

**为什么还要摘内存**：`sessionController.list()`（`dsh-api-session-controller/lib/types/list.js:108`）返回的是「attached **和** persisted 的会话」，实现里 `const live = this.ctx.sessions.get(id); if (live !== undefined) items.push(...)`。agent 的 owner 是 agents 服务自己的 ctx（`dsh-agent/lib/index.js:467` `resume()` 里 `const ownerCtx = this.ctx`），所以刷新页面、断开连接都不会释放它——只删文件，那一行会被 `list()` 继续吐出来，侧栏就把它归进「未分组」，看起来像「会话没删掉，只是从工作区移走了」。

正确入口是 `SessionStore.detachEntered(entry)`（`dsh-session/lib/index.js:1887`）：`store.delete(id)` + 发 `session/disposed`；controller 监听它并发 `api-session/removed`，客户端 manager 收到后执行 `{kind:'remove'}`，**行立即消失，不需要刷新页面**。`AgentService.detachEntered` 同理（`:541`）。这两个方法不在服务目录里，所以全部用 `try/catch` + 特性检测包住：Host 升级后即使改名，删除流程也不会崩，只会少摘一层。

## 恢复为什么必须两步

`Workspace.attachSession(id)` 会去读会话 header，校验 `header.cwd === workspace.path`。文件不在磁盘上，它直接抛 `session persistence holds no such session`。所以顺序固定：**先 rename 回原位，再 attach**。

侧栏那一行还有第二个条件：客户端 sessions store 的 `list.byId[id]` 里必须有 summary。Host 的 `session.list()` 每次都扫盘，所以恢复后调 `ctx.sessions.refresh()`（内部 `remote.session.list({})`）就能拿到新 summary。workspace 侧不用管——`attachSession` 走 storage table.update，会触发 `domain/changed`，`useWorkspaces` 快照自动更新。

老条目没有 `workspaceId` 时，按 `.session-manager.json` 里的 `workspaceBucket` 与 `registry.list()` 的 path 做「只比字母数字」的归一化比对定位 workspace。

## 组成

- `lib/index.js` — Host 半边。`inject: ['webServer']`，注册十条同源路由（`delete` / `trash` / `restore` / `trash/purge` / `live` / `evict` / `config` / `sessions` / `batch/delete` / `batch/archive`），外加一个 `domain/changed` 监听（工作区删除策略）。
  - 守卫（全部路由共用）：仅 loopback、方法必须匹配、必须带 `x-dsh-session-manager: 1`、拒绝跨源 Origin、id 必须是纯标识符（禁止 `/` `\` `..`）。
  - 会话在跑：先 best-effort `cancel`，再 `evictLiveAgent`（`sessions.detachEntered` → `agents.detachEntered` → agent scope dispose），最后才动文件；删后复查目录是否被活句柄写回，写回则回报 `partial` + `residual`。
  - `{ "dryRun": true }` 只报告会删什么（路径、字节数、是否 busy），不动任何东西。
- `lib/client.js` — 浏览器半边。`window.__ModuleLoader__.load(...)`，`inject: ['slots', 'locale']`。
  - `sidebar.workspaces.session.menu.item`（order 500）、`settings.section`（id `session-manager`，order 600）、`shell.overlay`（order 500）。
  - 删的正好是当前打开的那个会话时，先 `uiWorkspace.openWorkspace(...)` 挪开视线再刷新，避免面板停在一个已经不存在的会话上。
  - 不 require 任何 Harness Client 包，样式全内联、只用 `--dsw-alias-*` token：host 升级不会把插槽条目搞崩。
  - 插槽没把 inject 工厂的 prop 传进来时（`t` / `refresh` 等）全部有模块级兜底，不抛错。
- `locale/*.json` — 插件管理页的标题/描述；界面文案走 `ctx.locale.register` + `bind`，跟随当前语言（en / zh）。

## 路由契约

```bash
# 删除（dryRun 只报告）
curl -s -X POST http://127.0.0.1:53199/dsh-session-manager/delete \
  -H 'content-type: application/json' -H 'x-dsh-session-manager: 1' \
  -d '{"sessionId":"session-xxxx","mode":"trash","displayTitle":"标题","dryRun":true}'

# 回收站列表
curl -s http://127.0.0.1:53199/dsh-session-manager/trash -H 'x-dsh-session-manager: 1'

# 恢复（trashId 或 sessionId 二选一）
curl -s -X POST http://127.0.0.1:53199/dsh-session-manager/restore \
  -H 'content-type: application/json' -H 'x-dsh-session-manager: 1' \
  -d '{"trashId":"2026-10-18T11-25-39-134Z__session-xxxx"}'

# 彻底清掉某条 / 清空整个回收站
curl -s -X POST http://127.0.0.1:53199/dsh-session-manager/trash/purge \
  -H 'content-type: application/json' -H 'x-dsh-session-manager: 1' \
  -d '{"trashId":"2026-10-18T11-25-39-134Z__session-xxxx"}'

# 诊断：现在内存里挂着哪些 live 会话 / agent；带 sessionId 时顺带看 session.list() 还列不列它
curl -s 'http://127.0.0.1:53199/dsh-session-manager/live?sessionId=session-xxxx' -H 'x-dsh-session-manager: 1'

# 会话总表（批量操作的输入）：title / cwd / running / archived / pinned / workspace
curl -s http://127.0.0.1:53199/dsh-session-manager/sessions -H 'x-dsh-session-manager: 1'

# 批量删除（mode 缺省取配置；最多 200 条）
curl -s -X POST http://127.0.0.1:53199/dsh-session-manager/batch/delete \
  -H 'content-type: application/json' -H 'x-dsh-session-manager: 1' \
  -d '{"sessionIds":["session-a","session-b"],"mode":"trash"}'

# 批量归档 / 解除归档
curl -s -X POST http://127.0.0.1:53199/dsh-session-manager/batch/archive \
  -H 'content-type: application/json' -H 'x-dsh-session-manager: 1' \
  -d '{"sessionIds":["session-a"],"archived":true}'

# 读 / 改配置
curl -s http://127.0.0.1:53199/dsh-session-manager/config -H 'x-dsh-session-manager: 1'
curl -s -X POST http://127.0.0.1:53199/dsh-session-manager/config \
  -H 'content-type: application/json' -H 'x-dsh-session-manager: 1' \
  -d '{"workspaceDeleteMode":"archive","deleteMode":"purge"}'

# 单独把某个会话从内存里摘掉（不动磁盘；delete 流程内部已经会做）
curl -s -X POST http://127.0.0.1:53199/dsh-session-manager/evict \
  -H 'content-type: application/json' -H 'x-dsh-session-manager: 1' \
  -d '{"sessionId":"session-xxxx"}'
```

删除返回示例：

```json
{ "ok": true, "code": "deleted", "sessionId": "session-xxxx", "mode": "trash",
  "trashId": "2026-10-18T11-37-45-611Z__session-xxxx",
  "evicted": { "attempted": true, "live": false,
               "steps": [{ "step": "sessions.detachEntered", "ok": true },
                         { "step": "agents.detachEntered", "ok": true },
                         { "step": "agent.scope.rawDispose", "ok": true }] },
  "removed": [{ "path": "...", "how": "trashed", "destination": "..." }],
  "removedCache": ["..."], "detachedWorkspaces": ["85410a3d-..."],
  "clearedBookkeeping": ["unpinSession", "unarchiveSession"], "residual": [] }
```

恢复返回示例（`attachedTo` 为 workspace id，挂不回去时是 `{ failed: "<原因>" }`）：

```json
{ "ok": true, "code": "restored", "sessionId": "session-xxxx",
  "path": "/Users/.../sessions/--Users-...--/session-xxxx",
  "attachedTo": "85410a3d-6c08-45a2-901f-75f72f1b5ae9", "unarchived": false }
```

错误码：`not-found` / `trash-miss` / `destination-exists` / `trash-corrupt` / `session-busy` / `partial` / `invalid-session-id` / `invalid-trash-id` / `missing-intent-header` / `forbidden`。

## 手工作业（不用插件也能做）

```bash
# 恢复一条：搬回原位，删掉残留 meta，然后重启 dsh（或让它重新 attach）
mv ~/.dsh/.session-trash/2026-10-18T11-25-39-134Z__session-xxxx \
   ~/.dsh/sessions/--Users-...--/session-xxxx
rm ~/.dsh/sessions/--Users-...--/session-xxxx/.session-manager.json
```

## 安装 / 更新

```
plugin_manager install_bundle  target=/绝对路径/dsh-session-manager
```

改完代码：Host 半边要重新加载（`plugin_manager set_plugin`，target 用加载器条目 id `include:session-manager`，先关再开）；浏览器半边刷新页面即可（`dsh-client-hmr` 通常会自动重载）。
