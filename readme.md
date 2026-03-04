# koishi-plugin-local-mcs-runner

[![npm](https://img.shields.io/npm/v/koishi-plugin-local-mcs-runner?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-local-mcs-runner)

## 构建
在应用目录下运行：

`npm run build local-mcs-runner`

## 更新历史

### 2026-03-04
- 新增 `runtime` 配置项，支持 `windows` / `linux` 运行环境选择。
- 进程终止逻辑按运行环境分支执行（Windows 使用 `taskkill`，Linux 使用 `kill`）。
- 新增独立启动函数 `startProcessByRuntime`，按运行环境执行不同启动命令。
- `batName` 调整为必填配置项，由用户显式指定启动脚本名称。
- 新增“MC玩家聊天注入 Koishi 消息处理链”能力（可通过配置开关启用）。
- 新增注入目标群配置项（留空时回落使用 `allowedGroups`）。
- 修复 onebot 场景下注入消息时的 `missing primary key` 问题，补齐会话关键字段并调整虚拟用户 ID 生成策略。
- 备份原始入口文件为 `src/index.ts.bak`。
