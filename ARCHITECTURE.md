# 技术架构决策记录

## 1. 已确定的技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | **Electron** | |
| LLM 编排 | **pi coding-agent SDK**（进程内） | `@earendil-works/pi-coding-agent`，非 RPC mode，进程内集成；已发布 npm 包，直接依赖 registry 版本；SDK 文档随包分发在 `node_modules/@earendil-works/pi-coding-agent/docs/`（SDK API 见 `sdk.md`） |
| 持久化 | **SQLite** | 存档 + 回合审计，存什么见 §3 |

## 2. 核心架构主张

1. **模拟层 + pi SDK 必须同进程、共享状态。** 表达层要把状态快照注入 prompt，映射层要返回实体 ID；模拟层在主进程 TS 里，状态天然同内存，无序列化、无双份表示、无对齐问题。
2. **pi SDK 是映射层与表达层的宿主。** DESIGN.md 的三层架构落到 pi SDK 概念：

   | DESIGN.md 层 | pi SDK 落点 |
   |---|---|
   | 映射层 §4.2 | 一个自定义 tool：`defineTool({ name: "act", ... })`（actions 列表：`{ verb, params }`，schema 从游戏动词表生成）；映射 pass 只产结构化结果 |
   | 表达层 §4.3 | 第二个自定义 tool `declare` + session 的普通文本输出（`text_delta` 流式）；在状态变更后的独立 prompt（双 pass），输入 = 当前状态 + changes + 法则 facts |
   | 模拟层 §4.1 | tool 的 `execute()` 内部，确定性规则网络（按动词分组），唯一的游戏状态出口 |
   | 会话/上下文 §9 | AgentSession 自带：messages + compact() + SessionManager；叙述不回流（幻觉不固化） |
   | 拒绝 §4.2 | 结构化拒绝（仅 label）+ `considered` 交规则裁决：理由由规则/denyAll 给出，映射 pass 不产散文 |

3. **"只有两个出口"是这个 SDK 的默认结构。** session 只给 act + declare 两个 tool：映射阶段模型 `act`（提案 actions）或写文字；表达阶段模型先用 `declare` 声明本回合新事实（可选，可多次调用、回合内逐条校验反馈）、随后输出散文正文；`execute()` 内部就是规则裁决/校验边界。
4. **IPC 形态：主进程 → 渲染层是推送（事件流），渲染层 → 主进程是请求（invoke）。** pi SDK 是事件流式的（`text_delta` / `tool_execution_*`），经转发器 `webContents.send()` 推给前端。
5. **tool schema 是动作提案**——`act(actions)`，actions 为 `{ verb, params }` 列表；verb 必须取自 `GameDef.verbs`，非法/不可见实体 ID 在 `execute()` 校验层打回，不进入状态机。**无别名表、无关键词匹配、无语言限制**：动词与实体都由 LLM 从自由文本中纯语义解析（`name + attrs + 上下文`），不限制玩家输入语言；动词空间是游戏声明的（不再硬编码 apply/move/set）。

6. **上下文裁剪已启用（`context` 事件 + 近况记录）**：每次 LLM 调用前经内联扩展（`DefaultResourceLoader.extensionFactories` 的 `cave-context`，`core/context.ts` 为策略单一来源）把消息裁剪为「近况记录 + 当前运行后缀」——后缀 = 最后一条 user 消息起的原样保留（toolCall/toolResult 配对天然完整），近况 = 最近 6 回合的「意图 → 世界腔裁决行」，并入该 user 消息头部。会话文件仍累积全量消息作审计；近况另以 custom 条目持久化于同一文件（custom 不参与 LLM 上下文），进程重启由其重建窗口。**缓存代价是显式决策**：状态每回合重注入使消息前缀天然不稳定，跨调用前缀复用只剩 [tools+system] 头块——因此系统提示与工具数组必须字节级稳定（易变状态一律走 per-turn prompt，禁入系统提示），且不做 setActiveTools 相位切换（工具块位于序列化前缀头部，每次切换即整体前缀失效）。compaction 保持关闭：pi 缺省摘要是编码任务形状、且把旧叙述摘要重新注入，与「模拟层唯一真相源」相悖；长度兜底走显式新开会话。资源发现全部关闭（noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles）：cwd 的 AGENTS.md/扩展/技能不得泄入游戏 prompt。

## 2.5 GameDef 表面契约

- **`verbs`**：游戏声明的动词表，每个动词含 `schema`（TypeBox，生成 act 工具参数校验，并经 `defineVerb` 推导规则参数的编译期类型）、`entityParams`（哪些参数是实体 id，供可见性校验）、`candidates`（非实体参数的候选值，动作空间接地与探测共用）、`rules`（卫语句式规则函数，按序裁决首个表态即判决；末尾可挂 fallback 兜底规则）。动词集由各游戏声明：era/DoL 类可声明 `talk/travel/equip` 等，开放世界可声明 `attack/trade/craft` 等。`set` 通用动词及其"属性选择器"参数（`propParams`）是错误设计，已移除——"改属性"的语义应由游戏自定的领域动词 + 法则承担。
- **环境响应（声明式动词）**：非预设的自由动作由游戏声明动词 + 法则承担——法则网络形态按属性键控一条规则覆盖全部可达实体；authored 形态则逐实体书写互动子句。结构性属性（`in`/`material`/`lit`/`burning`/`open`/`coins`/`alive`…）仍只能由法则/系统变更；语义一致性由领域不变式（`invariants`）兜底。
- **动作空间接地**：`Simulation.affordances()` 每回合枚举 动词 × 可见实体 × `candidates` 的只读裁决 `check()`，把当前世界会授予的动作注入映射 prompt（预算按动词均分）。**施动工具参数（`instrumentParams`）在枚举时自动跳过不可持握实体**——固定在地面、搬不动的重物不再出现在施动位。映射层仍可提出动作空间之外的动作，由规则层裁决。**`GameDef.affordances:false` 整体关闭接地注入**：发现式世界的菜单即剧透，试错本身是玩法。
- **`Rule`（卫语句式规则，按动词分组，取代 Expr/Law AST 解释器）**：`{ id, judge(q, p) }`——普通函数接收只读判定上下文 `Q`（world/actor/time/params + `rel/relNum/roll/canReach/name` 等引擎语义唯一入口），返回授予（Delta 列表 + 世界腔理由 + facts）或结构化拒绝（Denial），null = 不表态交由后续规则；拒绝/授予优先序就是书写顺序（guard clauses），解释器的隐式控制流（短路吞没、denial 记录覆写）不复存在。数值与后果由规则产出的 Delta 表达（`set/inc/relSet/relInc/spawn/despawn`——生灭原语让梦核/authored 世界可动态生长，despawn 级联清理核心结构、悬空 id 引用由完整性硬墙回滚），LLM 不提案数值。时间系统 `GameDef.systems` 同为纯函数规则（`SystemRule.run(q)` 聚合产出 deltas/facts）。**迁移依据见 §5-13**：法则不序列化、不被静态分析、不构成沙箱边界，数据化只留下成本——分界线落在快照上：跨提交/回滚/审计边界的产出（Delta/Denial/Fact）保持数据，产出的决策回归代码；隐式语义显式化为具名入口（如 `relNum` 的缺边缺省在调用点写明）。
- **`fallback` 兜底规则**：动词末尾的无条件拒绝规则，其 Denial 带 `fallback: true` 结构化标记（取代 `denyAll.` 前缀字符串分类）；runner 对全部规则未表态的动作回落 noResponse（同样计为 denyAll）。散文内联在规则文本里，`sim probe` 据标记报告法则缺口。
- **拒绝文案内联（取代 `denialTemplates` 并行映射）**：拒绝理由以世界腔字符串直书在规则代码里（`deny(law, { reason })`），缺省回落 `messages.noResponse`——"一个行为的文案与其条件同处一处"。core 产出的拒绝由 `Messages` 注入语言：施动工具前提（`instrumentUnholdable`/`instrumentUnreachable`，收工具名）、不可见实体（`invisibleEntity`，可选，收解析后的实体名）。**不变式按产出方渲染**：core 完整性违反只有 debug 诊断（回落 noResponse）；游戏不变式的 message 是游戏撰写的世界腔，直接作玩家文案（取代 invariantRejected 手工分流）。
- **校验收敛与协议性拒绝**：动词存在/schema/实体可见性校验从 act 工具收敛进 `Simulation.adjudicateRaw` 单一瓶颈（严格校验器构造期从动词 schema 编译，additionalProperties:false），场景/CLI/probe 与 LLM 入口同一裁决口径。裁决门顺序：未知动词 → schema → 施动工具前提 → 可见性 → 规则。三类结构化拒绝：`action.unknown` / `action.schema` 为**协议性拒绝**（`deniedBy:"protocol"`，映射层形态错误属引擎↔模型通道流量，表达层整体过滤、理由回落 noResponse，诊断进 `Denial.debug`）；`action.invisible` 为世界性拒绝（已存在但不可见的实体用游戏自己的 `reachReason` 槽位解释，幻觉 id 无名字回落通用文案；工具参数的不可达由 instrument 门优先点名工具）。**Messages 收窄**：契约只收解析后的 referent（名字），不收 id/属性名；机器诊断一律走 `Denial.debug`。
- **`systems`**：时间系统注册表，每 tick 按序执行，产出 deltas/facts（火蔓延、燃尽、日程等）；**fact-only 输出合法**——零状态变更的纯氛围事实（如梦中低语）同样成立并进入表达输入与声明契约。**`reactiveSystems`（GameDef 可选，默认 false）开启后，granted 动作提交后立即按序跑一次 systems**——把火源放入易燃物当场引燃、开箱触发陷阱等“动作→世界响应”的因果链在当回合成立，不依赖显式 wait。reactive 产出并入动作的 StepResult（facts/involved 合并），不重复入日志 **`turnTicks`（GameDef 可选，缺省 0）是回合级时间驱动**：引擎在 act() 的动作裁决后、表达前 `sim.tick(n)` 并把 elapsed 并入表达输入/声明契约/近况，不计入 ActOutcome.results（kind 只反映玩家动作）；缺省 0 保持既有行为。
- **两种创作形态（authorial regimes）**：**法则网络形态**——规则按属性组合键控、随新实体自动泛化（承重墙针对此形态，防组合爆炸）；**authored 形态**——梦核/脚本化世界的正当写法：互动按实体逐个书写（每条一个卫语句子句 + 兜底）、效果改写互动结果、实体生灭与动态拓扑。两形态共用同一套裁决瓶颈、提交硬墙与表达契约，差异只在作者书写风格与不变式密度，core 不感知形态（先例：yume 以四动词、零领域不变式、两氛围系统实现「发现即玩法」）。
- **`grounding`**：可见实体索引钩子，决定哪些实体进 LLM 序列化；缺省全部可见。**`reach`/`reachReason`（GameDef 可选）是可达性空槽**：`P.reach`/施动工具前提共用的谓词，缺省全可达、无理由——core 不内嵌任何空间模型；容器包含树语义是游戏侧构件 `src/games/space.ts`（`inTreeReach`/`inTreeVisible`/`reachFor`），需要空间语义的游戏自选接入。**`holdable`（GameDef 可选）是可持握空槽**：施动工具前提/`wieldable` 共用的谓词（`wieldable = holdable + reach`），core 不提供缺省——未声明的游戏一律不可持握；可持握语义（grabbable 属性、体力门槛、材质、锋利等）由游戏声明，与 `reach` 同一模式。
- **`messages`**（GameDef 必填）：core 产出的用户可见文案（时间流逝、施动工具前提、不可见实体等）由游戏注入自有语言；core 不内嵌任何语言。**契约只收解析后的 referent（实体名），不收 id/属性名**——机器诊断一律走 `Denial.debug`；协议性拒绝与 core 完整性不变式违反回落 `noResponse`。可达性理由文案内置于游戏侧空间构件 `src/games/space.ts`（`SpaceOpts.msgs` 可覆盖），不进 Messages。
- **`probeScope`**（GameDef 可选）：法则探测域钩子，决定 `sim probe` 枚举动作参数候选时使用的实体集；缺省 = 可见实体 - 玩家 - `space` 标记的场景实体。大实体量游戏可在此裁剪（如只给可交互实体），控制 probe 组合规模与信号质量。
- **泄漏检查（`leakageCheck` 已移除）**：散文正文曾有一道"只禁实现工件"的通用泄漏检查（JSON 键值对形态、声明头 `[facts:` 复现、「实现形状」的 id/属性名词边界匹配）。研究与 `forbiddenTerms` 同源：标识符分支是词表式匹配，纯小写豁免规则（`!/^[a-z]+$/`）本身是语言假设、与"引擎不感知语言"的立场矛盾，且与系统提示"不得写出 id/属性名"重复——豁免规则把纯小写世界整体排除在守卫面外，其实际守卫面仅剩非纯小写标识符这一自设窄面。任何校验误触发都会走重试/摘要回退路径。 整机制随 `forbiddenTerms` 一并移除——正文不再有机械检查，忠实性只由声明契约（新事实 ⊆ 状态可推导集）+ 提交硬墙承担；JSON dump 等格式崩坏由 declare 工具的参数 schema 天然拦截。语言相关的词汇约束**不设硬拦截**（`forbiddenTerms` 已移除）：语言是 LLM 的原生能力，交给 prompt 设计与模型合规，词表式硬约束不提高游戏上限、只引入维护负担。
- **`props`（属性注册表）**：`{ prop: { type, label?, internal?, stylistic? } }`。`internal: true` 的属性（如 `burnTicks`、`actor` 标记）不进 LLM 序列化 / changes / 表达校验，从源头杜绝泄漏；`label` 是属性世界化说法（拒绝/变更文本用），**并是表达 prompt 变更馈送的默认渲染源**——「本回合尝试/即将发生」用实体名 + `label` 做语言无关线性化（`fmtChange`，`name.label: from → to`，core 只做符号连接、不内嵌语言词），不再输出 raw `entity.prop`（A/B 实证无回归，且消除与「不写出 id/属性名」约束的自相矛盾；缺 label 回退 raw 属性名，可见属性应声明 label）；动作侧同一纪律：`describeAction` 以 `verb.label(param,…)` 符号连接（未来 UI 若需本地化动作行，应消费结构化 `{verb,params}` 自行渲染，而非 core 预渲染）；tick 伪动词无游戏词可线性化，走 `messages.timePassed`；`stylistic: true` 标记润饰属性（表达层可文学润饰，如「刻痕斑驳」）。`internalPropsOf(def)` / `stylisticPropsOf(def)` 派生内部/润饰属性集。
- **词表断言扫描器（已移除）**：`GameDef.assertionRules`（弱/强断言词 + 矛盾目标 + `impossibleOnly`）+ `negationWords` / `sentencePunct` / `assertionPunct` 与 core 的 `checkAssertions`/`scanClaims`（词表 + 近邻窗口的子串启发式）全删——研究结论见 §5-10/§5-11：词表 + 近邻窗口对"持有"类语义结构性失效（假阳性重试/回退 + 假阴性漏网），其唯一实证真阳性（被拒动作后声称对象状态改变）已被声明契约的"状态可推导集"收紧结构性覆盖。**一致性由声明契约 + 提交硬墙（法则/不变式）承担，core 不再假设语言、不再假设"词"这一概念。**
- **表达层声明契约（唯一契约 structured，工具化）**：新事实经第二个自定义工具 `declare` 以结构化参数提交（每条 `{ entities: string[], statement }`），涉及集推导与校验集中在 `core/declare.ts`（单一来源：`validateFactIds`）。校验为集合成员判断——实体须可见且属本回合**状态可推导集**（touched：actor + 法则 facts + 新见 + 变更/即将发生 + 授予动作参数；被拒动作参数不在内——被拒动作未改变任何状态），无名字回退。逐条错误即时返回，模型在同一 turn 内自我纠正（无需重试 prompt）。**Fact 认识论（§4-12）**：percept（缺省）facts 的实体进 touched；utterance（世界之言，如梦中低语）不进——话语只许被转述，不许据以断言状态。
- **`summarize`**：确定性回退摘要钩子（游戏腔调、可读），缺省用引擎的通用 JSON 序列化。
- **`digest`**：序列化投影钩子（GameDef 可选），决定状态以什么形态进映射/表达 prompt；缺省 = `serialize()` 全量 JSON。游戏可裁剪冗余字段、格式化关系边、聚焦点置顶，以控制 prompt 体积。
- **`deniedBy: "rule" | "denyAll" | "protocol"`**：否决来源语义标记；`sim probe` 依此报告规则缺口（只认 denyAll），不依赖理由字符串匹配；protocol（映射层形态错误）不进玩家叙述。
- **焦点与拒绝痕迹**：`Simulation` 确定性维护 `world.focus`（本回合动作/新见/被拒实体，跨回合指代锚点）与 `world.traces`（实体 id → 累计被拒次数，拒绝痕迹）。二者进序列化，映射 prompt 注入 `[焦点]` 提示（「它/那个」优先指向 focus，但以玩家显式提到的实体为准）。
- **关系边表**：`world.relations` 为 `{ from, to, type, value }` 边表，表达社会/叙事状态（信任、记忆、派系）。规则以 `relSet/relInc` 变更，核心提供 `relVal/relAll` 查询。变更在表达层格式化为「from 对 to 的 type」的世界腔文本，快照/克隆/序列化完整保留。
- **refusal 契约**：act 工具 `refusal` 只含 `label`。**理由一律由规则层产出，模型不撰写拒绝理由**：模型直接提交 action 由规则层裁决（否认 → 规则 denyReason，授予 → 执行）；纯拒绝（label）进审计，表达层自然回应。`refusal.considered`（模型预判被拒的动作交规则裁决以纠正误判）为**未实现的未来优化**。`sim probe` 可把 refusal 标签纳入覆盖报告。
- **`--game` / 游戏注册表**：`src/games/registry.ts` 按 id 解析 GameDef，`loop`/`sim` 工具均已参数化，不再硬编码游戏 id。**tool 层不提供隐藏默认值**：`loop start` / `sim run` / `sim probe` 必须显式 `--game`；`sim scenario` 必须显式场景文件路径（场景文件内声明 `game`）；`loop` 除 `report` 外各命令必须显式 `--run`。`sim verify` 自动发现并运行 `scenarios/` 下全部场景（跳过未注册游戏，归档场景保留作参考）。`loop` 缺省输出紧凑人类可读结果（提案/裁决/校验警告/token 用量/叙述），`--json` 为完整结构化模式；每回合 LLM usage（含 cacheRead）经 EngineEvent 进 transcript，`loop batch <file>` 在同一引擎会话内顺序执行意图文件（#注释、@wait N），`loop report [--game]` 跨 run 汇总回合/裁决分布/校验失败/用量——对照实验（§5-2）的一眼视图；研究辅助脚本 research.ts 已由紧凑输出取代删除。`loop` 的引擎配置环境变量按游戏 id 命名空间读取：`<GAME>_PROVIDER` / `<GAME>_MODEL` / `<GAME>_THINKING`，多游戏并存互不覆盖。
- **引擎保留伪动词 `TICK_VERB`**：`"tick"` 是引擎级时间流逝动作标识（`systems` 产出的 StepResult 与 `loop wait` 用），非游戏声明的动词；游戏不应声明同名动词。`sim run` 的 `tick N` 关键字在游戏声明同名动词时优先走游戏动词。
- **游戏挂载点**：`hint`（世界法则提示注入映射系统提示）、`props`（属性注册表：type/label/internal/stylistic）。
- **`invariants`（GameDef 可选）**：提交后不变式硬墙——core 默认恒挂引用完整性（`integrityInvariant`：实体 id 唯一、id 型属性/关系端点/焦点指向存在的实体），游戏可追加领域不变式（如「燃着必须明火」）。**违反即回滚整个提交并原子拒绝**（`commitChecked` 快照→提交→校验→回滚），法则、系统 bug 都无法绕过。**era/DoL 守恒模式**：游戏以 `sumProp`（core 聚合助手）声明「聚合值 == 种子值」的不变式（如 village 的 `coins.conserved`：铜币总量 == 初始世界总量），凭空铸币/灭币一律被回滚。**种子锚点是 `InvariantCtx.genesis`**——本 Simulation 实际起点世界的冻结快照（首提交前情性捕获），存档恢复/变体开局时 ≠ def.world，守恒不错锚。
- **core 只提供通用工具，不耦合游戏**：状态化 rng 已移除——随机由 games 层以 World 状态自持（纯函数派生），`World` 即完整真相源，check/apply/dryTick/存档/恢复天然一致，无隐藏变量。core 提供的通用原语：`hashStr`（确定性哈希）、`roll`（确定性骰子，`hashStr(time#key)` 派生 [1,sides]，key 需同 tick 唯一——规则经 `Q.roll(key, sides)` 调用，check/apply/dryTick 天然一致）、`sumProp`（聚合助手，守恒不变式用）、`reach`/`reachReason`（可达性空槽，空间构件由游戏自选，如 `src/games/space.ts`）、`holdable`（可持握空槽，游戏必须声明，core 不提供缺省，可持握语义由游戏自定）、`integrityInvariant`（引用完整性硬墙）。引擎隐式语义经只读上下文 `Q` 具名入口收口（`q.time` 读时刻、`q.roll` 骰子等）。多时间尺度（回合/日/月）由游戏自持（`world.day` 等计数器，systems 内按 `q.time` 判定），core 不内置历法。
- **games 层怎么写都行，且永不耦合进 core**：games 代码允许任意写法与重复样板（含按实体键控的特判、逐游戏重复的 digest/summarize/label 派生）——这是创作者的自由，不是待修的债；即便多个游戏收敛出相同形态，也不得「提升为 core 工具」——core 吸收游戏侧形态即开始耦合游戏、挤压其余游戏的写法空间。共享的游戏侧语义只走 games/ 内自愿接入的构件（先例：`src/games/space.ts`）。

## 3. 持久化边界

模拟层状态是 JSON 可序列化的，SQLite 不存热状态，存存档与审计（**目标**；原型期由 `loop` 的 `runs/` 目录以 JSONL + `state.json` 落盘，SQLite 落地后迁移）：

| 表 | 内容 |
|---|---|
| `games` | 游戏实例：id、状态机类型、创建时间、状态快照(JSON)、存档 |
| `messages` | 回合历史：用户操作、映射结果、表达层输出（回放/审计） |
| `sessions` | pi SDK 会话索引（SDK 自己写 JSONL，这里只存元数据 + 映射关系） |

## 4. 研究与验证经验

1. **端到端 `loop` 才是有效验证，`sim` 只验证确定性裁决。** `sim scenario` 断言"能授予/能拒绝 + 状态正确"，但真实质量（自由文本意图能否被映射到正确动词、表达层能否零幻觉叙述）只有 `loop` 能测，编译无错误和sim验证通过什么都说明不了。
2. **LLM 有随机性，单次 e2e 结果带噪声。** 同一意图两次跑可能映射到不同动词，且同一会话内世界状态会级联（前一步点燃了柴 → 下一步"泼湿"被不变式回滚）。做机制对比要控制变量：**同世界、同开局、同意图集、每组独立开局**；跨回合级联导致的差异不要误判为机制差异。
3. **模型合规率是经验量，合成套件推断不可靠** 凡"模型会不会照格式输出"的问题必须 e2e 测，合成套件只测机制正确性（正确/错误分类）。
4. **映射层会拆解复合意图，掩盖"菜单"缺陷。** AI 把复合意图拆成多条动作各自命中，单动作 e2e 上机制差异常被掩盖；真实差异藏在**授予理由一致性**、**实现审阅**（malformed op 静默假授予）与**作者负担行数**里。**e2e 成功率高不等于设计好。**
5. **映射层会产出非法形状——但消灭 LLM 形态数据入口比归一化更彻底。** 动作参数全部是 schema 校验的普通动词参数后，整类归一化（曾为裸 id/非法 claim 加 `normalizeProof` 兜底）随之消失。凡"模型可能产生、但多数时候能自我纠正"的形态：要么归一化，要么**从源头不引入该形态**（优先）。
6. **软通道（AI 提后果）是作者负担优化，不是输出质量机制——已移除。** 与实体不可知法则 e2e 等价，可写面由属性注册表决定、软通道不增加它；唯一真实收益是作者负担（每可写属性 1 个 access 标记 vs 1 动词 + 1 法则）与工具表面（恒 1 动词 `do`），仅在几十个软属性时才有意义——当前场景的正解是实体不可知法则（声明式动词）而非 fallback 通道。
7. **软通道的产出质量结构性地更差，且藏静默假授予 bug——根因是"第二套不受 schema 约束的数据入口"。** (a) **授予理由退化**：`softAdjudicate` 成功分支从不产 reason，授予理由恒为模型 `proof.reason` ?? `"……"`；(b) **静默假授予**：proof 在 tool 边界无 schema 校验，`op` 写成 `"Set"`/`"increment"`/`"SET"` 绕过全部 op 与类型校验，`ok=true` 且零变更——世界说成功而状态未变；(c) **拒绝理由泄漏 debug**（含裸属性名）。与 DESIGN §1「AI 不产生系统后果」长期矛盾，移除后矛盾消除——后果只能由法则/系统产出，经提交硬墙（引用完整性 + 领域不变式）原子裁决；era/DoL 极与开放世界极由此**共用同一套机制**（动词表 + 法则 + 不变式），重量差异只来自游戏声明的法则与不变式，不来自 core 的原语集合。
8. **structured-only 声明契约取代 prose + 词表断言扫描器——e2e 净胜，确定性复现"子串匹配不可维护"的最终结局。** 散文一致性由声明契约（新事实 ⊆ 状态可推导集）+ 提交硬墙（法则/不变式原子回滚）承担；词表 + 近邻窗口的子串启发式整体移除，core 不再感知语言、不再假设"词"。**一致性责任的正确归属**：era/DoL 极的"强一致"来自法则 + 不变式 + 原子回滚（模拟侧），叙述侧只需声明契约这一条语言无关边界；**"正文暗含新事实"的机器拦截仍是未解 NLP 难题**，但实证表明声明契约 + 提示约束下模型正样本不越界；比维护必然漏检又误报的词表更划算。
9. **Expr/Law 数据化是类别错误——AST 解释器整体迁除。** 检验"法则作为数据"的四条可能收益全部落空：不序列化（存档只存 World）、无静态分析（probe 是纯执行）、无沙箱边界（GameDef 其余钩子本就是任意闭包）、工具化属假设性未来。成本却实在：嵌套对象字面量的可读性、无法断点的不可调试性、每个新语义要长进解释器/构造糖/文档三层（roll/time/reachReason 节点即实证）、var 拼写错误静默落到 denyAll。分界线落在快照上：跨提交/回滚/审计边界的产出（Delta/Denial/Fact）保持数据，产出的决策（条件/量词/优先级）回归卫语句式闭包；隐式语义显式化为具名入口（`relNum` 的缺边缺省写在调用点）。
