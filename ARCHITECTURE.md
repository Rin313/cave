# 技术架构决策记录

> 本文档记录与 DESIGN.md 平行的技术选型与工程决策，随讨论持续更新。未决项写入 §4。

## 1. 已确定的技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | **Electron** | 非 Tauri |
| 前端框架 | **Vue 3** + Vite | 渲染进程 |
| 主进程语言 | **TypeScript** | Electron 主进程 |
| LLM 编排 | **pi coding-agent SDK**（进程内） | `@earendil-works/pi-coding-agent`，非 RPC mode，进程内集成；已发布 npm 包，直接依赖 registry 版本；SDK 文档随包分发在 `node_modules/@earendil-works/pi-coding-agent/docs/`（SDK API 见 `sdk.md`） |
| 持久化 | **SQLite** | 存档 + 回合审计，存什么见 §3 |
| Node 运行时 | **Node 26** | 开发环境工具链；主进程实际运行在 Electron 内嵌 Node 上（Electron 43 内嵌 Node 24.18 ≥ pi SDK 的 `engines.node >= 22.19`；系统 Node 与内嵌 Node 相互独立，不冲突） |

## 2. 核心架构主张

1. **模拟层 + pi SDK 必须同进程、共享状态。** 表达层要把状态快照注入 prompt，映射层要返回实体 ID；模拟层在主进程 TS 里，状态天然同内存，无序列化、无双份表示、无对齐问题。
2. **pi SDK 是映射层与表达层的宿主。** DESIGN.md 的三层架构落到 pi SDK 概念：

   | DESIGN.md 层 | pi SDK 落点 |
   |---|---|
   | 映射层 §4.2 | 一个自定义 tool：`defineTool({ name: "act", ... })`（ops 列表：apply/move/set），且为 session 里唯一启用的 tool；映射 pass 只产结构化结果 |
   | 表达层 §4.3 | session 的普通文本输出（`text_delta` 流式），在状态变更后的独立 prompt（双 pass），输入 = 当前状态 + changes |
   | 模拟层 §4.1 | tool 的 `execute()` 内部，确定性法则网络，唯一的游戏状态出口 |
   | 会话/上下文 §9 | AgentSession 自带：messages + compact() + SessionManager；叙述不回流（幻觉不固化） |
   | 拒绝 §4.2 | 结构化拒绝：法则给出世界性理由，映射 pass 不产散文 |

3. **"只有两个出口"是这个 SDK 的默认结构。** session 只给一个 tool，模型要么 `act`（提案 ops），要么写文字；`execute()` 内部就是法则裁决边界。
4. **IPC 形态：主进程 → 渲染层是推送（事件流），渲染层 → 主进程是请求（invoke）。** pi SDK 是事件流式的（`text_delta` / `tool_execution_*`），经转发器 `webContents.send()` 推给 Vue。
5. **tool schema 是操作提案**——`act(ops)`，ops 为 apply/move/set 的列表；非法/不可见实体 ID 在 `execute()` 校验层打回，不进入状态机。
6. **无别名表、无关键词匹配、无语言限制**：操作与实体都由 LLM 从自由文本中纯语义解析（`name + attrs + 上下文`），失败走拒绝路径；操作类型（apply/move/set）是 LLM 的输出空间，实体 id 只能取自可见实体索引，不限制玩家输入语言。

## 2.5 已落地的 GameDef 表面契约

- **`denyAll`**：声明在 GameDef 上的独立终端法则，不属于 opLaws；任何法则都未表态且无具体理由时兜底（状态不变）。
- **`internalProps`**：内部属性（如 `burnTicks`、`actor` 标记）不进 LLM 序列化 / changes / 表达校验，从源头杜绝泄漏。
- **`summarize`**：确定性回退摘要钩子（游戏腔调、可读），缺省用引擎的通用 JSON 序列化。
- **`deniedBy: "law" | "denyAll"`**：否决来源语义标记；`sim probe` 依此报告法则缺口，不依赖理由字符串匹配。
- **`--game` / 游戏注册表**：`src/games/registry.ts` 按 id 解析 GameDef，`loop`/`sim` 工具均已参数化，不再硬编码 cave。
- **游戏挂载点**：`hint`（世界法则提示注入映射系统提示）、`validateText`（表达层语义断言钩子）、`settableProps`（set 白名单）。

## 3. 持久化边界

模拟层状态是 JSON 可序列化的，SQLite 不存热状态，存存档与审计：

| 表 | 内容 |
|---|---|
| `games` | 游戏实例：id、状态机类型、创建时间、状态快照(JSON)、存档 |
| `messages` | 回合历史：用户操作、映射结果、表达层输出（回放/审计） |
| `sessions` | pi SDK 会话索引（SDK 自己写 JSONL，这里只存元数据 + 映射关系） |

## 4. 待确认的开放问题

1. **SQLite 驱动**：优先 `node:sqlite`（Node 22.5+ 内置、零原生编译、零 rebuild），需实测 API 是否够用（同步 API、参数化、事务）。不够再退 `better-sqlite3`（原生模块，需 electron-rebuild 对齐 ABI）。
2. **Electron + ESM 的坑**：pi SDK 是 ESM（`"type": "module"`），Electron 主进程 ESM 支持已成熟，但 preload 脚本必须是 CJS 或需特殊处理。待脚手架验证。
3. **模拟层细节（部分已定）**：原子操作集（apply/move/set 是否够，社会性原子如 communicate/alter_relation 是否补）待定；法则网络数据结构（law → 裁决的声明格式）待定；法则完整性检查工具已实现（`sim probe --game`，按 `deniedBy === "denyAll"` 报告缺口，值域从世界推导）。
4. **解析与忠实性（部分已定）**：自由文本意图的解析质量（含无选中情形，§2-6）、实体索引进 prompt 的注入方式——待原型实测；双 pass 分离与表达层后置校验器已实现（DESIGN.md §4.3：叙述实体 ⊆ 可见实体；通用禁止词表从世界派生 + `validateText` 游戏钩子 + `internalProps` 隔离）。
5. **跨回合指代**（DESIGN.md §11）：活动实体索引 / 权重偏好，待原型验证。
