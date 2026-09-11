# 引擎设计

## 目的

一个引擎实例定义一个状态机。AI 把多模态输入尝试映射为状态机的输入；AI 基于状态机的输出与当前实例的状态作出多模态输出。存档可恢复，事件可重放。现阶段只做文本输入与文本输出。

## 记号与契约

### 值

```
Scalar ::= String | Num | Bool
Seq    ::= Scalar · Seq
V      ::= one(Scalar) | many(Seq)
V?     ::= some(V) | none
-- Num ::= 有限实数，排除 NaN/±∞
```

### 世界

```
World  ::= (t, E, R)         -- t ∈ ℕ：派生坐标，非内容；E, R 是内容
Entity ::= (id, props)       -- id ∈ String⁺，props : K ⇀ V
Edge   ::= (a, b, τ, v)      -- a, b 为实体 id，τ ∈ String⁺，v ∈ V；身份 (a, b, τ) 在 R 内两两相异
```

- 存储面无 none：`⇀` 的部分性即缺席——无引用、清空都是键缺席；none 只存在于格的状态表达（δ 的 next 与 𝒞 的 prev/next）。空序列不是值，也不是删除的写法（δ 载荷里的空序列即违约）。
- `K` 是属性注册表键集，`κ : K → PropDef`，`PropDef = (type, many?, label?)`：`type ∈ {lit(string), lit(number), lit(boolean), ref}` 是值域与解释的轴——`ref` 的值即实体 id（须在世、过指称门），`lit(·)` 即使等于实体 id 也是字面；`many` 声明重数（缺省 one，true 为非空 `many(Seq)`）。`props` 必填（K 是 κ 的全定义域），词汇闭合 `keys(e.props) ⊆ K`；属性是状态机的变量表，键是内部标识，不进模型面；属性名由命名钩子给出（缺省取 `label`，无 label 即无名）。
- `T` 是边类型注册表键集（`GameDef.relTypes?`，可缺席），注册是部分的：`τ ∈ T` 即获 `(type, many?, present?, strong?)` 的值域契约、生命周期与呈现，`type ∈ {lit(string), lit(number), lit(boolean), ref}`；`ref` 载荷即指称（须在世、过指称门），缺省弱引用（随目标删除级联删边），`strong: true` 即强引用（悬空由 integrity 拒绝）。`present` 三态：缺席即 token（τ 即公开呈现名），`"hidden"` 即无呈现名，`{ label }` 即改名（label 须非空）。`τ ∉ T` 即开口 token（值按字面、无契约、无静态隐藏）。K 闭、T 开：闭者可全量枚举类型契约与缺席格求值；开者由世界生成，未注册 token 无法在 def 期穷举，呈现也不得进入裁决（不在提交期补查），其词法纪律归作者。自环 `(e,e,τ,v)` 在格代数上是一元格，按变量用时须接受边的语义（开命名空间、弱端点）。
- 命名只有一个钩子 `name : World × Player × (格 → Token?) → (格 → Token?)`：第三参数是注册表缺省实现（顶点缺省 `id`，属性缺省 `label`，边缺省 `present` 派生）；声明 `name` 即接管总函数，可原样委托或缺省覆盖。无名即不进结构化呈现；名字不参与指称（指称恒为 id），故不要求位置内唯一——卡以 `(名, 值)` 序列承载，同名不构成机械歧义。
- 指称：`ref` 可注册在属性与边载荷上，值即实体 id（须在世、过指称门）；属性 ref 是强引用（无引用即键缺席），边 ref 载荷按 `strong` 声明（缺省弱：随目标删除级联删边）。边端点是弱引用（端点在世由提交审查把门，despawn 级联删边）；端点与载荷 ref 都不进格子身份。需要关系自身身份与生灭时才 reify（把关系提升为实体）；reify 是建模手段，不是第三种引用。`ref` 的值在数据与状态视图中恒为 id（指称句柄），事件行与尝试行对指称取脸。
- 无名的格不进状态视图、事件投影与近况（缺省实现下即无 label 的属性与 `present: "hidden"` 的注册边）；常驻规则（`GameDef.ticks?`）不进动词面、不携参数与价格，由泵逐刻以空参 Q 过同一扇门。
- 名字可随观察者知识变化，故「不认得的名字」「无名者」是 token 的取值，不是第二条披露轴；改名不是格——一步内顶点 token 变化即派生出 `~ 旧 → 新`，两边界皆在 H 内才有名可换。

### 变更与门

```
格 ::= ⟨e⟩(顶点) | ⟨e,k⟩(属性) | ⟨a,b,τ⟩(边)     -- 写与记录的共同坐标
δ  ::= set(e,k,v) | relSet(a,b,τ,v) | spawn(ê) | despawn(e)       v ∈ V?
𝒞  ::= (格, 前态, 后态)                        -- δ 是缺前态的写，记录是补全前态的 δ
```

- 格的身份：顶点即 id，属性/边即 (实体,键)/(端点,类型)；`spawn(ê)` 的格即 ê 的顶点格，`despawn(e)` 的格即 ⟨e⟩，`set/relSet` 是属性格/边格×后态的糖。顶点格只有生（⊥→ê）与灭（ê→⊥），不存在实体的替换；顶点记录恰一侧为 ⊥，`id = id(next ?? prev)`。属性/边记录前后态相异（⊥ 即缺席）。
- `set/relSet` 绝对写，写 none 即删。幂等跳过与同址多写后者覆盖限于 `set/relSet`：后态已成立即跳过（无边可删、无键可清的清除写是空操作）。顶点写不跳过：重复 spawn（已在世）与缺世 despawn 是作者违约，拒绝而非覆盖。
- despawn 级联删边，逐条入账且紧随 despawn 记录（弱引用随实体删除）；强引用不清扫，悬空由 integrity 拒绝。

```
wₙ = w₀ ⊕ C₁ ⊕ … ⊕ Cₙ
```

```
G : Δ* × ⟨rule⟩ → 𝒞 ⊎ Denial                原子：拒绝 ⇒ w 不变
Point ::= rule(⟨law⟩)                        -- 作者法则否决；law 必填，只被呈现与探针消费
        | gate                               -- 感知准入
        | closure                            -- 全弃权闭合
        | invariant(⟨id⟩, ⟨fault⟩)           -- 作者不变式；受众由 fault 选
        | engine(⟨check⟩)                    -- 引擎自检：integrity | commit | grant
        | crash(⟨site⟩)                      -- 崩溃：rule | invariant
fault ::= rule|gate|closure ↦ world；invariant ↦ 其 fault；engine|crash ↦ engine
lawOf ::= rule ↦ ⟨law⟩；gate ↦ action.invisible；closure ↦ action.unanswered；invariant ↦ "invariant."+id；engine ↦ "engine."+check；crash ↦ site+".crash"
Proposal ::= rule(⟨rule⟩, ⟨origin⟩, ⟨action⟩) | admit
Reason   ::= world(reply?) | engine(debug)    -- invariant 结果的输入形态
Denial   ::= (Point, ⟨text⟩?)                 -- 受众 engine 时文本必填；world 缺文本回落 noResponse
```

- 提交审查先校验后不变式；校验逐条执行，后到的 δ 可引用先到的后果（指向而非读值）。`ctx = (player, proposal, before, changes)`。

```
ι : (w, ctx) → Reason?
```

- `before` 是提交前读态（回滚锚）；`changes` 是本次提交的全部变更。integrity 恒挂：id 唯一、钟为非负整数、锚在世、词汇闭合、身份非空、存储值 ∈ V、类型契约（值与非空序列按 `type` 声明；`ref` 属性追加引用在世；注册边类型同受）、边形状与三元组唯一。游戏不变式追加领域约束。任一违反 ⇒ 整提交回滚并拒绝。
- 受众是 Point 的全函数（见 `fault`）：受众 world 的点携世界腔文本（缺省回落 noResponse），受众 engine 的点必携 debug；玩家侧恒 noResponse，debug 只有 probe 见。
- `admit` 是装载终点的零变更审查（当前世界 × 当下法则）：与零变更授予逐字段同形，proposal 是唯一判别；重放不跑 authored 不变式（历史由当时的法则裁判过）；检查点接纳只验结构完好与 integrity；终态必过 admit——装载拒绝即当下世界违反当下法则。

### 裁决

```
verb = (label, description, schema, cost ∈ ℕ, rules)    -- 意志动词：唯一调用点是 will
tick = (id, rules)                                      -- 常驻规则：唯一调用点是 clock（泵每刻空参）
a    = (verb, params)      params : P ⇀ V               -- 一次尝试即一次裁决、一个时价、一个拒绝单位
ref(a) ⊆ P                指称参数键集
Q    = (world, player, params, roll)                    -- world 深冻结，params 冻结，越权写即抛
J    : Q → ((Grant ⊎ RuleDenial) × ℕ?) ⊎ ⊥              -- ℕ? 即价覆写 ticks，两分支同轴；⊥ 即弃权
Grant      ::= (Δ*, ⟨law⟩?, reply?, statements?)
RuleDenial ::= (Point = rule(⟨law⟩), ⟨text⟩?)
```

- 世界腔文本只有两种角色。`reply`（答复）是对本次提案的答复：每步至多一条（结构保证单值；句数属作者纪律），只存在于有提案者的步（will）——授予缺文本渲染裸 ✓，否决缺文本回落 noResponse。`statements`（陈述）是授予许可的 0..n 条世界腔陈述（零变更授予亦可携；引擎不做语义校验）。否决只有答复。二者都在变更行判据与指称闭包之外——可显示不在 P 中的名字与无名边的聚合，但不产生指称、不改变 P/R、不进指称门；随步逐字入账并冻结，投影不回读世界、不重解析。位置由 (origin, 果, 角色) 决定：will 的答复内联在尝试行、陈述附随变更块；clock 无答复对象，刻内授予的全部文本并入刻陈述（入账时 reply 前插进 statements），否决仍为失败刻。
- 卫语句链 `rules`（动词与常驻规则同构）：链上每条守卫携链内唯一 id；首个非 ⊥ 表态即判决，授予可携 `law`（缺省即守卫 id），否决的 `law` 由 `deny` 给定——记录两侧自含 (守卫, law)。全弃权由引擎闭合为 `closure`。指称参数先过指称门（域即可指称集），非指称参数按字面径由法则裁决（引擎不解析）。刻内授予不得携 ticks（不得延伸时间）——`engine(grant)` 否决。
- 判定与审查是作者否决的两个时相：判定（`Rule`）在提交前读 `w⁻`，携参数与骰子，可授予变更；审查（`Invariant`）在提交后读 `w⁺`、`before`、`changes` 与 `proposal`（admit 无尝试），不可授予。一切否决同形为 `Denial`：rule → `rule(law)`+world(reply?)，gate → `gate`+world(reply?)，closure → `closure`，invariant → `invariant(id,fault)`+受众文本，engine/crash → `engine(check)`/`crash(site)`+engine(debug)。门、闭合、自检、崩溃与作者否决共享同一记录形状与回滚路径，但不能是作者的具名否决点。判定与审查中的作者抛出分别归为 `crash(rule)` 与 `crash(invariant)`。

```
roll(addr, key, sides) = 1 + ⌊h(addr, key) · sides⌋      h : 确定性哈希 → [0,1)
```

- 骰子地址 `addr = (at, origin, verb, 序位)`——入账表态的账本位置；序位 = 同 (at, origin, verb) 的已入账表态数（本步之前）。地址对入账表态单射且由账本前缀唯一确定。默（时钟全弃权与空授予）不入账、不消耗序位；若其调用 roll，取「若入账则应有」的位置。地址不入 params：自由文本入地址会让玩家输入左右随机；同地址恒同值；sides 违约即抛。

### 步

```
Commit ::= (at, origin, action, price, 果)
origin ∈ { will, clock }              -- 入账表态的来源
action ::= (verb, params)             -- 公共载荷；clock 的 params 恒空
price  =  origin = clock ? 0 : (ticks ?? cost)
果     ::= granted(guard, law, changes, reply?, statements?) | denied(guard?, Denial)
```

- 入账判据分两层：内容凡裁决时读出且不可由账本前缀回算者随步入账（钟步的拍坐标是内容：静默刻不留步）；坐标与边界值中可回算者（`seq`、will 步 `at`、钟步 `price=0`、`time`、`prev`）整存为断言，其律由对账验证——不符即链断。由 kind 唯一决定的呈现身份不入账（lawOf 产生）；只读派生视图（脸表、披露谓词、言默、近况、span）一律是投影。
- 序列按构造保序，at 为钟坐标（入账时须等于由价格回算的边界）。origin 由调用点决定（will：玩家经动词面；clock：泵逐刻；两个调用点不相交），随步入账——记录自含分类与价格，投影不重跑裁决、不据动词表反推（name/label/messages 等呈现词汇仍取自 def）。一切步一律携 action（action.verb 即动词或常驻规则 id；clock 的 params 恒空）。果是裁决点：授予记守卫与法则，否决记 Point 与受众；链上规则表态（或授予被审查拒绝）时守卫随果入账（gate/closure 无守卫），授予轨迹不入账。
- 提交存在判据：变更 ∨ 答复 ∨ 陈述 ∨ 否决 ∨ 应答义务。will 提案恒因应答义务入账（授予无文本以 ✓ 行入账、否决缺文本以 noResponse 兜底）；clock 提案无应答义务，空授予即默、不留空步。步入账即冻结。呈现按 origin 分流：will 产尝试行（✓/✗ 动词与答复），clock 归 ⏱（授予成块、否决为失败刻、全弃权即默）。

### 感知

感知与呈现钩子是 def 钩子，不入账本；签名收意志锚（非其推导值），命名、可指称与视图另收引擎缺省实现作为可委托的 base；钩子可无视锚：

```
perceives   : World × Player → (格 → Bool)                          -- 披露：顶点格成员即可见；属性/边格谓词即变更行该侧判据；缺省常真
referable   : World × Player × (实体 → Bool) → (实体 → Bool)         -- 可指称：指称门的域；第三参数 = 披露缺省（顶点格 perceives）
name        : World × Player × (格 → Token?) → (格 → Token?)         -- 格命名；第三参数 = 注册表缺省（顶点 id、属性 label、边 present）；只被呈现消费
view        : World × Player × ViewBase × Γ → ViewValue             -- 状态视图：闭合基座上增补；缺省即基座，增补部分不入闭包
Γ           ::= (格命名, 披露谓词, 脸表)                            -- 该边界的格视图
```

- 披露只有一条轴：`perceives` 是引擎唯一的披露判定。可见域 `P(w) = { e : perceives(w, ⟨e⟩) }`，可指称域 `R(w) = { e : referable(w, e, baseP) }`（`baseP` 即披露缺省），已知域 `H(w) = P ∪ R`：指称门在提交期问 `ref 值 ∈ R(w⁻)?`，卡在呈现期用 P 闭合，一切结构化指称用 H 闭合；属性/边格的谓词值决定该格是否可显示。缺省常真（全见）、可指称缺省即披露；声明即接管总函数，缺省实现以第三参数入参，引擎不设暗回退。命名是另一条轴：唯一入口是 `name`（`label`、`present` 只是其缺省实现的字段）；名字存在性与披露互不代替（可显示 = 有名 ∧ 披露），但任一可独立遮蔽；`present: "hidden"` 只是“缺省无名”。名字不改变指称域（指称恒为 id），故跨位置、同卡同名都不构成机械歧义。
- 结构化呈现须名字、披露、指称闭合同时成立：卡中属性 `name(⟨e,k⟩) ≠ ∅` ∧ `perceives(⟨e,k⟩)` ∧ `refs(k) ⊆ H`；关系 `name(⟨a,b,τ⟩) ≠ ∅` ∧ 端点 ⊆ H ∧ `perceives(⟨a,b,τ⟩)` ∧ 载荷指称 ⊆ H；变更行每侧可显示 ⇔ 该侧边界对变更格有名且披露，行内一切指称（顶点、端点、主语、被披露侧的值指称）须落在两边界 H 之并内，否则整行不渲染。顶点名在 H 上全（缺省回落 id），故「可指名者必在已知集，已知者必可指名（卡或句柄）」是结构化面的定义与闭合。
- `perceives` 对缺席格同样求值：变更行每侧 = 该边界对变更格的谓词值；其值域为 Bool，不改变所指域。谓词读世界真相，不写入、不物化为内容。
- `view` 声明即接管状态视图，第三参数 `base` 即引擎缺省（已过名字、披露与指称闭包），可原样委托或增补改写；增补部分与 reply/statements/散文在此闭包之外：可显示不在 P 中的名字与无名边的聚合（`Γ` 供命名与域对齐），但不产生指称、不改变 P/R、不进指称门；「听说其名但不在场」有两条出口：并入 R 即出句柄目录（可指名），只留在纹理则不可指称。

```
P(w)   ::= { e : perceives(w, ⟨e⟩) }
R(w)   ::= { e : referable(w, e) }
H(w)   ::= P(w) ∪ R(w)
viewBase(w) = ( t,
                entities  = { card(e) : id(e) ∈ P(w) },
                relations = { r ∈ R : name(⟨a,b,τ⟩) ≠ ∅ ∧ {a, b} ⊆ H(w) ∧ perceives(w, ⟨a,b,τ⟩) ∧ 载荷指称 ⊆ H(w) },
                known     = { (id(e), name(⟨e⟩)) : id(e) ∈ R(w)∖P(w) } )
view(w) = def.view?.(w, player, viewBase(w), Γ(w)) ?? viewBase(w)
refs(k) ::= k 非指称 ? ∅ : 值的指称集
card(e) = ( id(e), name(⟨e⟩), props = [(name(⟨e,k⟩), v) : k ∈ K : name(⟨e,k⟩) ≠ ∅ ∧ perceives(w, ⟨e,k⟩) ∧ refs(k) ⊆ H(w)] )   -- 序列承载；ref 值为 id
```

## 协议

一切状态是 `w = (t, E, R)`；∀ 变异恰一入口 `G(Δ*, ⟨rule⟩)`。

**内容与坐标**　`E, R` 是内容，门的原子域；`t` 是坐标（派生，非内容），不产 𝒞，写者唯一（落钟循环），谓词照常读钟。钟的每次写入都归因于某次授予的落钟（刻账目），耦合律是 `Δ钟 = price`：`t = t₀ + Σ price`，泵按 price 逐刻；`ticks` 只是对 price 的覆写（授予与否决同轴），入账后由 price 承接（故不持久）。`step.at` 与回合 `time` 是记录下来的审计坐标，须等于由该律回算的边界；全段算术（首步为 will；后一 will 步 at = 前一 will 步 at + 前一 price；其间 clock 步 at 落在 (前一 will 步 at, 前一 will 步 at + 前一 price] 内非降）不符即链断。回滚的坐标边界由账目裁定：已入账的刻不可回滚，未入账的刻必须一并回滚。

**刻账目闭合**　授予区间的每刻或言或默：`言@at` ＝ 通过变更行判据的变更行、答复、陈述、拒绝之并；`言@at = ∅` 即默。言默是记录的函数（由重建边界重算恒同）；投影只可省略行文，不可重划言默——静默聚合 `timePassed ×n` 计 `|{at : 言@at = ∅}|`。

**异常**　投影钩子与内核代码的异常不进入 `G` 的输出域：apply 边界原子回滚后原样重抛；正常返回 ⇔ 步骤流与账本一致且授予刻数走完。

**随机是账本位置的纯函数**　入账表态同地址恒同值 ⇒ 事件重放与存档恢复得到同一结果。序位是账本前缀的单调摘要：读取不移动状态，推进只在提交点（apply 成功、记录重放通过、检查点播种），失败路径没有非世界状态需要回滚。

**感知是注入的投影**　规则只读世界真相：披露与可指称不进规则，只经引擎的门进入提交；可达性等机制谓词用于投影。指称门在提交期读 `referable`（缺省即顶点格披露），投影在呈现期读 `perceives` 与 `name`；命名不是第二套披露判定，门也不经命名。

## 投影

**判定跨度**　`span(s) = (脸表, 格命名, 披露谓词)(w⁻, w⁺)`——尝试提交跨其提交边界，时钟提交跨其拍的提交边界。跨度是投影而不得是证据：`w⁻/w⁺` 由 genesis ⊕ 𝒞 重建（逆推逐变更取 prev），脸表、格命名与披露谓词由 `name`／`perceives` 对重建世界即时求值；变更行每侧可显示 ⇔ 该边界对变更格有名且披露（缺席格与在场格同过一门）；改名行是派生行——一步内两边界顶点 token 变化且实体两端皆在已知域，即出 `~ 旧 → 新`。投影不回读活世界，也不得把呈现随步入账；言默由重建边界重算，恒同——投影只可省略行文，不可重划。

**事件投影**　AI 所得 = `Π(窗口, def) ⊕ 感知变更行 ⊕ 世界腔文本（答复、陈述与否决理由）`。近况 `Π` 是记录的纯函数且不持久化（记录的提交边界由账本末世界逆推重建，脸表、格命名与披露谓词即时求值，不回读活世界）：窗口内回合记录按与 act 结果相同的变更行判据投影（推论·刻账目闭合），体量由 `recentWindow` 独自调节；言默同源重算。act 结果的新见段是同一投影的回合内增量：本回合新进可见域的实体出卡，新进可指称域的实体出句柄。

## 主体性

**锚**　`def.playerId` 是指向普通实体的引用；意志不在世界里。缺省主语与附身是库约定：内核只给锚与普通实体，`in` 链由库解释。

**缺省主语**　无主语动词的主语 = `hostOf(w, player)`：`in` 链上最近的宿主，缺省锚自身。

**附身**　占据 = 锚实体 `in` 的迁移，一条 delta 过门。可生灭换角的游戏把锚指向不朽实体、宿主建为指称属性：宿主之死被指称契约拦为显式迁移，迁移合法性由过渡不变式钉住。

## 面向作者的契约

- **动词表**：`params` 声明（type×可选×重数×描述）派生接口模式、内核校验与规则参数的编译期类型；`type ∈ {lit(string), lit(number), lit(boolean), ref}`，`ref` 值过指称门（域即可指称集），`lit(·)` 是字面；`many` 令参数为非空序列，与世界值同形——一次尝试的操作数是裁决的一部分（指称逐项过门、整次原子），批次是多个尝试在世界态上的顺序 fold；操作数与顺序组合是两根轴，多重性不由批次承载。
- **常驻规则**（`ticks`）：每刻按声明序由泵以空参提案过同一扇门（顺序 fold：后一条看得见前一条的后果）；无参数、无价、无呈现名；全弃权即默、不得携刻；deny 发声为失败刻。动词面 = 动词表（文本广告与接口模式两种编码）；意志动词的唯一调用点是 will。origin 由调用点决定（两个调用点不相交），判定输入 `Q` 不含 origin；origin 随步入账，投影不回查 def。
- **拒绝**：作者的否决是 `Denial` 在 `rule` 点上的特化——`law` 只被断言与探针消费，`text` 是世界腔答复（缺省回落 noResponse），`ticks` 覆写价；授予侧对称：`grant` 可选携 `law`（缺省守卫 id），两侧记录都自含 (守卫, law)。否决不携带涉及实体——指称落点在 action 参数与法则理由。受众规则见 `fault`。

## 非目标

- 语义校验
- 多意志

## 架构决策

- 进程内集成 pi coding agent（`node_modules/@earendil-works/pi-coding-agent/docs/`）。
- **IPC 形态**：主进程 → 渲染层推送事件流（`narration_delta` / `narration_reset`），渲染层 → 主进程请求（invoke）。
- **回合编排（单 pass）**：每回合一次 `session.prompt()`——模型先调 `act`，其后输出散文。相位 mapping（文本丢弃）→ narration（留作回合叙述，不入账）；重试作废在途生成（`narration_reset`）。
- **上下文裁剪**：每次调用经 `context` 扩展裁剪为最后一条 user 消息起的后缀（工具结果存为独立 toolResult 角色、不并入 user 消息，回合内该锚恒为回合提示，叙述续行因此保住裁决前缀；context 事件的消息是深拷贝，就地改写不写入会话文件）；会话文件累积全量消息作审计。
- **持久化**：唯一证据是回合记录，近况是其纯函数投影，只在窗口更新点（装载 / 回合边界）整体重算，进程重启由记录重建。装载纪要按消费判据（逐条试投影存活）定完好：损坏使近况截断至其后完好子后缀并告警显形，会话文件不动；纪要只喂投影与审计，门不读纪要；截断而非逐条剔除。档案是单一追加日志，条目两种：回合（证据，每回合恰一，定稿写点）与检查点（缓存，声称已含前 n 条回合）。检查点是被信任的缓存。
- **装载即对账**：取最后检查点为主侧锚（缺失或损坏则自变体开局全量重放），其后记录走 𝒞 重放——不重裁决、不掷骰（随机结果已入账）；检查点覆盖的回合不重放世界，但骰子序位仍按账本补点；逐变更 prev 校验加 integrity，authored 不变式不重审；缺省可补全的载荷字段在装载时按引擎缺省补全（授予行的 `law` 缺省 = 守卫 id），形状不符仍弃置显形。链断（序位断裂、钟算术全段不符、prev 不符、完整性失败）则世界与近况同界截断并告警显形，检查点领先于证据即拒绝装载。装载终点对终态跑一次 admit（当下世界 × 当下法则），拒绝即装载失败。检查点每回合随定稿追加，写失败仅告警（缓存可迟到，由下一回合定稿补写）。
- **缓存稳定性**：[tools+system] 放置于开头，系统提示与工具数组字节级稳定，不做 setActiveTools 相位切换；回合内（act 裁决后的描写续行）前缀 [tools+system+user] 逐字节稳定（近况头并入的 user 消息在回合内不变）。
