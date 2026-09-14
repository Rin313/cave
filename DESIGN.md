# 引擎设计

## 目的

一个引擎实例定义一个状态机。AI 把多模态输入尝试映射为状态机的输入；AI 基于状态机的输出与当前实例的状态作出多模态输出。可存档，事件可重放。现阶段只做文本输入与文本输出。

## 记号与契约

### 值

```
Scalar ::= String | Num | Bool
Seq    ::= Scalar | Scalar · Seq
V      ::= one(Scalar) | many(Seq)
V?     ::= some(V) | none
Token  ::= String⁺
-- Num ::= 有限实数，排除 NaN/±∞
```

### 世界

```
World  ::= (t, E, Rel)       -- t ∈ ℕ：派生坐标，非内容；E, Rel 是内容
Entity ::= (id, props)       -- id ∈ String⁺，props : K ⇀ V
Edge   ::= (a, b, τ, v)      -- a, b 为实体 id，τ ∈ String⁺，v ∈ V；身份 (a, b, τ) 在 Rel 内两两相异
```

- 存储面无 none：`⇀` 的部分性即缺席——无引用、清空都是键缺席；none 只存在于格的状态表达（δ 的 next 与 𝒞 的 prev/next）。空序列不是值，也不是删除的写法（δ 载荷里的空序列即违约）。
- 值声明 `(type, many?)`：`type ∈ {lit(string), lit(number), lit(boolean), ref}` 是值域与解释的轴——`lit(·)` 即使等于实体 id 也是字面，`ref` 即指称（见下）；`many` 声明重数（缺省 one，true 为非空 `many(Seq)`）。属性的值、边载荷与动词参数共用此轴与同一形状检查（参数与世界值同形）。注册槽（属性/边）在此之上追加 `label`（呈现名：缺席＝该格类缺省（属性无名、边 τ），`null`＝无名（属性上与缺席同效），非空串＝该名）与 ref 生命周期 `strong`（ref 必填）；动词参数追加 `optional` 与 `description`。
- `props`（`GameDef.props?`，可缺席）是属性的部分注册表：属性是状态机的变量表，键是内部标识、不进模型面。注册项按契约检查；未注册键即字面（无契约、无缺省名），词法纪律归作者；闭包（每个属性键都有声明）若要，由作者 invariant 给出。属性名由命名钩子给出（缺省取 `label`）。
- `T` 是边类型注册表键集（`GameDef.relTypes?`，可缺席），注册是部分的：`τ ∈ T` 即获 `SlotDef` 的值声明契约、生命周期与呈现；`τ ∉ T` 即开口 token（值按字面、无契约，恒以 τ 为名）。props 与 relTypes 同制：同一声明类型与契约检查，注册即契约，未注册即字面 token；呈现不得进入裁决（不在提交期补查）。自环 `(e,e,τ,v)` 在格代数上是一元格，按变量用时须接受边的语义（开命名空间、弱端点）。
- 命名只有一个钩子 `name : World × (格 → Token?) → (格 → Token?)`：第二参数是注册表缺省实现（顶点缺省 `id`，属性、边缺省 `label`）；声明 `name` 即接管总函数，可原样委托或缺省覆盖。无名即不进结构化呈现；名字不参与指称（指称恒为 id），故不要求位置内唯一——卡以 `(名, 值)` 序列承载，同名不构成机械歧义。
- 指称：`ref` 可注册在属性与边载荷上，值即实体 id（须在世）。指称门只辖指称参数的入口：动词的 `ref` 参数在提交期问 `∈ Ref(w⁻)?`；存储载荷不过门（秘密引用可表达），其披露由投影按 H 闭合。生命周期按注册表 `strong` 在注册处显式声明——`strong: true` 强（无引用即键缺席，悬空由 integrity 拒绝），`strong: false` 弱（随目标删除级联移除引用，值空即删格/删边）。边端点是弱引用（端点在世由提交审查把门，despawn 级联删边）；端点与载荷 ref 都不进格子身份。需要关系自身身份与生灭时才 reify（把关系提升为实体）；reify 是建模手段，不是第三种引用。属性是一元格 `(e,k)`、边是二元格 `(a,b,τ)`，值轴共用：事实同一性不含目标、值作状态变量/有序多值/无载荷时用 `ref` 属性；多目标、集合语义、有载荷、需按对披露与命名时用边；平行边与关系生灭用 reify。`ref` 的值在数据与状态视图中恒为 id（指称句柄），事件行与尝试行对指称取脸。
- 无名的格不进状态视图、事件投影与近况（缺省实现下即 `label` 缺席或为 `null` 的属性、`label: null` 的注册边）；常驻规则（`GameDef.ticks?`）不进动词面、不携参数与价格，由泵逐刻以空参 Q 过同一扇门。
- 名字可随知识（视角）变化，故「不认得的名字」「无名者」是 token 的取值，不是第二条披露轴；改名不是格——一步内顶点 token 变化即派生出 `~ 旧 → 新`，两边界皆在 H 内才有名可换。

### 变更与门

```
格 ::= ⟨e⟩(顶点) | ⟨e,k⟩(属性) | ⟨a,b,τ⟩(边)     -- 写与记录的共同坐标
δ  ::= set(e,k,v) | relSet(a,b,τ,v) | spawn(ê) | despawn(e)       v ∈ V?
𝒞  ::= (格, 前态, 后态)                        -- δ 是缺前态的写，记录是补全前态的 δ
```

- 格的身份：顶点即 id，属性/边即 (实体,键)/(端点,类型)；`spawn(ê)` 的格即 ê 的顶点格，`despawn(e)` 的格即 ⟨e⟩，`set/relSet` 是属性格/边格×后态的糖。顶点格只有生（⊥→ê）与灭（ê→⊥），不存在实体的替换；顶点记录恰一侧为 ⊥，`id = id(next ?? prev)`。属性/边记录前后态相异（⊥ 即缺席）。
- `set/relSet` 绝对写，写 none 即删。幂等跳过与同址多写后者覆盖限于 `set/relSet`：后态已成立即跳过（无边可删、无键可清的清除写是空操作）。顶点写不跳过：重复 spawn（已在世）与缺世 despawn 是作者违约，拒绝而非覆盖。
- despawn 级联：端点边必删；弱引用载荷移除亡者引用（many 值滤去亡者，空即删格/删边）。级联是提交期推导，逐条入账且紧随 despawn 记录；强引用不清扫，悬空由 integrity 拒绝。

```
wₙ = w₀ ⊕ C₁ ⊕ … ⊕ Cₙ
```

```
G : Δ* × ⟨rule⟩ → 𝒞 ⊎ Denial                原子：拒绝 ⇒ 不产出 𝒞（E、Rel 不变）；t 与刻后果由泵另计
Point ::= rule(⟨law⟩)                        -- 作者法则否决；law 必填，只被记录与断言消费
        | gate                               -- 指称门准入
        | closure                            -- 全弃权闭合
        | invariant(⟨id⟩, ⟨fault⟩)           -- 作者不变式；受众由 fault 选
        | engine                             -- 引擎自检与崩溃同形；出处与细节在 text
fault ::= rule|gate|closure ↦ world；invariant ↦ 其 fault；engine ↦ engine
lawOf ::= rule ↦ ⟨law⟩；gate ↦ action.invisible；closure ↦ action.unanswered；invariant ↦ "invariant."+id；engine ↦ "engine"
Proposal ::= rule(⟨rule⟩, ⟨trigger⟩, ⟨action⟩) | admit
Reason   ::= world(reply?) | engine(debug)    -- invariant 结果的输入形态
Denial   ::= (Point, ⟨text⟩?)                 -- 受众 engine 时文本必填；world 缺文本按呈现解析（say 与词表缺省，最终 noResponse）
```

- 提交审查先校验后不变式；校验逐条执行，后到的 δ 可引用先到的后果（指向而非读值）。`ctx = (proposal, before, changes)`。

```
ι : (w, ctx) → Reason?
```

- `before` 是提交前读态（回滚锚）；`changes` 是本次提交的全部变更。integrity 恒挂：id 唯一、钟为非负整数、身份非空、存储值 ∈ V、注册项类型契约（值与非空序列按 `type` 声明；注册 `ref` 追加引用在世）、边形状与三元组唯一。游戏不变式追加领域约束。任一违反 ⇒ 整提交回滚并拒绝。
- 受众是 Point 的全函数（见 `fault`）：受众 world 的点以世界腔文本呈现（记录内容直用，其余经 `say` 与词表缺省解析，呈现侧缺省 noResponse），受众 engine 的点必携 debug；debug 只经记录与诊断面（`records`）可读。
- `admit` 是装载终点的零变更审查（当前世界 × 当下法则）：与零变更授予逐字段同形，proposal 是唯一判别；重放不跑 authored 不变式（历史由当时的法则裁判过）；终态必过 admit——装载拒绝即当下世界违反当下法则。

### 裁决

```
verb = (label, description, schema, cost ∈ ℕ, invisible?, rules)    -- 外部动词：唯一调用通道是 act
tick = (id, rules)                                      -- 常驻规则：唯一调用点是 clock（泵每刻空参）
a    = (verb, params)      params : P_verb ⇀ V          -- 一次尝试即一次裁决、一个时价、一个拒绝单位
ref(a) ⊆ P_verb           指称参数键集（P_verb 即该动词的参数键集）
Q    = (world, params, roll)                    -- world 深冻结，params 冻结，越权写即抛
J    : Q → ((Grant ⊎ RuleDenial) × ℕ?) ⊎ ⊥              -- ℕ? 即价覆写 price，两分支同轴；⊥ 即弃权
Grant      ::= (Δ*, ⟨law⟩?, reply?, statements?)
RuleDenial ::= (Point = rule(⟨law⟩), ⟨text⟩?)
```

- 世界腔文本只有两种角色。`reply`（答复）是对本次提案的答复：每步至多一条（结构保证单值；句数属作者纪律），只存在于有提案者的步（act）——授予缺文本渲染裸 ✓，否决缺文本回落 noResponse。`statements`（陈述）是授予许可的 0..n 条世界腔陈述（零变更授予亦可携）。否决只有答复。二者都在变更行判据与指称闭包之外——可显示不在 P 中的名字与无名边的聚合，但不产生指称、不改变 P/Ref、不进指称门；随步逐字入账并冻结，投影不回读世界、不重解析。位置由 (trigger, 果, 角色) 决定：act 的答复内联在尝试行、陈述附随变更块；clock 无答复对象，刻内授予不得携 reply——引擎点否决（与不得延伸时间同制），刻内文本只经 statements；否决仍为失败刻；装载判据同此（clock 步不得携 reply 与非空参数、价恒 0，世界腔文本非空）。
- 卫语句链 `rules`（动词与常驻规则同构）：链上每条守卫携链内唯一 id；首个非 ⊥ 表态即判决，授予可携 `law`（缺省即守卫 id），否决的 `law` 由 `deny` 给定——记录两侧自含 (守卫, law)。全弃权由引擎闭合为 `closure`。指称参数先过指称门（域即可指称集），非指称参数按字面径由法则裁决（引擎不解析）。刻内授予不得携 price（不得延伸时间）——引擎点否决。
- 判定与审查是作者否决的两个时相：判定（`Rule`）在提交前读 `w⁻`，携参数与骰子，可授予变更；审查（`Invariant`）在提交后读 `w⁺`、`before`、`changes` 与 `proposal`（admit 无尝试），不可授予。一切否决同形为 `Denial`：rule → `rule(law)`+world(reply?)，gate → `gate`+world（门文案是词表缺省，由呈现解析），closure → `closure`，invariant → `invariant(id,fault)`+受众文本，engine → `engine`+engine(debug)。门、闭合、自检与作者否决共享同一记录形状与回滚路径，但不能是作者的具名否决点。判定与审查中的作者抛出同归 engine 点，出处与细节在 text。

```
roll(addr, key, sides) = 1 + ⌊h(addr, key) · sides⌋      h : 确定性哈希 → [0,1)
```

- 骰子地址 `addr = (at, trigger, verb, 序位)`——入账表态的账本位置；序位 = 同 (at, trigger, verb) 的已入账表态数（本步之前）。地址对入账表态单射且由账本前缀唯一确定。默（时钟全弃权与空授予）不入账、不消耗序位；若其调用 roll，取「若入账则应有」的位置。地址不入 params：自由文本入地址会让输入左右随机；同地址恒同值；sides 违约即抛。

### 步

```
Commit ::= (at, trigger, action, price, 果)
trigger ∈ { act, clock }              -- 入账通道；调用点的标记，作者不可传
action ::= (verb, params)             -- 公共载荷；clock 的 params 恒空
price  =  trigger = clock ? 0 : (price ?? cost)          -- 括号内即裁决价覆写（缺省 cost）；表态处定死，审查与否决不重算
果     ::= granted(guard, law, changes, reply?, statements?) | denied(guard?, Denial)
```

- 入账内容：凡裁决时读出且不可由账本前缀回算者随步入账（钟步的拍坐标是内容：静默刻不留步）；坐标与边界值（`seq`、`at`、`price`、`time`、`prev`）一并入账，供渲染与重放消费，引擎不设第二套对账。由 kind 唯一决定的呈现身份不入账（lawOf 产生）；只读派生视图（脸表、sees、言默、近况、span）一律是投影。
- 序列按构造保序，at 为钟坐标。trigger 由调用点给定（act：AI 经动词面；clock：泵逐刻），作者不可传，随步入账——记录自含分类与价格，投影不重跑裁决、不据动词表反推（name/label/messages 等呈现词汇仍取自 def）。动词表与常驻规则表是两套独立的命名空间：`(trigger, id)` 才是规则链的身份，id 只是各自表内的局部名，同名互不相干，引擎不检查跨表唯一。一切步一律携 action（action.verb 即动词或常驻规则 id；clock 的 params 恒空）。果是裁决点：授予记守卫与法则，否决记 Point 与受众；链上规则表态（或授予被审查拒绝）时守卫随果入账（gate/closure 无守卫），授予轨迹不入账。
- 提交存在判据：变更 ∨ 答复 ∨ 陈述 ∨ 否决 ∨ 应答义务。act 提案恒因应答义务入账（授予无文本以 ✓ 行入账、否决缺文本以 noResponse 兜底）；clock 提案无应答义务，空授予即默、不留空步。步入账即冻结。呈现按 trigger 分流：act 产尝试行（✓/✗ 动词与答复），clock 归 ⏱（授予成块、否决为失败刻、全弃权即默）。

### 视角

视角是 def 钩子，不入账本；它是 `World → Access` 的纯函数，命名与状态视图是呈现面（另收引擎缺省实现作为可委托的 base）：

```
perspective : World → { sees?, refers? }                            -- 可缺席；缺省 sees 常真（全见）、refers 即顶点 sees（披露）
Access      ::= (sees : 格 → Bool, refers : 实体 → Bool)             -- sees：顶点格成员即可见，属性/边格与命名合取为可显示（变更行该侧判据）；refers：指称门的域
name        : World × (格 → Token?) → (格 → Token?)                  -- 格命名；第二参数 = 注册表缺省（顶点 id、属性/边 label）；只被呈现消费
view        : World × ViewBase × Γ → ViewValue                      -- 状态视图：闭合基座上增补；缺省即基座，增补部分不入闭包
Γ           ::= (格命名, sees, present, 可见域, 可指称域, 已知域)  -- 该边界的格视图；脸 = 命名在已知域上的限制（即时求值，不物化）
```

- `Access` 是引擎唯一的访问结构。可见域 `P(w) = { e : sees(⟨e⟩) }`，可指称域 `Ref(w) = { e : refers(e) }`，已知域 `H(w) = P ∪ Ref`：指称门在提交期只问指称参数的值 `∈ Ref(w⁻)?`（存储 ref 只须在世），卡只出在 P 上（可指称而不可见者出句柄，Ref∖P），一切结构化指称用 H 闭合；属性/边格的 `sees` 值决定该格是否可显示。`sees` 缺省常真（全见）、`refers` 缺省即顶点披露；`perspective` 返回未知字段或非函数字段即缺陷。命名是另一条轴：唯一入口是 `name`（`label` 只是其缺省实现的字段）；名字存在性与披露互不代替，消费侧的唯一出口是可显示谓词 `present(w, cell) = name(cell) ≠ ∅ ∧ sees(cell)`（两谓词只是输入轴；顶点名恒在，退化为披露）；`label: null` 即显式无名（属性上与缺席同效，边上覆盖 τ 缺省）。名字不改变指称域（指称恒为 id），故跨位置、同卡同名都不构成机械歧义。
- 结构化呈现须可显示与指称闭合同时成立：卡中属性 `present(⟨e,k⟩)` ∧ `refs(k) ⊆ H`；关系 `present(⟨a,b,τ⟩)` ∧ 端点 ⊆ H ∧ 载荷指称 ⊆ H；变更行每侧可显示 ⇔ `present` 在该侧边界成立，行内一切指称（顶点、端点、主语、被披露侧的值指称）须落在两边界 H 之并内，否则整行不渲染。顶点名在 H 上全（缺省回落 id），故「可指名者必在已知集，已知者必可指名（卡或句柄）」是结构化面的定义与闭合。
- `sees` 对缺席格同样求值：变更行每侧 = 该边界对变更格的谓词值；其值域为 Bool，不改变所指域。谓词读世界真相，不写入、不物化为内容。
- `view` 声明即接管状态视图（全函数，返回任意 ViewValue，含 null），第二参数 `base` 即引擎缺省（已过名字、披露与指称闭包），可原样委托或增补改写；增补部分与 reply/statements/散文在此闭包之外：可显示不在 P 中的名字与无名边的聚合（`Γ` 供命名与域对齐），但不产生指称、不改变 P/Ref、不进指称门；「听说其名但不在场」有两条出口：并入 Ref 即出句柄目录（可指名），只留在纹理则不可指称。

```
Access(w) ::= (sees, refers)
P(w)   ::= { e : sees(⟨e⟩) }
Ref(w) ::= { e : refers(e) }
H(w)   ::= P(w) ∪ Ref(w)
present(w, cell) ::= name(cell) ≠ ∅ ∧ sees(cell)
viewBase(w) = ( t,
                entities  = { card(e) : id(e) ∈ P(w) },
                relations = { (a, b, name(⟨a,b,τ⟩), v) : (a,b,τ,v) ∈ Rel(w) : present(w, ⟨a,b,τ⟩) ∧ {a, b} ⊆ H(w) ∧ 载荷指称 ⊆ H(w) },
                known     = { (id(e), name(⟨e⟩)) : id(e) ∈ Ref(w)∖P(w) } )
view(w) = def.view 缺席 ? viewBase(w) : def.view(w, viewBase(w), Γ(w))
refs(k) ::= k 非指称 ? ∅ : 值的指称集
card(e) = ( id(e), name(⟨e⟩), props = [(name(⟨e,k⟩), v) : k ∈ K : present(w, ⟨e,k⟩) ∧ refs(k) ⊆ H(w)] )   -- 序列承载；ref 值为 id
```

## 协议

**内容与坐标**　`E, Rel` 是内容，门的原子域；`t` 是坐标（派生，非内容），不产 𝒞，写者唯一（落钟循环），谓词照常读钟。钟的每次写入都归因于某个 act 步的生效 price（刻账目），与该步的果无关；耦合律是 `Δ钟 = price`：`t = t₀ + Σ act 步生效 price`（clock 步 price 恒 0），泵在 `(at, at+price]` 内逐刻写钟并运行 clock 步；裁决可选携 price（覆写缺省 cost，授予与否决同轴），入账后由生效 price 承接（覆写不另存）。`step.at` 与回合 `time` 是记录下来的坐标，随裁决构造入账，供投影与阅读；装载按记录重建，不重算。回滚的坐标边界由账目裁定：已入账的刻不可回滚，未入账的刻必须一并回滚。

**判定跨度**　`span(s) = (脸表, 格命名, sees)(w⁻, w⁺)`——尝试提交跨其提交边界，时钟提交跨其拍的提交边界。跨度是投影：`w⁻/w⁺` 由 genesis ⊕ 𝒞 重建（逆推逐变更取 prev），脸表、格命名与 `sees` 由 `name`／`perspective` 对重建世界即时求值；变更行每侧可显示 ⇔ 该边界对变更格 `present`（有名且披露；缺席格与在场格同过一门）；改名行是派生行——一步内两边界顶点 token 变化且实体两端皆在已知域，即出 `~ 旧 → 新`。投影不回读活世界，也不得把呈现随步入账；言默由重建边界重算，恒同——投影只可省略行文，不可重划。

**事件投影**　AI 所得 = `Π(记录, def) ⊕ 可见变更行 ⊕ 世界腔文本（答复、陈述与否决理由）`。近况 `Π` 是记录与 def 的纯函数且不持久化（记录的提交边界由账本末世界逆推重建，脸表、格命名与 `sees` 即时求值，不回读活世界）：作者以 `recent(记录, base)` 选择注入的回合记录（账本序的单调子序列；`base` 即缺省选择＝最后 `recentWindow` 条，`recentWindow` 缺席即全量，可委托；`recent` 与 `recentWindow` 至少必填其一——近况是映射层的跨回合指代锚，长短是游戏的物化纪律，引擎不设静默全量），引擎按与 act 结果相同的变更行判据投影（推论·刻账目闭合）；言默同源重算。act 结果的新见段是同一投影的回合内增量：本回合新进可见域的实体出卡，新进可指称域的实体出句柄。

**内核不持行动主体** 视角是 `World → Access` 的纯函数，主体是游戏的法则约定。

## 面向作者的契约

- **动词表**：`params` 由值声明（type×重数）加可选与描述构成，派生接口模式、内核校验与规则参数的编译期类型；`ref` 值过指称门（域即可指称集）；`many` 令参数为非空序列——一次尝试的操作数是裁决的一部分（指称逐项过门、整次原子），批次是多个尝试在世界态上的顺序 fold；操作数与顺序组合是两根轴，多重性不由批次承载。全表另派生 AI 广告（`verbFace`／`catalog`：id、label、description、cost、逐参数的 type×重数×可选×ref 与过门注记）；`act` 工具描述缺省即协议约束＋该广告，作者经 `prompt.tool` 委托或覆盖。
- **拒绝**：作者的否决是 `Denial` 在 `rule` 点上的特化——`law` 只被记录与断言消费，`text` 是世界腔答复（缺省回落 noResponse），`price` 覆写缺省价；授予侧对称：`grant` 可选携 `law`（缺省守卫 id），两侧记录都自含 (守卫, law)。否决不携带涉及实体——指称落点在 action 参数与法则理由。受众规则见 `fault`。
- **引擎文本**（`Messages` 皆非空；`say` 可接管总函数）：引擎合成读者侧文本的场合是闭集 `Speech`——记录点的 `(point, verb)`（rule/closure/gate/invariant/engine）与边界情形 `noProposal`（空提案、未调 act、零行文）、`interrupted(adjudicate|project)`。解析序：记录文本中受众 world 者直用（`deny` 的 text、invariant 的 reply）；其余经 `say(speech, base)`——`base` 对 gate 先取动词 `invisible`、再取 `invisibleEntity`、最后 `noResponse`，其余场合一律 `noResponse`（受众 engine 点的隐身呈现）。`verb.invisible` 是词表缺省，不进入记录、不越级 say。记录点场合的解析是记录与 def 的纯函数（act 结果与近况恒同）；边界场合不在账本；投影失灵先按 `interrupted(project)` 解析，`say` 失败时直取 `noResponse`。`timePassed` 承载静默刻聚合，不属 `say`；回复/陈述是授予侧的逐次文本，亦不入 `say`。文案只被呈现消费，不参与裁决。

## 非目标

- 多输入源与多视角
- Token消耗审计
- 日志防篡改与坐标对账：装载是重建（形状、序位连续、变更可应用、终态 integrity），不是审计；投影失败是消费事件，降级呈现

## 架构决策

- 进程内集成 pi agent SDK（`node_modules/@earendil-works/pi-coding-agent/docs/`）。
- **上下文裁剪**：每次调用经 `context` 扩展裁剪为最后一条 user 消息起的后缀（工具结果存为独立 toolResult 角色、不并入 user 消息，回合内该锚恒为回合提示，叙述续行因此保住裁决前缀；context 事件的消息是深拷贝）。
- **持久化**：唯一证据是回合记录，近况是其纯函数投影（作者选择×引擎投影），只在装载与回合边界整体重算，进程重启由记录按序重放重建（不重裁决、不掷骰、逐变更 prev 校验，终态过 admit）。档案是单一追加日志（`records.jsonl`），条目是回合与其表达：回合是唯一证据（每回合恰一，定稿写点）；表达紧随其回合、可有可无——表达落定后尝试追加，落盘失败或缺失都不影响回合链，装载不读表达、不参与重放。装载遇序位不接续或变更不可应用即截断至断点前的完好前缀并告警显形（末尾无换行的半行同此）：截断以重写落地——续写前档案重写为存活回合前缀（表达不随重写保留），旧全文移存 `records.jsonl.orphan`，不再进入装载；投影失败是呈现缺陷，在消费时降级，不算装载损坏。
- **缓存稳定性**：[tools+system] 放置于开头，系统提示与工具数组字节级稳定，不做 setActiveTools 相位切换；回合内（act 裁决后的描写续行）前缀 [tools+system+user] 逐字节稳定（近况头并入的 user 消息在回合内不变）。
