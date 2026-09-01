# 技术架构决策记录

## 1. 已确定的技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | **Electron** | |
| LLM 编排 | **pi coding-agent SDK** | `@earendil-works/pi-coding-agent`，进程内集成；SDK 文档随包分发在 `node_modules/@earendil-works/pi-coding-agent/docs/` |
| 持久化 | **SQLite** | 存档 + 回合审计 |

## 2. 核心架构主张

1. DESIGN.md 的三层架构落到 pi SDK 概念：
   | DESIGN.md 层 | pi SDK 落点 |
   |---|---|
   | 映射层 | 一个自定义 tool：`defineTool({ name: "act", ... })`（actions 列表：`{ verb, params }`，schema 从游戏动词表生成）；one-shot 门闩内一次性提交，只产结构化结果 |
   | 表达层 | Engine 转译 pi 流为叙述通道：`narration_delta` 实时正文（相位门控：仅裁决后的生成，thinking 与映射期文本不入通道）、`narration_reset`（重试丢弃在途生成时清零）、`narration`（回合定稿权威全文：累积散文，空散文/未裁决回落确定性摘要）；按生成代记账，与 pi 的「移除失败消息再重生成」镜像；与映射同一回合运行，输入 = 回合 prompt 的状态 + act 工具结果的世界腔策展|
   | 模拟层 | tool 的 `execute()` 内部，确定性规则网络（按动词分组），唯一的游戏状态出口 |
   | 会话/上下文 | AgentSession 自带：messages + compact() + SessionManager |
2. **IPC 形态：主进程 → 渲染层是推送（事件流），渲染层 → 主进程是请求（invoke）。** pi SDK 是事件流式的；Engine 将其转译为引擎事件流（`narration_delta` / `tool_result` / `elapsed` / …）后经转发器 `webContents.send()` 推给前端——原始 pi 流（含映射期文本与 thinking）不出 Engine。
3. **tool schema 是动作提案**——`act(actions)`，actions 为 `{ verb, params }` 列表；verb 必须取自 `GameDef.verbs`，非法/不可见实体 ID 在 `execute()` 校验层打回，不进入状态机。**无别名表、无关键词匹配、无语言限制**：动词与实体都由 LLM 从自由文本中纯语义解析（`name + attrs + 上下文`），不限制玩家输入语言；动词空间是游戏声明的。
4. **上下文裁剪（`context` 事件 + 近况记录）**：每次 LLM 调用前经内联扩展（`DefaultResourceLoader.extensionFactories` 的 `cave-context`，`core/context.ts` 为策略单一来源）把消息裁剪为「近况记录 + 当前运行后缀」——后缀 = 最后一条 user 消息起的原样保留（toolCall/toolResult 配对天然完整），近况 = 最近 6 回合的「意图 → 世界腔裁决行」，并入该 user 消息头部。会话文件仍累积全量消息作审计；近况另以 custom 条目持久化于同一文件（custom 不参与 LLM 上下文），进程重启由其重建窗口。**缓存代价是显式决策**：状态每回合重注入使消息前缀跨回合天然不稳定，跨回合前缀复用只剩 [tools+system] 头块——因此系统提示与工具数组必须字节级稳定，且不做 setActiveTools 相位切换（工具块位于序列化前缀头部，每次切换即整体前缀失效）。回合内（act 裁决后的描写续行）前缀 [tools+system+user] 逐字节稳定（近况头并入的 user 消息在回合内不变），provider 缓存可全程复用。compaction 保持关闭：pi 缺省摘要是编码任务形状、且把旧叙述摘要重新注入，与「模拟层唯一真相源」相悖；长度兜底走显式新开会话。
5. **单 pass 回合** 每回合一次 `session.prompt()`：模型先调 `act`（一次性提交，one-shot 门闩封闭变异窗口），工具结果即本回合世界回应的世界腔策展（尝试行/时间流逝/法则事实/新见，经 fmtChange 线性化、协议性拒绝过滤），模型基于它输出散文；叙述只能跟随工具结果。

## 3. GameDef 表面契约

- **`verbs`**：游戏声明的动词表，每个动词含 `schema`（TypeBox，生成 act 工具参数校验，并经 `defineVerb` 推导规则参数的编译期类型）、`cost`（尝试时价：无论裁决成败都消耗的刻数，协议性拒绝除外；时间律的动词面）、`entityParams`（哪些参数是实体 id，供可见性校验）、`rules`（卫语句式规则函数，按序裁决首个表态即判决；末尾可挂 fallback 兜底规则）。动词集由各游戏声明。
- **环境响应（声明式动词）**：非预设的自由动作由游戏声明动词 + 法则承担——法则网络形态按属性键控一条规则覆盖全部可达实体；authored 形态则逐实体书写互动子句。结构性属性（`in`/`material`/`lit`/`burning`/`open`/`coins`/`alive`…）仍只能由法则/系统变更；语义一致性由领域不变式（`invariants`）兜底。
- **`Rule`（卫语句式规则，按动词分组）**：`{ id, judge(q, p) }`——普通函数接收只读判定上下文 `Q`（world/player/time/params + `rel/relNum/roll/visible/name` 等引擎自有语义唯一入口；施动前提是规则侧语义，由 games 层构件供给），返回授予（Delta 列表 + 世界腔理由 + facts）或结构化拒绝（Denial），null = 不表态交由后续规则；拒绝/授予优先序就是书写顺序（guard clauses）。数值与后果由规则产出的 Delta 表达（`set/inc/relSet/relInc/spawn/despawn`——生灭原语让梦核/authored 世界可动态生长，relSet 值 null 即删边（拓扑收缩与生长对称），despawn 级联清理核心结构、悬空 id 引用由完整性硬墙回滚），LLM 不提案数值。时间系统 `GameDef.systems` 同为纯函数规则（`SystemRule.run(q)` 聚合产出 deltas/facts）。跨提交/回滚/审计边界的产出（Delta/Denial/Fact）保持数据，产出的决策回归代码。
- **`fallback` 兜底规则**：动词末尾的无条件拒绝规则，其 Denial 带 `fallback: true` 作者自声明标记；runner 对全部规则未表态的动作回落 noResponse（引擎闭合拒绝，同样携带 fallback 标记，law `action.unanswered`）。散文内联在规则文本里，`sim probe` 据标记报告法则缺口。
- **拒绝文案内联**：拒绝理由以世界腔字符串直书在规则代码里（`deny(law, { reason })`），缺省回落 `messages.noResponse`——"一个行为的文案与其条件同处一处"。core 产出的拒绝由 `Messages` 注入语言：不可见实体（`invisibleEntity`，可选，收解析后的实体名）。**不变式按产出方渲染**：core 完整性违反只有 debug 诊断（回落 noResponse）；游戏不变式的 message 是游戏撰写的世界腔，直接作玩家文案。
- **校验收敛与协议性拒绝**：动词存在/schema/实体可见性校验从 act 工具收敛进 `Simulation.adjudicateRaw` 单一瓶颈（严格校验器构造期从动词 schema 编译，additionalProperties:false），场景/CLI/probe 与 LLM 入口同一裁决口径（轨迹时间策略归调用方：引擎按授予交织）。裁决门顺序：未知动词 → schema → 可见性 → 规则。三类结构化拒绝：`action.unknown` / `action.schema` 为**协议性拒绝**（`deniedBy:"protocol"`，映射层形态错误属引擎↔模型通道流量，表达层整体过滤、理由回落 noResponse，诊断进 `Denial.debug`）；`action.invisible` 为世界性拒绝。**Messages 收窄**：契约只收解析后的 referent（名字），不收 id/属性名；机器诊断一律走 `Denial.debug`。
- **`systems`**：时间系统注册表，每 tick 按序执行，产出 deltas/facts；**fact-only 输出合法**——零状态变更的纯氛围事实同样成立并进入表达输入。**时间是裁决授予的后果维度（DESIGN 公理三时间律）**：`VerbDef.cost`（缺省 0）为尝试时价（成败皆消耗，协议性拒绝除外——映射层噪声不是尝试），授予可携 `ticks` 改写实际流逝；引擎在 act 工具内按动作交织推进（每动作裁决提交后 `sim.tick(r.ticks)`，elapsed 并入表达输入/近况，不计入 ActOutcome.results 的 kind）；无裁决即无流逝（拒绝/未解析回合世界静止）
- **两种创作形态（authorial regimes）**：**法则网络形态**——规则按属性组合键控、随新实体自动泛化（承重墙针对此形态，防组合爆炸）；**authored 形态**——梦核/脚本化世界的正当写法：互动按实体逐个书写（每条一个卫语句子句 + 兜底）、效果改写互动结果、实体生灭与动态拓扑。两形态共用同一套裁决瓶颈与提交硬墙，差异只在作者书写风格与不变式密度，core 不感知形态。
- **`grounding`**：可见实体索引钩子，决定哪些实体进状态视图；缺省全部可见（未声明认识论语义的诚实零）。感知面只有两个槽位（grounding/digestExtra）——准入门是「core 机器在协议通道内消费它」（状态视图装配/entityParams 可见性门/新见检测）。
- **`messages`**（GameDef 必填）：core 产出的用户可见文案（时间流逝、不可见实体等）由游戏注入自有语言；core 不内嵌任何语言。**契约只收解析后的 referent（实体名），不收 id/属性名**——机器诊断一律走 `Denial.debug`；协议性拒绝与 core 完整性不变式违反回落 `noResponse`。可达性理由文案内置于游戏侧空间构件 `src/games/space.ts`（`SpaceOpts.msgs` 可覆盖），不进 Messages。
- **`props`（属性注册表）**：`{ prop: { type, label?, internal? } }`。`internal: true` 的属性不进 LLM 序列化 / 变更线性化，从源头杜绝泄漏；`label` 是属性世界化说法（拒绝/变更文本用），**并是表达 prompt 变更馈送的默认渲染源**——「本回合尝试/时间流逝」用实体名 + `label` 做语言无关线性化（`fmtChange`，`name.label: from → to`，core 只做符号连接、不内嵌语言词）；动作侧同一纪律：`describeAction` 以 `verb.label(param,…)` 符号连接（未来 UI 若需本地化动作行，应消费结构化 `{verb,params}` 自行渲染，而非 core 预渲染）；tick 伪动词无游戏词可线性化，走 `messages.timePassed`。`internalPropsOf(def)` 派生内部属性集。
- **`summarize`**：确定性回退摘要钩子（游戏腔调、可读），缺省用引擎的通用 JSON 序列化。
- **状态视图**：prompt 的状态视图由 core 组装——可见实体（grounding）× 注册表过滤（internal 不进 prompt，隔离机械保证）× 关系端点可见过滤，顶层并入 `digestExtra`（游戏派生纹理：出口、随身清单等无 id 承诺的呈现面）。参照域契约由构造保证：视图实体索引 ≡ 可见性门的权威集——模型看得见的才可指名、可指名的必看得见。探测域、意图菜单等工具投影走 tools 层 per-game 配置（probe 的 PROBE_DOMAINS），不占协议面。
- **`deniedBy: "rule" | "protocol" | "invariant"`**：否决来源语义标记；`sim probe` 读标记报告缺口；protocol（映射层形态错误）不进玩家叙述；invariant（不变式硬墙的必要性拦截，规格违反信号或戏剧性必然）与法则否决是不同语义来源，审计可区分。
- **关系边表**：`world.relations` 为 `{ from, to, type, value }` 边表，表达社会/叙事状态（信任、记忆、派系）。规则以 `relSet/relInc` 变更，核心提供 `relVal/relAll` 查询。变更记录为 sum-typed `Change`（kind: prop/rel/spawn/despawn，与 Delta 同构）。变更在表达层格式化为「from 对 to 的 type」的世界腔文本，快照/克隆/序列化完整保留。
- **拒绝理由一律由规则层产出，模型不撰写拒绝理由**：模型直接提交 action 由规则层裁决（否认 → 规则 denyReason，授予 → 执行）；空提案进审计（outcome.kind = refused），表达层从意图本身自然回应。
- **事件流两形态**：systems 产出为刻步 `TickStep`（`kind:"tick"`，携带时刻 `at`、变更/事实/src），动作裁决为 `ActionStep`（`kind:"action"`）——刻是世界的因（提交失败不回退时间），不是意志的果，二者不共用形状。`sim run` 的 `advance N` 是工具层自有语法（显式摇钟，先于动词解析）。
- **游戏挂载点**：`props`（属性注册表：type/label/internal）。
- **`invariants`（GameDef 可选）**：提交后不变式硬墙——core 默认恒挂引用完整性与注册表类型契约（`integrityInvariant`：实体 id 唯一、id 型属性——标量或引用数组——与关系端点指向存在的实体；注册属性值与声明类型一致，number 拒非有限值——NaN 经 JSON 序列化即静默变 null；null/缺席放行，any 豁免），游戏可追加领域不变式。**违反即回滚整个提交并原子拒绝**（`commitChecked` 快照→提交→校验→回滚），法则、系统 bug 都无法绕过。完整性审的是提交终点：同一提交内 despawn 后 spawn 同 id 合法（同 id 生灭——中途悬空在终点自愈），留下悬空引用的抹除才被回滚。**两种形态同一接口**：`InvariantCtx` 除 `genesis` 外携带 `changes`（本提交全部变更，含 spawn/despawn 与 src）——状态不变式只读 world（守恒类），过渡不变式读提交（provenance 类）；每条规则/系统的提交独立过墙。**era/DoL 守恒模式**：游戏以 `sumProp`（core 聚合助手）声明「聚合值 == 种子值」的不变式，凭空铸币/灭币一律被回滚。**种子锚点是 `InvariantCtx.genesis`**——本 Simulation 实际起点世界的冻结快照（首提交前情性捕获），存档恢复/变体开局时 ≠ def.world，守恒不错锚。**引用清点原语 `refsTo(def, world, id)`**：despawn 前的悬空引用盘点（按注册表 type:"id" 枚举指向实体的 (entity, prop)，标量与引用数组同覆盖——与硬墙管辖面一致，墙拦下的悬空这里必须找得到），清理策略留规则；关系边由 despawn 自动级联。**提交执行校验（fidelity）同属这条原子通道**：每条 delta 应用时必须可执行——目标实体/关系端点存在、spawn id 未占用、inc/relInc 现值为有限数（缺席按 0）、数值后果有限——不可执行即整体回滚拒绝（law `invariant.commit`，deniedBy 不变，debug 诊断）；执行翼审「裁决被如实执行」，不变式审「提交后的世界成立」，幂等跳过的唯一判据是「目标状态已成立」（relSet 删不存在的边成立——无边即状态；set 同值与增量零效果以目标存在为前提，主语缺失即拒绝，永不回落为跳过）。
- **core 只提供通用工具，不耦合游戏**：随机由 games 层以 World 状态自持（纯函数派生），`World` 即完整真相源，apply/dryTick/存档/恢复天然一致，无隐藏变量。core 提供的通用原语：`hashStr`（确定性哈希）、`roll`（确定性骰子，`hashStr(time#key)` 派生 [1,sides]，key 需同 tick 唯一——规则经 `Q.roll(key, sides)` 调用，apply/dryTick 天然一致）、`sumProp`（聚合助手，守恒不变式用）、`integrityInvariant`（引用完整性与注册表类型契约硬墙）。引擎隐式语义经只读上下文 `Q` 具名入口收口（`q.time` 读时刻、`q.roll` 骰子等）。
- **games 层怎么写都行，且永不耦合进 core**：games 代码允许任意写法与重复样板——这是创作者的自由，即便多个游戏收敛出相同形态，也不得「提升为 core 工具」。共享的游戏侧语义只走 games/ 内自愿接入的构件。

## 4. 持久化边界

模拟层状态是 JSON 可序列化的，SQLite 不存热状态，存存档与审计（**目标**；原型期由 `loop` 的 `runs/` 目录以 JSONL + `state.json` 落盘，SQLite 落地后迁移）：

| 表 | 内容 |
|---|---|
| `games` | 游戏实例：id、状态机类型、创建时间、状态快照(JSON)、存档 |
| `messages` | 回合历史：用户操作、映射结果、表达层输出（回放/审计） |
| `sessions` | pi SDK 会话索引（SDK 自己写 JSONL，这里只存元数据 + 映射关系） |

**重放边界**：决策是代码、代码不序列化——transcript 可重放事件流（裁决结果），不可重放裁决过程；存档兼容须钉住整个 def（规则代码的版本耦合），这是「规则即代码」的定义性代价。

## 5. 研究与验证经验

1. **端到端 `loop` 才是有效验证，`sim` 只验证确定性裁决。** `sim scenario` 断言"能授予/能拒绝 + 状态正确"，但真实质量只有 `loop` 能测，编译无错误和sim验证通过什么都说明不了。
2. **LLM 有随机性，单次 e2e 结果带噪声。** 同一意图两次跑可能映射到不同动词，且同一会话内世界状态会级联（前一步点燃了柴 → 下一步"泼湿"被不变式回滚）。做机制对比要控制变量：**同世界、同开局、同意图集、每组独立开局**；跨回合级联导致的差异不要误判为机制差异。
3. **映射层会拆解复合意图，掩盖"菜单"缺陷。** AI 把复合意图拆成多条动作各自命中，单动作 e2e 上机制差异常被掩盖；真实差异藏在**授予理由一致性**、**实现审阅**（malformed op 静默假授予）与**作者负担行数**里。**e2e 成功率高不等于设计好。**