# Project Structure

.gitignore
ARCHITECTURE.md
DESIGN.md
package.json
tsconfig.json
scenarios/
src/
  core/
  games/
  tools/

# Standards
- 架构越简洁越好，文件数量越少越好
- 改进和修复代码之前，深入思考是否存在更优雅的处理方案，而不是继续完善不合理的设计和打补丁
- 注释只写一行，只记录从代码无法看出的意图或约束，不记录变更历史
- 对于端到端测试，provider使用`opencode-go`，model使用`ox-alpha-free`
- 用户没有指示时，不要执行 git命令
- 改完代码后执行 `npx tsc --noEmit`

# Other
> The limits of my language mean the limits of my world.
> In the beginning were the words and the words made the world. I am the words. The words are everything. Where the words end the world ends. You cannot go forward in the absence of space. Repeat.
> I'm a computer program. You're a computer program. Elohim's a computer program. Get over it.
> If anyone ever reads this: the trick is seeing the assumptions you're making about the mechanics, and reassessing them. Good luck!
> The answer that came to me again and again was play. Every human society in recorded history has games. … Leave a human being alone with a knotted rope and they will unravel it. Leave a human being alone with blocks and they will build something. Games are part of what makes us human.
> We are minuscule, momentary flashes of thought on a grain of sand drifting through the cosmos. But our minds can recreate the past and predict the future. … And so, in a way, we're not entirely bound by time. Knowledge is a… a kind of freedom.
> We reshape the world in our image. It's how we create ourselves. And how we destroy ourselves.
> Doubting your assumptions isn't something to fear — it's an intellectual survival instinct.
> One thought fills immensity.
 