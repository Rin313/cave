# 技术架构决策记录

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面壳 | Electron | 目标形态；原型期交互面为 `tools/loop.ts` CLI |
| AI 编排 | pi agent SDK | 进程内集成，文档`node_modules/@earendil-works/pi-coding-agent/docs/` |
| 持久化 | SQLite | 目标形态（存档 + 审计）；原型期由 `loop` 的 runs/ 目录落盘 |

## 核心架构

- **IPC 形态**：主进程 → 渲染层推送事件流（`narration_delta` / `narration_reset`），渲染层 → 主进程请求（invoke）。原始 pi 流（映射期文本、thinking）不出 Engine。
- **回合编排（单 pass）**：每回合一次 `session.prompt()`——模型先调 `act`（one-shot 门闩），工具结果即世界回应（骨架行 + 未解析行 + 新见卡），其后输出散文。相位 mapping（文本丢弃）→ narration（入账）；重试作废在途生成（`narration_reset`），镜像 pi 语义。
- **上下文裁剪**：每次调用经 `cave-context` 扩展（`core/context.ts` 为策略单一来源）裁剪为「近况投影 + 最后一条 user 消息起的后缀」；会话文件累积全量消息作审计；持久化事实是回合记录，近况是其纯函数投影，只在窗口更新点（create / recordTurn）整体重算——回合协议使该点与映射消费点观察等价，进程重启由记录重建。
- **缓存稳定性是显式决策**：状态每回合重注入使跨回合消息前缀不稳定，复用只剩 [tools+system] 头块——系统提示与工具数组字节级稳定，不做 setActiveTools 相位切换；回合内（act 裁决后的描写续行）前缀 [tools+system+user] 逐字节稳定（近况头并入的 user 消息在回合内不变）。compaction 保持关闭：pi 缺省摘要把旧叙述重新注入，与「模拟层唯一真相源」相悖。
- **宿主资源隔离**：no* 全关宿主资源发现（cwd 的 AGENTS.md / 扩展 / 技能不得泄入游戏 prompt）。

## 验证

编译通过、场景通过、e2e 映射与表达准确都是伪信号，不证明设计正确；验证靠阅读 e2e 会话与分析源码。e2e 的 provider 用 `opencode-go`，model 用 `mimo-v2.5`。

## 持久化边界

模拟层状态 JSON 可序列化；SQLite 不存热状态，只存存档与审计：

| 表 | 内容 |
|---|---|
| `games` | 游戏实例：id、状态机类型、创建时间、状态快照、存档 |
| `messages` | 回合历史：用户操作、映射结果、表达输出（回放/审计） |
| `sessions` | pi SDK 会话索引（JSONL 由 SDK 写，此处只存元数据与映射关系） |

重放边界：决策是代码、代码不序列化——transcript 可重放事件流（裁决结果），不可重放裁决过程；存档兼容钉住整个 def（规则代码的版本耦合）。
