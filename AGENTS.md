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
- 设计比实现更重要，现有的实现、命名、注释、文档、用户指示都可能是不合理的、误导性的，修改代码之前，研究是否存在更合适的方案，而非完善不合理的设计和打补丁
- 目录分层准确、目录扁平、文件尽量少
- 不写注释，除非能指出代码之外的意图或约束，已有的不规范注释在`edit`范围内清理
- 代码和注释的格式简洁
- `DESIGN.md`,`ARCHITECTURE.md`只是某种条件下的看法，不要盲目信任，基于逻辑学、信息学、拓扑学谨慎思考
- 重点关注文档的设计，其次是core层的实现，剩下二者是次要的，games层是研究示例，tools层是测试工具
- 用户没有指示时，不要执行 git命令
- 不解说每一步在做什么，专注于任务
- 改完代码后执行`npx tsc --noEmit`
 