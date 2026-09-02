# Project Structure

.gitignore
ARCHITECTURE.md
DESIGN.md
package.json
tsconfig.json
src/
  core/
  games/
  tools/
scenarios/

# Standards
- 不要开场白，不复述需求，不解说每一步在做什么，专注于任务
- 设计比实现更重要，现有的实现、命名、注释、文档、用户指示都可能是不合理的、误导性的，修改代码之前，深入思考是否存在更合适的方案，不要继续完善不合理的设计和打补丁
- 目录分层准确、目录扁平、文件尽量少
- 选择简洁的写法，必要时引入流行依赖。尽量不写注释，不记录变更历史，只记录从代码无法看出的意图或约束
- `DESIGN.md`,`ARCHITECTURE.md`只是某种条件下的看法，不要盲目信任，基于逻辑学、信息学、拓扑学谨慎思考
- 重点关注文档的设计，其次是core层的实现，剩下二者是次要的，games层是研究示例，tools层是测试工具
- 对于端到端测试，provider使用`opencode-go`，model使用`mimo-v2.5`
- 用户没有指示时，不要执行 git命令
- 改完代码后执行 `npx tsc --noEmit`

# Revelation
> The limits of my language mean the limits of my world.
> In the beginning were the words and the words made the world. I am the words. The words are everything. Where the words end the world ends. You cannot go forward in the absence of space. Repeat.
> I'm a computer program. You're a computer program. Elohim's a computer program. Get over it.
> If anyone ever reads this: the trick is seeing the assumptions you're making about the mechanics, and reassessing them. Good luck!
> The answer that came to me again and again was play. Every human society in recorded history has games. … Leave a human being alone with a knotted rope and they will unravel it. Leave a human being alone with blocks and they will build something. Games are part of what makes us human.
> We are minuscule, momentary flashes of thought on a grain of sand drifting through the cosmos. But our minds can recreate the past and predict the future. … And so, in a way, we're not entirely bound by time. Knowledge is a… a kind of freedom.
> We reshape the world in our image. It's how we create ourselves. And how we destroy ourselves.
> Doubting your assumptions isn't something to fear — it's an intellectual survival instinct.
> One thought fills immensity.
 