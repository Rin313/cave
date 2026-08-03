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
   | 映射层 §4.2 | 一个自定义 tool：`defineTool({ name: "act", ... })`（actions 列表：`{ verb, params }`，schema 从游戏动词表生成），且为 session 里唯一启用的 tool；映射 pass 只产结构化结果 |
   | 表达层 §4.3 | session 的普通文本输出（`text_delta` 流式），在状态变更后的独立 prompt（双 pass），输入 = 当前状态 + changes + 法则 facts |
   | 模拟层 §4.1 | tool 的 `execute()` 内部，确定性规则网络（按动词分组），唯一的游戏状态出口 |
   | 会话/上下文 §9 | AgentSession 自带：messages + compact() + SessionManager；叙述不回流（幻觉不固化） |
   | 拒绝 §4.2 | 结构化拒绝（仅 label）+ `considered` 交规则裁决：理由由规则/denyAll 给出，映射 pass 不产散文 |

3. **"只有两个出口"是这个 SDK 的默认结构。** session 只给一个 tool，模型要么 `act`（提案 actions），要么写文字；`execute()` 内部就是规则裁决边界。
4. **IPC 形态：主进程 → 渲染层是推送（事件流），渲染层 → 主进程是请求（invoke）。** pi SDK 是事件流式的（`text_delta` / `tool_execution_*`），经转发器 `webContents.send()` 推给 Vue。
5. **tool schema 是动作提案**——`act(actions)`，actions 为 `{ verb, params }` 列表；verb 必须取自 `GameDef.verbs`，非法/不可见实体 ID 在 `execute()` 校验层打回，不进入状态机。**无别名表、无关键词匹配、无语言限制**：动词与实体都由 LLM 从自由文本中纯语义解析（`name + attrs + 上下文`），不限制玩家输入语言；动词空间是游戏声明的（不再硬编码 apply/move/set）。

## 2.5 已落地的 GameDef 表面契约

- **`verbs`**：游戏声明的动词表，每个动词含 `schema`（TypeBox，生成 act 工具参数校验）、`entityParams`（哪些参数是实体 id，供可见性校验）、`candidates`（非实体参数的候选值，动作空间接地与探测共用）、`laws`（该动词的声明式法则，按声明顺序短路，首条 granted 生效；末尾可挂 `denyAll.*` 兜底法则）。`propParams`（可选）标记哪些非实体参数是"属性选择器"（取值是实体属性名，如 `set` 的 `prop`）——core 据此做属性标签替换、affordances 按属性相关性排序、probe 的有意义缺口过滤，不再硬编码参数名 `"prop"`。cave 使用 `move/use/set` 三个预设动词 + `do`（开放通道），era/DoL 类可声明 `talk/travel/equip` 等。
- **动作空间接地**：`Simulation.affordances()` 每回合枚举 动词 × 可见实体 × `candidates` 的只读裁决 `check()`，把当前世界会授予的动作注入映射 prompt（预算按动词均分、实体按相关属性排序）。**施动工具参数（`instrumentParams`）在枚举时自动跳过不可持握实体**——固定在地面、搬不动的重物不再出现在施动位。映射层仍可提出动作空间之外的动作，由规则层裁决。
- **`Law`（声明式法则，按动词分组）**：`{ id, open?, over?, when?, each?, denies?, reject?, reason?, facts? }`，解释器 `evaluateLaw` 对动作裁决，产出 `LawResult` = `{ granted, reason, denial: Denial, deltas: Delta[], facts?, involved? }`。数值与后果由法则产出（Delta：`set/inc/push/del`，支持点路径；关系边 `relSet/relInc/relDel`；`spawn/destroy` 仅 tick 系统使用），LLM 不提案数值。时间系统 `GameDef.systems` 同为 `Law[]`（`evaluateSystem` 聚合全部量词匹配）。
- **开放通道（反向解析，`fallback: "proven"`）**：非预设动词不接受 AI 手写 deltas——proof 给 `claims`（前置事实，须为真）+ `desired`（期望后果），`resolveUnscripted` 在开放法则（`Law.open` 标记或 `GameDef.openLaws`）中反查：对每条法则用 desired 解出变量绑定（效果模板形状匹配），forward 求值后若其后果覆盖 desired，**经该法则提交**（级联/不变式/痕迹照常）。未命中落 `denyAll.*`。这是"AI 提后果、世界走法则"的重量机制：无开放法则能产出的后果（凭空改材质、传送不可持握物）一律被拒。`openLawsOf(def)` 汇集 `GameDef.openLaws` + 动词 laws 中 `open:true` 者。
- **`denyAll.*` 兜底法则**：每个动词末尾挂一条无条件拒绝的 `denyAll.<verb>` 法则（`reject.when` 为空），某动词所有法则未授予且无具体拒绝时兜底（状态不变）；散文由 `denialTemplates` 渲染，`deniedBy` 据此标记为 `"denyAll"`。
- **`denialTemplates`**：拒绝理由的世界腔渲染（按 law 模板）；`denyAll` 等终端兜底的理由也经此渲染，不泄漏属性名/实现术语。
- **`systems`**：时间系统注册表，每 tick 按序执行，产出 deltas（火蔓延、燃尽、日程等）。**`reactiveSystems`（GameDef 可选，默认 false）开启后，granted 动作提交后立即按序跑一次 systems**——把火源放入易燃物当场引燃、开箱触发陷阱等"动作→世界响应"的因果链在当回合成立，不依赖显式 wait。reactive 产出并入动作的 StepResult（facts/involved 合并），不重复入日志。
- **`grounding`**：可见实体索引钩子，决定哪些实体进 LLM 序列化；缺省全部可见。容器包含树语义已降为标准库 `inTreeReach/inTreeVisible`，由游戏选择接入。
- **`containerAccess`**（GameDef 可选）：标准库可达性的关容器放行谓词 `(world, container, id) => boolean`——关着的容器是否对实体放行。缺省一律拦截；关容器对特定实体的放行（如楔在门缝里的东西仍够得到）由游戏经此谓词裁决，不进入标准库。
- **`messages`**（GameDef 必填）：core 产出的用户可见文案（校验层拒绝、时间流逝、标准库可达性兜底等）由游戏注入自有语言；core 不内嵌任何语言，缺省为空、倒逼游戏声明。
- **`probeScope`**（GameDef 可选）：法则探测域钩子，决定 `sim probe` 枚举动作参数候选时使用的实体集；缺省 = 可见实体 - 玩家 - `space` 标记的场景实体。大实体量游戏可在此裁剪（如只给可交互实体），控制 probe 组合规模与信号质量。
- **禁止词（引擎不感知语言）**：通用泄漏检查只禁止与语言无关的实现工件——结构化形态（JSON 键值对、声明头 `[facts:` 复现）与「实现形状」的标识符（实体 id / 属性名中非纯小写单词者，如 `wooden_box`、`hasItem`、`isBurning`）；纯小写自然词（`box` / `open`）与散文同词，不作禁止。语言相关的词汇约束由游戏声明：`forbiddenTerms`（可选）为游戏自定义实现术语，按词边界匹配进散文即判泄漏；语义断言由 `assertionRules` 声明式承担。词边界策略：含非 ASCII 的术语用 includes（`\b` 对中文无效），纯 ASCII 用词边界。
- **`props`（属性注册表）**：`{ prop: { type, label?, internal?, stylistic? } }`。`internal: true` 的属性（如 `burnTicks`、`actor` 标记）不进 LLM 序列化 / changes / 表达校验，从源头杜绝泄漏；`label` 是属性世界化说法（拒绝/变更文本用）；`stylistic: true` 标记润饰属性（表达层可文学润饰，如「刻痕斑驳」，不参与断言校验）。`internalPropsOf(def)` / `stylisticPropsOf(def)` 派生内部/润饰属性集。
- **通用断言校验（声明式）**：`GameDef.assertionRules`（`{ prop, weak?, strong?, targets, exemptPending?, error }`）+ `negationWords` / `sentencePunct` / `assertionPunct`（词表/标点由游戏注入，引擎不感知语言）。engine 在泄漏检查后自动执行 `checkAssertions`（core 通用算法）：散文断言了与物理状态相反的事实即报错；weak 断言词豁免"即将发生"（pending）的预言实体，strong 断言词不豁免（如「烧成灰烬」不能因下一 tick 就豁免），`exemptPending: false` 的规则（如「持有」）不接受预言豁免。
- **`summarize`**：确定性回退摘要钩子（游戏腔调、可读），缺省用引擎的通用 JSON 序列化。
- **`digest`**：序列化投影钩子（GameDef 可选），决定状态以什么形态进映射/表达 prompt；缺省 = `serialize()` 全量 JSON。游戏可裁剪冗余字段、格式化关系边、聚焦点置顶，以控制 prompt 体积。
- **`deniedBy: "rule" | "denyAll"`**：否决来源语义标记；`sim probe` 依此报告规则缺口，不依赖理由字符串匹配。
- **焦点与拒绝痕迹**：`Simulation` 确定性维护 `world.focus`（本回合动作/新见/被拒实体，跨回合指代锚点）与 `world.traces`（实体 id → 累计被拒次数，拒绝痕迹）。二者进序列化，映射 prompt 注入 `[焦点]` 提示（「它/那个」优先指向 focus，但以玩家显式提到的实体为准）。
- **关系边表**：`world.relations` 为 `{ from, to, type, value }` 边表，表达社会/叙事状态（信任、记忆、派系）。法则以 `relSet/relInc/relDel` 变更，核心提供 `relVal/relAll` 查询。变更在表达层格式化为「from 对 to 的 type」的世界腔文本，快照/克隆/序列化完整保留。
- **refusal 契约**：act 工具 `refusal` 只含 `label`。**理由一律由规则层产出，模型不撰写拒绝理由**：模型直接提交 action 由规则层裁决（否认 → 规则 denyReason，授予 → 执行）；纯拒绝（label）进审计，表达层自然回应。`refusal.considered`（模型预判被拒的动作交规则裁决以纠正误判）为**未实现的未来优化**。`sim probe` 可把 refusal 标签纳入覆盖报告。
- **`--game` / 游戏注册表**：`src/games/registry.ts` 按 id 解析 GameDef，`loop`/`sim` 工具均已参数化，不再硬编码 cave。**tool 层不提供隐藏默认值**：`loop start` / `sim run` / `sim probe` 必须显式 `--game`；`sim scenario` 必须显式场景文件路径（场景文件内声明 `game`）；`loop` 各命令必须显式 `--run`。`loop` 的引擎配置环境变量按游戏 id 命名空间读取：`<GAME>_PROVIDER` / `<GAME>_MODEL` / `<GAME>_THINKING`（如 `CAVE_PROVIDER`），多游戏并存互不覆盖。
- **引擎保留伪动词 `TICK_VERB`**：`"tick"` 是引擎级时间流逝动作标识（`systems` 产出的 StepResult 与 `loop wait` 用），非游戏声明的动词；游戏不应声明同名动词。`sim run` 的 `tick N` 关键字在游戏声明同名动词时优先走游戏动词。
- **游戏挂载点**：`hint`（世界法则提示注入映射系统提示）、`assertionRules`（通用断言校验规则，词表/标点由游戏声明；weak 断言词按 `pending` 豁免预言）、`props`（属性注册表：type/label/internal/stylistic）。
- **`invariants`（GameDef 可选）**：提交后不变式硬墙——core 默认恒挂引用完整性（`integrityInvariant`：实体 id 唯一、id 型属性/关系端点/焦点指向存在的实体），游戏可追加领域不变式（如「燃着必须明火」）。**违反即回滚整个提交并原子拒绝**（`commitChecked` 快照→提交→校验→回滚），AI 开放通道、法则、系统 bug 都无法绕过。**era/DoL 守恒模式**：游戏以 `sumProp`（core 聚合助手）声明「聚合值 == 种子值」的不变式（如 cave 的 `coins.conserved`：铜币总量 == 初始世界总量），凭空铸币/灭币一律被回滚。
- **core 只提供通用工具，不耦合游戏**：状态化 rng 已移除——随机由 games 层以 World 状态自持（纯函数派生，如 `hashStr(`${world.time}#${luck}#${salt}`)`，计数/推进由游戏经 deltas 声明），`World` 即完整真相源，check/apply/dryTick/存档/恢复天然一致，无隐藏变量。core 提供的通用原语：`hashStr`（确定性哈希）、`roll`（确定性骰子，`hashStr(time#key)` 派生 [1,sides]，key 需同 tick 唯一）、`sumProp`（聚合助手，守恒不变式用）、`scanClaims`（文本断言扫描算法，词表/标点/否定词由游戏注入，core 不感知语言）、`inTreeReach`（标准库可达性，理由经 `reachReason` 表达式注入法则拒绝）、`integrityInvariant`（引用完整性硬墙）。多时间尺度（回合/日/月）由游戏自持（`world.day` 等计数器 + systems `when`），core 不内置历法。

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
   - **已落地**：双 pass 分离；表达层后置校验器（叙述实体 ⊆ 可见实体；通用泄漏检查只禁语言无关的实现工件——JSON 结构形态 + 实现形状标识符，语言相关词汇约束由 `forbiddenTerms` 承担 + `props` 注册表的 internal 标记隔离 + `assertionRules` 语义断言）；结构化声明契约——输出首行 `[facts: ...]`，校验"声明实体 ⊆ 本回合涉及集（动作主体/动作参数/拒绝理由实体/本回合新见）+ 变更(from/to)/法则事实/即将发生"；`Simulation.dryTick()`（克隆世界）把「即将发生」作为合法预言注入 prompt——**引擎无状态化随机**：随机由 games 层以 World 状态自持（纯函数派生，如 `hashStr(world 计数器)`），世界即完整真相源，dryTick 克隆世界即完整预言，与真实 tick 天然一致，无需序列快照机制。声明校验是集合成员判断（可靠），散文语义靠 `assertionRules` 声明式词表（警报器）。
   - **预言/已发生区分（已落地）**：`checkAssertions` 收到 `pending`（即将发生的变更），据此豁免"即将发生"实体上的 weak 断言（如「将燃」），strong 断言（如「已成灰烬」）仍严格——把火源放入易燃容器后「容器将燃」不再被当幻觉误伤。实测：改前该场景触发 2 次校验失败并退回摘要，改后零误伤。
   - **未实现**：散文正文与声明的一致性（声明外暗含新事实无法机器拦截，属 NLP 难题）；规则 `facts` 的自动校验。
5. **跨回合指代（已落地）**：`world.focus` 确定性维护（动作/新见/被拒实体），映射 prompt 注入 `[焦点]`。实测：无回流上下文下，「打开容器 → 把里面的东西拿起来」正确解析到新见物品；「把它关上」被动词约束（物品不可 open）正确回落容器。**但 focus 只是优先候选而非硬绑定**，多实体歧义场景仍可能失败；上下文可裁剪仍未落地（session 依赖回流与 focus 共同工作）。
