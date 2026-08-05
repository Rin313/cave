# 技术架构决策记录

> 本文档记录与 DESIGN.md 平行的技术选型与工程决策，随讨论持续更新。未决项写入 §4。

## 1. 已确定的技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | **Electron** | 非 Tauri |
| 前端框架 | **Vue 3** + Vite | 渲染进程 |
| LLM 编排 | **pi coding-agent SDK**（进程内） | `@earendil-works/pi-coding-agent`，非 RPC mode，进程内集成；已发布 npm 包，直接依赖 registry 版本；SDK 文档随包分发在 `node_modules/@earendil-works/pi-coding-agent/docs/`（SDK API 见 `sdk.md`） |
| 持久化 | **SQLite** | 存档 + 回合审计，存什么见 §3 |
| Node 运行时 | **Node 26** | 开发环境工具链；主进程实际运行在 Electron 内嵌 Node 上（Electron 43 内嵌 Node 24.18 ≥ pi SDK 的 `engines.node >= 22.19`；系统 Node 与内嵌 Node 相互独立，不冲突） |

## 2. 核心架构主张

1. **模拟层 + pi SDK 必须同进程、共享状态。** 表达层要把状态快照注入 prompt，映射层要返回实体 ID；模拟层在主进程 TS 里，状态天然同内存，无序列化、无双份表示、无对齐问题。
2. **pi SDK 是映射层与表达层的宿主。** DESIGN.md 的三层架构落到 pi SDK 概念：

   | DESIGN.md 层 | pi SDK 落点 |
   |---|---|
   | 映射层 §4.2 | 一个自定义 tool：`defineTool({ name: "act", ... })`（actions 列表：`{ verb, params }`，schema 从游戏动词表生成），且为 session 里唯一启用的 tool；映射 pass 只产结构化结果 |
   | 表达层 §4.3 | session 的普通文本输出（`text_delta` 流式），在状态变更后的独立 prompt（双 pass），输入 = 当前状态 + changes + 法则 facts |
   | 模拟层 §4.1 | tool 的 `execute()` 内部，确定性规则网络（按动词分组），唯一的游戏状态出口 |
   | 会话/上下文 §9 | AgentSession 自带：messages + compact() + SessionManager；叙述不回流（幻觉不固化） |
   | 拒绝 §4.2 | 结构化拒绝（仅 label）+ `considered` 交规则裁决：理由由规则/denyAll 给出，映射 pass 不产散文 |

3. **"只有两个出口"是这个 SDK 的默认结构。** session 只给一个 tool，模型要么 `act`（提案 actions），要么写文字；`execute()` 内部就是规则裁决边界。
4. **IPC 形态：主进程 → 渲染层是推送（事件流），渲染层 → 主进程是请求（invoke）。** pi SDK 是事件流式的（`text_delta` / `tool_execution_*`），经转发器 `webContents.send()` 推给 Vue。
5. **tool schema 是动作提案**——`act(actions)`，actions 为 `{ verb, params }` 列表；verb 必须取自 `GameDef.verbs`，非法/不可见实体 ID 在 `execute()` 校验层打回，不进入状态机。**无别名表、无关键词匹配、无语言限制**：动词与实体都由 LLM 从自由文本中纯语义解析（`name + attrs + 上下文`），不限制玩家输入语言；动词空间是游戏声明的（不再硬编码 apply/move/set）。

## 2.5 已落地的 GameDef 表面契约

- **`verbs`**：游戏声明的动词表，每个动词含 `schema`（TypeBox，生成 act 工具参数校验）、`entityParams`（哪些参数是实体 id，供可见性校验）、`candidates`（非实体参数的候选值，动作空间接地与探测共用）、`laws`（该动词的声明式法则，按声明顺序短路，首条 granted 生效；末尾可挂 `denyAll.*` 兜底法则）。`propParams`（可选）标记哪些非实体参数是"属性选择器"（取值是实体属性名，如 `set` 的 `prop`）——core 据此做属性标签替换、affordances 按属性相关性排序、probe 的有意义缺口过滤，不再硬编码参数名 `"prop"`（当前参考游戏未使用该能力，保留）。动词集由各游戏声明：era/DoL 类可声明 `talk/travel/equip` 等，开放世界可声明 `attack/trade/craft` 等。
- **环境响应（声明式动词，v3 取代软通道）**：非预设的自由动作由游戏声明动词 + 实体不可知法则承担——如 waste 的 `mark`/`examine`，`when` 按 `reach` 键控，一条法则覆盖全部可达实体（无 2^N 组合面）。结构性属性（`in`/`material`/`lit`/`burning`/`open`/`coins`/`alive`…）仍只能由法则/系统变更；语义一致性由领域不变式（`invariants`）兜底（如「湿柴不得燃烧」一条声明式取代逐条守卫）。**软通道已移除（v3）**：`fallback:"soft"`/`access:"soft"`/`Proof`/`proofSchema`/`softAdjudicate`/`normalizeProof` 全删（研究结论见 §5-8~11）——AI 提后果与实体不可知法则在 e2e 上等价且可写面相同，却带授予理由退化与静默假授予 bug；移除后 DESIGN §1「AI 不产生系统后果」重新成立。
- **动作空间接地**：`Simulation.affordances()` 每回合枚举 动词 × 可见实体 × `candidates` 的只读裁决 `check()`，把当前世界会授予的动作注入映射 prompt（预算按动词均分、实体按相关属性排序）。**施动工具参数（`instrumentParams`）在枚举时自动跳过不可持握实体**——固定在地面、搬不动的重物不再出现在施动位。映射层仍可提出动作空间之外的动作，由规则层裁决。
- **`Law`（声明式法则，按动词分组）**：`{ id, over?, when?, each?, denies?, reject?, reason?, facts? }`，解释器 `evaluateLaw` 对动作裁决，产出 `LawResult` = `{ granted, reason, denial: Denial, deltas: Delta[], facts?, involved? }`。数值与后果由法则产出（Delta：`set/inc/push/del`，支持点路径；关系边 `relSet/relInc/relDel`；`spawn/destroy` 仅 tick 系统使用），LLM 不提案数值。时间系统 `GameDef.systems` 同为 `Law[]`（`evaluateSystem` 聚合全部量词匹配）。
- **开放通道（反向解析，`fallback: "proven"`，已移除）**：非预设动词不接受 AI 手写 deltas——proof 给 `claims`（前置事实，须为真）+ `desired`（期望后果），`resolveUnscripted` 在开放法则（`Law.open` 标记或 `GameDef.openLaws`）中反查：对每条法则用 desired 解出变量绑定（效果模板形状匹配），forward 求值后若其后果覆盖 desired，**经该法则提交**（级联/不变式/痕迹照常）。未命中落 `denyAll.*`。这是"AI 提后果、世界走法则"的重量机制：无开放法则能产出的后果（凭空改材质、传送不可持握物）一律被拒。`openLawsOf(def)` 汇集 `GameDef.openLaws` + 动词 laws 中 `open:true` 者。

  **已移除（v2→v3，替换为环境响应声明式动词）**：精确模板匹配把"自由面"绑定到法则枚举——每加一种环境写需一条法则、每加一个属性组合需 2^N 组合法则，交互面随法则量膨胀，即"菜单化"。v2 曾由 `fallback: "soft"` 软通道承担（`Law.open` / `GameDef.openLaws` / `resolveUnscripted` 已删；点燃/采集/移动/开合迁为预设 law 动词）；v3 研究证明软通道与实体不可知法则等价（§5-8），且软通道自身带授予理由退化与静默假授予 bug（§5-9），已一并移除，环境响应改由实体不可知法则承担（见上）。
- **`denyAll.*` 兜底法则**：每个动词末尾挂一条无条件拒绝的 `denyAll.<verb>` 法则（`reject.when` 为空），某动词所有法则未授予且无具体拒绝时兜底（状态不变）；散文由 `denialTemplates` 渲染，`deniedBy` 据此标记为 `"denyAll"`。
- **`denialTemplates`**：拒绝理由的世界腔渲染（按 law 模板）；`denyAll` 等终端兜底的理由也经此渲染，不泄漏属性名/实现术语。
- **`systems`**：时间系统注册表，每 tick 按序执行，产出 deltas（火蔓延、燃尽、日程等）。**`reactiveSystems`（GameDef 可选，默认 false）开启后，granted 动作提交后立即按序跑一次 systems**——把火源放入易燃物当场引燃、开箱触发陷阱等"动作→世界响应"的因果链在当回合成立，不依赖显式 wait。reactive 产出并入动作的 StepResult（facts/involved 合并），不重复入日志。
- **`grounding`**：可见实体索引钩子，决定哪些实体进 LLM 序列化；缺省全部可见。**`reach`/`reachReason`（GameDef 可选）是可达性空槽**：`P.reach`/施动工具前提共用的谓词，缺省全可达、无理由——core 不内嵌任何空间模型；容器包含树语义是游戏侧构件 `src/games/space.ts`（`inTreeReach`/`inTreeVisible`/`reachFor`），需要空间语义的游戏自选接入。
- **`messages`**（GameDef 必填）：core 产出的用户可见文案（校验层拒绝、时间流逝等）由游戏注入自有语言；core 不内嵌任何语言，缺省为空、倒逼游戏声明。可达性理由文案（`reachMissing` 等）可选，供游戏侧空间构件注入。
- **`probeScope`**（GameDef 可选）：法则探测域钩子，决定 `sim probe` 枚举动作参数候选时使用的实体集；缺省 = 可见实体 - 玩家 - `space` 标记的场景实体。大实体量游戏可在此裁剪（如只给可交互实体），控制 probe 组合规模与信号质量。
- **禁止词（引擎不感知语言）**：通用泄漏检查只禁止与语言无关的实现工件——结构化形态（JSON 键值对、声明头 `[facts:` 复现）与「实现形状」的标识符（实体 id / 属性名中非纯小写单词者，如 `wooden_box`、`hasItem`、`isBurning`）；纯小写自然词（`box` / `open`）与散文同词，不作禁止。语言相关的词汇约束由游戏声明：`forbiddenTerms`（可选）为游戏自定义实现术语，按词边界匹配进散文即判泄漏。词边界策略：含非 ASCII 的术语用 includes（`\b` 对中文无效），纯 ASCII 用词边界。
- **`props`（属性注册表）**：`{ prop: { type, label?, internal?, stylistic? } }`。`internal: true` 的属性（如 `burnTicks`、`actor` 标记）不进 LLM 序列化 / changes / 表达校验，从源头杜绝泄漏；`label` 是属性世界化说法（拒绝/变更文本用）；`stylistic: true` 标记润饰属性（表达层可文学润饰，如「刻痕斑驳」）。`internalPropsOf(def)` / `stylisticPropsOf(def)` 派生内部/润饰属性集。
- **词表断言扫描器（已移除）**：`GameDef.assertionRules`（弱/强断言词 + 矛盾目标 + `impossibleOnly`）+ `negationWords` / `sentencePunct` / `assertionPunct` 与 core 的 `checkAssertions`/`scanClaims`（词表 + 近邻窗口的子串启发式）全删——研究结论见 §5-10/§5-11：词表 + 近邻窗口对"持有"类语义结构性失效（假阳性重试/回退 + 假阴性漏网），其唯一实证真阳性（被拒动作后声称对象状态改变）已被声明契约的"状态可推导集"收紧结构性覆盖。**一致性由声明契约 + 提交硬墙（法则/不变式）承担，core 不再假设语言、不再假设"词"这一概念。**
- **表达层声明契约（唯一契约 structured，`GameDef.declarationContract` 字段已移除）**：`[facts: ...]` 的拆分/泄漏检查/涉及集推导集中在 `core/declare.ts`（单一来源：`parseDeclaration`/`parseFactIds`/`validateDecl`）。事实必须带实体 id 前缀（`id: 陈述` / `id1,id2: 陈述` / `[id1,id2]: 陈述`），按实体 id 精确集合校验、无名字回退；id 须可见且属本回合**状态可推导集**。接受裸逗号多实体形态（模型自然输出，归一化而非强推括号格式）。prose 契约（`validateDeclAInv`/`matchLongest` 名字子串）已移除（§5-10/§5-11）。
- **`summarize`**：确定性回退摘要钩子（游戏腔调、可读），缺省用引擎的通用 JSON 序列化。
- **`digest`**：序列化投影钩子（GameDef 可选），决定状态以什么形态进映射/表达 prompt；缺省 = `serialize()` 全量 JSON。游戏可裁剪冗余字段、格式化关系边、聚焦点置顶，以控制 prompt 体积。
- **`deniedBy: "rule" | "denyAll"`**：否决来源语义标记；`sim probe` 依此报告规则缺口，不依赖理由字符串匹配。
- **焦点与拒绝痕迹**：`Simulation` 确定性维护 `world.focus`（本回合动作/新见/被拒实体，跨回合指代锚点）与 `world.traces`（实体 id → 累计被拒次数，拒绝痕迹）。二者进序列化，映射 prompt 注入 `[焦点]` 提示（「它/那个」优先指向 focus，但以玩家显式提到的实体为准）。
- **关系边表**：`world.relations` 为 `{ from, to, type, value }` 边表，表达社会/叙事状态（信任、记忆、派系）。法则以 `relSet/relInc/relDel` 变更，核心提供 `relVal/relAll` 查询。变更在表达层格式化为「from 对 to 的 type」的世界腔文本，快照/克隆/序列化完整保留。
- **refusal 契约**：act 工具 `refusal` 只含 `label`。**理由一律由规则层产出，模型不撰写拒绝理由**：模型直接提交 action 由规则层裁决（否认 → 规则 denyReason，授予 → 执行）；纯拒绝（label）进审计，表达层自然回应。`refusal.considered`（模型预判被拒的动作交规则裁决以纠正误判）为**未实现的未来优化**。`sim probe` 可把 refusal 标签纳入覆盖报告。
- **`--game` / 游戏注册表**：`src/games/registry.ts` 按 id 解析 GameDef，`loop`/`sim` 工具均已参数化，不再硬编码游戏 id。**tool 层不提供隐藏默认值**：`loop start` / `sim run` / `sim probe` 必须显式 `--game`；`sim scenario` 必须显式场景文件路径（场景文件内声明 `game`）；`loop` 各命令必须显式 `--run`。`sim verify` 自动发现并运行 `scenarios/` 下全部场景（跳过未注册游戏，归档场景保留作参考）。`loop` 的引擎配置环境变量按游戏 id 命名空间读取：`<GAME>_PROVIDER` / `<GAME>_MODEL` / `<GAME>_THINKING`（如 `WASTE_PROVIDER`），多游戏并存互不覆盖。
- **引擎保留伪动词 `TICK_VERB`**：`"tick"` 是引擎级时间流逝动作标识（`systems` 产出的 StepResult 与 `loop wait` 用），非游戏声明的动词；游戏不应声明同名动词。`sim run` 的 `tick N` 关键字在游戏声明同名动词时优先走游戏动词。
- **游戏挂载点**：`hint`（世界法则提示注入映射系统提示）、`props`（属性注册表：type/label/internal/stylistic）。
- **`invariants`（GameDef 可选）**：提交后不变式硬墙——core 默认恒挂引用完整性（`integrityInvariant`：实体 id 唯一、id 型属性/关系端点/焦点指向存在的实体），游戏可追加领域不变式（如「燃着必须明火」）。**违反即回滚整个提交并原子拒绝**（`commitChecked` 快照→提交→校验→回滚），法则、系统 bug 都无法绕过。**era/DoL 守恒模式**：游戏以 `sumProp`（core 聚合助手）声明「聚合值 == 种子值」的不变式（如 village 的 `coins.conserved`：铜币总量 == 初始世界总量），凭空铸币/灭币一律被回滚。
- **core 只提供通用工具，不耦合游戏**：状态化 rng 已移除——随机由 games 层以 World 状态自持（纯函数派生），`World` 即完整真相源，check/apply/dryTick/存档/恢复天然一致，无隐藏变量。core 提供的通用原语：`hashStr`（确定性哈希）、`roll`（确定性骰子，`hashStr(time#key)` 派生 [1,sides]，key 需同 tick 唯一——现为 Expr 节点 `{k:"roll",key,sides}`，法则 `when/each` 可直接引用，check/apply/dryTick 天然一致）、`sumProp`（聚合助手，守恒不变式用）、`reach`/`reachReason`（可达性空槽，空间构件由游戏自选，如 `src/games/space.ts`）、`integrityInvariant`（引用完整性硬墙）。Expr 提供 `binop(+,-,*,/,%)`（era 数值表）与 `time`（`world.time` 读取，时段调度）节点；var 解析回退（`env[name] ?? (实体id ? name : null)`）让常量实体可直接写 `E.p("flour","in")`。多时间尺度（回合/日/月）由游戏自持（`world.day` 等计数器 + systems `when`），core 不内置历法。

## 3. 持久化边界

模拟层状态是 JSON 可序列化的，SQLite 不存热状态，存存档与审计（**目标**；原型期由 `loop` 的 `runs/` 目录以 JSONL + `state.json` 落盘，SQLite 落地后迁移）：

| 表 | 内容 |
|---|---|
| `games` | 游戏实例：id、状态机类型、创建时间、状态快照(JSON)、存档 |
| `messages` | 回合历史：用户操作、映射结果、表达层输出（回放/审计） |
| `sessions` | pi SDK 会话索引（SDK 自己写 JSONL，这里只存元数据 + 映射关系） |

## 4. 待确认的开放问题

1. **SQLite 驱动**：优先 `node:sqlite`（Node 22.5+ 内置、零原生编译、零 rebuild），需实测 API 是否够用（同步 API、参数化、事务）。不够再退 `better-sqlite3`（原生模块，需 electron-rebuild 对齐 ABI）。
2. **Electron + ESM 的坑**：pi SDK 是 ESM（`"type": "module"`），Electron 主进程 ESM 支持已成熟，但 preload 脚本必须是 CJS 或需特殊处理。待脚手架验证。
3. **模拟层（已定）**：动作空间为游戏声明动词表（`verbs`），不再硬编码 apply/move/set；era 类社会性动作可声明为新动词。数据结构 `Law → LawResult → Delta`、只读裁决 `check()`（`apply` 的裁决/提交拆分，动作空间接地与探测共用）、法则完整性检查工具 `sim probe`（按 `deniedBy === "denyAll"` 报**有意义**缺口：实体持有该属性、非空操作、值类型匹配）均已落地（§2.5）。probe 的缺口分组按 `def.verbs` 动态生成（不再硬编码 use/move/set），组合预算由 `--max` 控制（缺省 10000，按动词均分，超出报 truncated）或经 `probeScope` 收窄候选域。**新增 `latent` 审计**：对 `instrumentParams` 拦截的动作，用 `probeGrant()`（只读、跳过工具前提）探测「法则本身是否会在不可持握工具上授予」，报告作者漏声明前提的潜在洞（如"用搬不动的重物施力仍被法则授予"即由此发现）。probe 盲区：仅覆盖已声明 `instrumentParams` 的动词，未声明者需作者自查 laws。
4. **解析与忠实性**：
   - **已落地**：双 pass 分离；表达层后置校验器（通用泄漏检查只禁语言无关的实现工件——JSON 结构形态 + 实现形状标识符，语言相关词汇约束由 `forbiddenTerms` 承担 + `props` 注册表的 internal 标记隔离）；结构化声明契约（唯一契约）——输出首行 `[facts: ...]`，校验"声明 id ⊆ 本回合状态可推导集（actor + 法则 facts + 本回合新见 + 变更(from/to)/即将发生 + 授予动作参数；被拒动作参数不在内——被拒动作未改变任何状态）"；`Simulation.dryTick()`（克隆世界）把「即将发生」作为合法预言注入 prompt——**引擎无状态化随机**：随机由 games 层以 World 状态自持（纯函数派生，如 `hashStr(world 计数器)`），世界即完整真相源，dryTick 克隆世界即完整预言，与真实 tick 天然一致，无需序列快照机制。声明校验是集合成员判断（可靠）；散文正文无词表扫描器（§5-11），只受泄漏检查约束、自由表达。
   - **预言/已发生区分（已落地）**：`pending`（即将发生的变更）进声明校验的 touched 集与表达 prompt 的「即将发生」区——预言实体（如「将燃」的容器）可被合法声明，叙述为征兆不算幻觉。原 `checkAssertions` 的 pending 豁免逻辑（weak/strong 断言词区分）随扫描器一并移除（§5-11）。
   - **未实现**：散文正文与声明的一致性（声明外暗含新事实无法机器拦截，属 NLP 难题）；规则 `facts` 的自动校验。
5. **跨回合指代（已落地）**：`world.focus` 确定性维护（动作/新见/被拒实体），映射 prompt 注入 `[焦点]`。实测：无回流上下文下，「打开容器 → 把里面的东西拿起来」正确解析到新见物品；「把它关上」被动词约束（物品不可 open）正确回落容器。**但 focus 只是优先候选而非硬绑定**，多实体歧义场景仍可能失败；上下文可裁剪仍未落地（session 依赖回流与 focus 共同工作）。

## 5. 研究与验证经验

1. **模型环境开箱即用，不用配密钥。** 引擎默认 provider/model（`opencode-go` / `deepseek-v4-flash`），`loop start/act` 直接跑。`<GAME>_PROVIDER` 等环境变量只是可选覆盖，研究阶段不需要纠结模型配置，跳过它直接开始跑端到端。
2. **端到端 `loop` 才是有效验证，`sim` 只验证确定性裁决。** `sim scenario` 断言"能授予/能拒绝 + 状态正确"，但真实质量（自由文本意图能否被映射到正确动词、表达层能否零幻觉叙述）只有 `loop` 能测。**sim 全绿 ≠ 可用**；验证新机制必须跑 loop。
3. **LLM 有随机性，单次 e2e 结果带噪声。** 同一意图两次跑可能映射到不同动词（do/use/move），且同一会话内世界状态会级联（前一步点燃了柴 → 下一步"泼湿"被不变式回滚）。做机制对比要控制变量：**同世界、同开局、同意图集、每组独立开局**；跨回合级联导致的差异不要误判为机制差异。
4. **模型合规率是经验量，合成套件推断不可靠** 凡"模型会不会照格式输出"的问题必须 e2e 测，合成套件只测机制正确性（正确/错误分类）。**样本 = 1 游戏 40 act**：结构化契约在 rel 密集/多实体场景的 id 枚举可能退化，跨游戏验证前不翻转默认。
5. **映射层会拆解复合意图，掩盖"菜单"缺陷。** v2 的精确匹配（proven/openLaws）在单动作 e2e 上与 soft 几乎等价（AI 把复合意图拆成多条动作各自命中）；v3 判别实验再次验证此规律：软通道与实体不可知法则 e2e 36/36 等价（§5-8），差异藏在**授予理由一致性**（soft 2/4 run 退化"……"）、**实现审阅**（malformed op 静默假授予）与**作者负担行数**里。**e2e 成功率高不等于设计好。**
6. **映射层会产出非法形状——但消灭 LLM 形态数据入口比归一化更彻底。** v2 实测 AI 把 `proof.claims[].e` 写成裸 id 字符串或 `{k:"prop"}` 非法 claim，首个 tool call 失败后自我纠正，曾加 `normalizeProof`（裸 id 裹成 `{k:"lit",v}`）兜底；v3 移除软通道后，动作参数全部是 schema 校验的普通动词参数，`normalizeProof`/`wrapClaimExpr` 整类归一化随之消失。凡"模型可能产生、但多数时候能自我纠正"的形态：要么归一化，要么**从源头不引入该形态**（优先）。
7. **自由度提升后，语义一致性责任转移到领域不变式。** v2 软通道允许 AI 直接写软属性后，端到端立刻出现"湿柴在燃烧"的洞（soft 把燃着的柴写成 damp=true），一条声明式不变式（湿柴不得燃烧）即原子回滚；v3 移除软通道后此洞从源头消失（环境响应走法则，结构性属性只能由法则/系统变更），不变式仍是作者法则 bug 与系统 bug 的最终兜底。**开放世界极的"一致" = 一小撮领域不变式，不是法则网络穷举**——这是约束化重量模型成立的前提。
8. **软通道（AI 提后果）是作者负担优化，不是输出质量机制——e2e 等价已被证明。** 对 waste 构建 no-soft 变体（`marked`/`examined` 从 `access:"soft"` 迁为 `mark`/`examine` 动词，实体不可知法则按 `reach` 授予），9 意图 × 2 变体 × 2 独立开局共 36 次 act：**36/36 全部 applied、首次工具调用即成功、最终状态完全一致**。结论：可写面由属性注册表决定，软通道不增加它；"组合免费"的宣称与实体不可知法则等价（1 法则/属性即覆盖全部实体，无 2^N 组合面）。软通道唯一真实收益是作者负担（每可写属性 1 个 access 标记 vs 1 动词 + 1 法则）与工具表面（恒 1 动词 `do`），仅在属性多（几十个环境响应）时才有意义——当前两游戏（village 0 个、waste 2 个软属性）不构成该场景，且该场景的正解是 §5-10 的最小原语而非 fallback 通道。
9. **软通道的产出质量结构性地更差，且藏有静默假授予 bug（已确定性复现）。** (a) **授予理由退化**：`softAdjudicate` 成功分支从不产 reason，授予理由永远 = 模型 `proof.reason` ?? `"……"`——e2e 中 2/4 run 退化"……"，声明式法则的 `reason` 是确定性的。(b) **静默假授予**：proof 在 tool 边界无 schema 校验（只校验 `action.params`），`op` 写成 `"Set"`/`"increment"`/`"SET"` 时绕过 `softAdjudicate` 全部 op 与类型校验，`ok=true` 且零变更、零错误——世界说成功而状态未变，正是引擎要消灭的幻觉反而由机制注入。(c) **`soft.fail` 拒绝理由泄漏 debug**（含裸属性名）到玩家文案，是潜伏地雷（模型偏好结构化拒绝而未触发）。根因统一：LLM 形态的 `Proof` 是第二套不受 schema 约束的数据入口。
**与既有原则的一致性。** DESIGN §1「AI 不产生系统后果」与软通道（AI 直接提 desired deltas 并被提交）长期矛盾；移除后此矛盾消除——后果只能由法则/系统产出，经提交硬墙（引用完整性 + 领域不变式）原子裁决。era/DoL 极与开放世界极由此**共用同一套机制**（动词表 + 法则 + 不变式），重量差异只来自游戏声明的法则与不变式，不来自 core 的原语集合。
10. **表达层忠实性校验的"假阳性"比"假阴性"更伤产品——持有断言是实证的唯一实时失败源，且是"子串匹配不可维护"的实证。** 盘点 83 回合存档 + 实时 e2e（waste，24+40 act）：验证失败集中在持有断言（握着/拿着/手中）；声明名字子串匹配 0 次触发。持有断言 R0 双向漏：(a) **假阳性**——可达可持握物品的文学叙述（「手中的火把依旧握着你掌心里的光」）被拦，触发重试甚至回退干瘪摘要；(b) **假阴性**——「拿起」不在词表、"握着火堆"（不可持握物）反因 targets 只含 grabbable 而不拦。**词表 + 近邻窗口的子串启发式对"持有"语义结构性失效**。中间态正解曾是 `impossibleOnly` 收窄为只拦"不可能持有"（不可握或不可达）并把策略下沉为游戏声明（waste 宽松、village 严格），不硬编码进 core——「最小原语」的方向。**最终处置（§5-11）**：该扫描器连同 `impossibleOnly` 整体移除，由声明契约（新事实 ⊆ 状态可推导集）+ 提交硬墙取代。
11. **structured-only 声明契约取代 prose + 词表断言扫描器——e2e 净胜，且确定性复现了"子串匹配不可维护"的最终结局。** 对比实验（waste/village × baseline(prose + assertionRules) / structured(唯一契约、无扫描器) × 每组独立开局 × 基础 + 压力意图集，全样本 200+ act，修复后复跑两组样本验证）：
    - **最坏失败（摘要回退）baseline 3 vs structured 1**；重试相当；structured 平均叙述长度不降反升。结构性差异在失败归因：
      (a) **baseline 的 2/3 回退源于 prose 契约的名字子串假阳性**——village `fix`（无实体参数）回合 touched 集不含此前回合拿起、本回合真实使用的「木料」，模型声明「你用木料加固了井壁」被 `matchLongest` 命中判为"提及未涉及实体"，重写两次仍撞 → 干瘪摘要。这是 §5-10 预言的子串方案结构性失效在声明层的确定性复现，且它发生在 core 声明层而非 games 层。
      (b) **断言扫描器 200+ act 仅触发 1 次**（被拒动作后模型声称陶罐燃起）——是真阳性，但即便抓对也把体验降级为干瘪摘要；其假阳性模式（文学持有散文）§5-10 已确定性记录。
      (c) **structured 的失败全是模型格式不合规**（漏 id 前缀 / 裸逗号多实体不带括号）——修复为接受 `id1,id2:` 裸逗号归一化后，rel 密集场景的格式重试归零（village/structured 最终 0 重试 / 0 回退）。
    - **结论**：**"散文正文的一致性"由声明契约（新事实 ⊆ 状态可推导集）+ 提交硬墙（法则/不变式原子回滚）承担；词表 + 近邻窗口的子串启发式整体移除。** core 不再感知语言、不再假设"词"这一概念。`assertionRules`/`negationWords`/`sentencePunct`/`assertionPunct`/`declarationContract` 五个 GameDef 钩子删除，`util.ts` 只剩纯函数原语（`hashStr`/`sumProp`/`roll`）。
    - **一致性责任的正确归属**：era/DoL 极的"强一致"来自法则 + 不变式 + 原子回滚（模拟侧），不来自叙述校验器；叙述侧只需"新事实 ⊆ 状态可推导集"这一条语言无关边界。扫描器的实证价值是 1/200+ act，代价是语言词表维护、假阳性重试与干瘪摘要——**删除冗余守卫是可测量的优化**。
    - **"正文暗含新事实"的机器拦截仍是未解 NLP 难题**（§4-4 未实现项），但实证表明：声明契约 + 提示约束下模型正样本不越界；比维护一个必然漏检又误报的词表更划算。