# 技术架构决策记录

## 1. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | **Electron** | |
| LLM 编排 | **pi coding-agent SDK** | 进程内集成，SDK 文档随包分发在 `node_modules/@earendil-works/pi-coding-agent/docs/` |
| 持久化 | **SQLite** | 存档 + 回合审计 |

## 2. 核心架构主张

1. DESIGN.md 的三层架构落到 pi SDK 概念：
   | DESIGN.md 层 | pi SDK 落点 |
   |---|---|
   | 映射层 | 一个自定义 tool：`defineTool({ name: "act", ... })`（actions 列表：`{ verb, params }`，schema 从游戏动词表生成）；pi 在 execute 前按工具 schema 校验（错误回模型、可重试、门闩未耗）——静态形态的活跃门；one-shot 门闩内一次性提交，只产结构化结果 |
   | 表达层 | Engine 转译 pi 流为叙述通道：`narration_delta` 实时正文（相位门控：仅裁决后的生成，thinking 与映射期文本不入通道）、`narration_reset`（重试丢弃在途生成时清零）；回合定稿权威全文（累积散文，空散文/未裁决回落确定性摘要）由 `act()`/`narrate()` 返回值承载，不入事件流；按生成代记账，与 pi 的「移除失败消息再重生成」镜像；与映射同一回合运行，输入 = 回合 prompt 的状态 + act 工具结果的世界腔策展|
   | 模拟层 | tool 的 `execute()` 内部，确定性规则网络（按动词分组），唯一的游戏状态出口 |
   | 会话/上下文 | AgentSession 自带：messages + compact() + SessionManager |
2. **IPC 形态：主进程 → 渲染层是推送（事件流），渲染层 → 主进程是请求（invoke）。** pi SDK 是事件流式的；Engine 将其转译为流式叙述事件（`narration_delta` / `narration_reset`）后经转发器 `webContents.send()` 推给前端——原始 pi 流（含映射期文本与 thinking）不出 Engine。
3. **tool schema 是动作提案**——`act(actions)`，actions 为 `{ verb, params }` 列表；verb 必须取自 `GameDef.verbs`，非法/不可见实体 ID 在 `execute()` 校验层打回，不进入状态机。**无别名表、无关键词匹配、无语言限制**：动词与实体都由 LLM 从自由文本中纯语义解析（`name + attrs + 上下文`），不限制玩家输入语言；动词空间是游戏声明的。
4. **上下文裁剪（`context` 事件 + 近况记录）**：每次 LLM 调用前经内联扩展（`DefaultResourceLoader.extensionFactories` 的 `cave-context`，`core/context.ts` 为策略单一来源）把消息裁剪为「近况记录 + 当前运行后缀」——后缀 = 最后一条 user 消息起的原样保留（toolCall/toolResult 配对天然完整），近况 = 最近 N 回合的「意图 → 世界腔裁决行」，并入该 user 消息头部。会话文件仍累积全量消息作审计；近况另以 custom 条目持久化于同一文件（custom 不参与 LLM 上下文），进程重启由其重建窗口。**缓存代价是显式决策**：状态每回合重注入使消息前缀跨回合天然不稳定，跨回合前缀复用只剩 [tools+system] 头块——因此系统提示与工具数组必须字节级稳定，且不做 setActiveTools 相位切换（工具块位于序列化前缀头部，每次切换即整体前缀失效）。回合内（act 裁决后的描写续行）前缀 [tools+system+user] 逐字节稳定（近况头并入的 user 消息在回合内不变），provider 缓存可全程复用。compaction 保持关闭：pi 缺省摘要是编码任务形状、且把旧叙述摘要重新注入，与「模拟层唯一真相源」相悖；长度兜底走显式新开会话。
5. **单 pass 编排** 每回合一次 `session.prompt()`：模型先调 `act`（一次性提交，one-shot 门闩封闭变异窗口），工具结果即本回合世界回应的世界腔策展（尝试行/时间流逝/法则事实，经 fmtChange 线性化；新见以状态视图同形的实体卡承载视图增量），模型基于它输出散文；叙述只能跟随工具结果。
6. **core 只提供通用工具，不耦合游戏**：games 代码允许任意写法与重复样板——这是创作者的自由，即便多个游戏收敛出相同形态，也不得「提升为 core 工具」。共享的游戏侧语义只走 games/ 内自愿接入的构件。随机由 games 层以 World 状态自持（纯函数派生），`World` 即完整真相源，apply/存档/恢复天然一致，无隐藏变量。core 提供的通用原语：`hashStr`（确定性哈希）、`roll`（确定性骰子，`hashStr(time#key)` 派生 [1,sides]，key 需同 tick 唯一——规则经 `Q.roll(key, sides)` 调用，apply/存档恢复天然一致）、`sumProp`（聚合助手，守恒不变式用）、`integrityInvariant`（引用完整性与注册表类型契约硬墙）。引擎隐式语义经只读上下文 `Q` 具名入口收口。
7. 大部分审计都没有任何意义，编译成功、sim验证通过什么都说明不了，e2e映射准确、表达准确也并不说明设计准确。全部是伪信号，要验证效果，必须靠阅读e2e会话和分析源码，引擎只承担机械检查和暴露UI层预期使用的字段。

## 3. GameDef 表面契约

- **`Rule`（卫语句式规则，按动词分组）**：`{ id, judge(q, p) }`——普通函数接收只读判定上下文 `Q`（world/player/time/params + `rel/relNum/roll/visible/name` 等引擎自有语义唯一入口；施动前提是规则侧语义，由 games 层构件供给），返回授予（Delta 列表 + 世界腔理由 + facts）或结构化拒绝（Denial），null = 不表态交由后续规则；拒绝/授予优先序就是书写顺序（guard clauses）。数值与后果由规则产出的 Delta 表达（`set/inc/relSet/relInc/rename/spawn/despawn`——生灭原语让authored 世界可动态生长，relSet 值 null 即删边（拓扑收缩与生长对称），rename 改写名字，despawn 级联清理核心结构、悬空 id 引用由完整性硬墙回滚）。时间系统 `GameDef.systems` 同为纯函数规则（`SystemRule.run(q)` 聚合产出 deltas/facts）。跨提交/回滚/审计边界的产出（Delta/Denial/Fact）保持数据，产出的决策回归代码。
- **两种创作形态（authorial regimes）**：**法则网络形态**——规则按属性组合键控、随新实体自动泛化（承重墙针对此形态，防组合爆炸）；**authored 形态**——梦核/脚本化世界的正当写法：互动按实体逐个书写（每条一个卫语句子句 + 兜底）、效果改写互动结果、实体生灭与动态拓扑。两形态共用同一套裁决瓶颈与提交硬墙，差异只在作者书写风格与不变式密度。
- **`grounding`**：可见实体索引钩子，决定哪些实体进状态视图；缺省全部可见（未声明认识论语义的诚实零）。感知面只有两个槽位（grounding/digestExtra）——准入门是「core 机器在协议通道内消费它」（状态视图装配/entityParams 可见性门/新见检测）。
- **`props`（属性注册表）**：`{ prop: { type, label?, internal? } }`。`internal: true` 的属性不进 LLM 序列化 / 变更线性化，从源头杜绝泄漏；`label` 是属性世界化说法（拒绝/变更文本用），**并是表达 prompt 变更馈送的默认渲染源**——回合骨架 `spineLines`（core 单一渲染机械，服务结果视图/近况/控制台/回退摘要）用实体名 + `label` 做语言无关线性化（`fmtChange`，`name.label: from → to`，core 只做符号连接、不内嵌语言词）；动作侧同一纪律：`describeAction` 以 `verb.label(param,…)` 符号连接；tick 行的语言词只来自规则事实与 `messages.timePassed`。`internalPropsOf(def)` 派生内部属性集。
- **状态视图**：可见实体（grounding）× 注册表过滤（internal 不进 prompt，隔离机械保证）× 关系端点可见过滤；游戏派生纹理入独立 extra 键（`digestExtra`，无 id 承诺的呈现面）。参照域契约由构造保证：视图实体索引 ≡ 可见性门的权威集——模型看得见的才可指名、可指名的必看得见。
- **关系边表**：`world.relations` 为 `{ from, to, type, value }` 边表，表达社会/叙事状态（信任、记忆、派系）。规则以 `relSet/relInc` 变更，核心提供 `relVal/relAll` 查询。变更记录为 sum-typed `Change`（kind: prop/rename/rel/spawn/despawn，与 Delta 同构）。变更在表达层格式化为「from 对 to 的 type」的世界腔文本，快照/克隆/序列化完整保留。
- **事件流两形态**：systems 产出为刻步 `TickStep`（`kind:"tick"`，携带时刻 `at`、变更/事实/src），动作裁决为 `ActionStep`（`kind:"action"`）——刻是世界的因（提交失败不回退时间），不是意志的果，二者不共用形状。

## 4. 持久化边界

模拟层状态是 JSON 可序列化的，SQLite 不存热状态，存存档与审计（**目标**；原型期由 `loop` 的 `runs/` 目录以 JSONL + `state.json` 落盘，SQLite 落地后迁移）：

| 表 | 内容 |
|---|---|
| `games` | 游戏实例：id、状态机类型、创建时间、状态快照(JSON)、存档 |
| `messages` | 回合历史：用户操作、映射结果、表达层输出（回放/审计） |
| `sessions` | pi SDK 会话索引（SDK 自己写 JSONL，这里只存元数据 + 映射关系） |

**重放边界**：决策是代码、代码不序列化——transcript 可重放事件流（裁决结果），不可重放裁决过程；存档兼容须钉住整个 def（规则代码的版本耦合），这是「规则即代码」的定义性代价。
