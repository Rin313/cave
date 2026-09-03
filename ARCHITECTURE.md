# 技术架构决策记录

## 1. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | **Electron** | |
| LLM 编排 | **pi coding-agent SDK** | 进程内集成，SDK 文档随包分发在 `node_modules/@earendil-works/pi-coding-agent/docs/` |
| 持久化 | **SQLite** | 存档 + 回合审计 |

## 2. 核心架构主张

1. | DESIGN.md 层 | pi SDK 落点 |
   |---|---|
   | 映射层 | 一个自定义 tool：`defineTool({ name: "act", ... })`（actions 列表：`{ verb, params }`，schema 从游戏动词表生成）；pi 在 execute 前按工具 schema 校验（错误回模型、可重试、门闩未耗）——静态形态的活跃门；one-shot 门闩内一次性提交，只产结构化结果 |
   | 表达层 | Engine 转译 pi 流为叙述通道：`narration_delta` 实时正文（相位门控：仅裁决后的生成，thinking 与映射期文本不入通道）、`narration_reset`（重试丢弃在途生成时清零）；回合定稿权威全文（累积散文，空散文/未裁决回落确定性摘要）由 `act()`/`narrate()` 返回值承载，不入事件流；按生成代记账，与 pi 的「移除失败消息再重生成」镜像；与映射同一回合运行，输入 = 回合 prompt 的状态 + act 工具结果的世界腔策展|
   | 模拟层 | tool 的 `execute()` 内部，确定性卫语句链（按动词分组），唯一的游戏状态出口 |
   | 会话/上下文 | AgentSession 自带：messages + compact() + SessionManager |
2. **IPC 形态：主进程 → 渲染层是推送（事件流），渲染层 → 主进程是请求（invoke）。** pi SDK 是事件流式的；Engine 将其转译为流式叙述事件（`narration_delta` / `narration_reset`）后经转发器 `webContents.send()` 推给前端——原始 pi 流（含映射期文本与 thinking）不出 Engine。
3. **tool schema 是动作提案**——`act(actions)`，actions 为 `{ verb, params }` 列表；verb 必须取自 `GameDef.verbs`，非法/不可见实体 ID 在 `execute()` 校验层打回，不进入状态机。**无别名表、无关键词匹配、无语言限制**：动词与实体都由 LLM 从自由文本中纯语义解析（`name + attrs + 上下文`），不限制玩家输入语言；动词空间是游戏声明的。
4. **上下文裁剪（`context` 事件 + 近况记录）**：每次 LLM 调用前经内联扩展（`DefaultResourceLoader.extensionFactories` 的 `cave-context`，`core/context.ts` 为策略单一来源）把消息裁剪为「近况记录 + 当前运行后缀」——后缀 = 最后一条 user 消息起的原样保留（toolCall/toolResult 配对天然完整），近况 = 最近 N 回合的「意图 → 世界腔裁决行」，并入该 user 消息头部。会话文件仍累积全量消息作审计；近况另以 custom 条目持久化于同一文件（custom 不参与 LLM 上下文），进程重启由其重建窗口。**缓存代价是显式决策**：状态每回合重注入使消息前缀跨回合天然不稳定，跨回合前缀复用只剩 [tools+system] 头块——因此系统提示与工具数组必须字节级稳定，且不做 setActiveTools 相位切换（工具块位于序列化前缀头部，每次切换即整体前缀失效）。回合内（act 裁决后的描写续行）前缀 [tools+system+user] 逐字节稳定（近况头并入的 user 消息在回合内不变），provider 缓存可全程复用。compaction 保持关闭：pi 缺省摘要是编码任务形状、且把旧叙述摘要重新注入，与「模拟层唯一真相源」相悖；长度兜底走显式新开会话。
5. **单 pass 编排** 每回合一次 `session.prompt()`：模型先调 `act`（一次性提交，one-shot 门闩封闭变异窗口），工具结果即本回合世界回应的世界腔策展（尝试行/时间流逝/法则事实，经 fmtChange 线性化；新见以状态视图同形的实体卡承载视图增量），模型基于它输出散文；叙述只能跟随工具结果。
6. **core 只提供通用工具，不耦合游戏**：games 代码允许任意写法与重复样板——这是创作者的自由，即便多个游戏收敛出相同形态，也不得「提升为 core 工具」。共享的游戏侧语义只走 games/ 内自愿接入的构件。
7. 大部分审计都没有任何意义，编译成功、sim验证通过什么都说明不了，e2e映射准确、表达准确也并不说明设计准确。全部是伪信号，要验证效果，必须靠阅读e2e会话和分析源码，引擎只承担机械检查和暴露UI层预期使用的字段。

## 3. 持久化边界

模拟层状态是 JSON 可序列化的，SQLite 不存热状态，存存档与审计（**目标**；原型期由 `loop` 的 `runs/` 目录以 JSONL + `state.json` 落盘，SQLite 落地后迁移）：

| 表 | 内容 |
|---|---|
| `games` | 游戏实例：id、状态机类型、创建时间、状态快照(JSON)、存档 |
| `messages` | 回合历史：用户操作、映射结果、表达层输出（回放/审计） |
| `sessions` | pi SDK 会话索引（SDK 自己写 JSONL，这里只存元数据 + 映射关系） |

**重放边界**：决策是代码、代码不序列化——transcript 可重放事件流（裁决结果），不可重放裁决过程；存档兼容须钉住整个 def（规则代码的版本耦合），这是「规则即代码」的定义性代价。
