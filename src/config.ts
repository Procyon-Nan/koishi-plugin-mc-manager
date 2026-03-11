import { Schema } from 'koishi'

// 定义各条 Koishi 指令的触发词
export interface CommandConfig {
  setServer: string
  startServer: string
  stopServer: string
  sudo: string
  say: string
  list: string
  killServer: string
}

// 发送到所有目标群聊的广播消息
export interface BroadcastConfig {
  mcChat: string
  stopByUser: string
  stopUnexpectedly: string
}

// 多个命令复用的通用返回消息
export interface CommonResponseConfig {
  noControlPermission: string
  pathUnavailable: string
  serverNotRunning: string
  killFailed: string
}

// 切换服务端命令的返回消息
export interface SetServerResponseConfig {
  runningBlocked: string
  invalidName: string
  success: string
}

// 开服命令的返回消息
export interface StartServerResponseConfig {
  alreadyRunning: string
  starting: string
  noServerSelected: string
  startFailed: string
  startAccepted: string
}

// 关服命令的返回消息
export interface StopServerResponseConfig {
  stopCommandSent: string
  forceKilling: string
  stopFailed: string
}

// sudo 命令的返回消息
export interface SudoResponseConfig {
  emptyCommand: string
  noOutput: string
  sendFailed: string
}

// say 命令的返回消息
export interface SayResponseConfig {
  noPermission: string
  emptyContent: string
  sendFailed: string
}

// list 命令的返回消息
export interface ListResponseConfig {
  noOutput: string
  queryFailed: string
}

// 强制终止命令的返回消息
export interface KillServerResponseConfig {
  killSuccess: string
}

// 返回消息总配置：common 用于复用，其余按命令拆分
export interface ResponseConfig {
  common: CommonResponseConfig
  setServer: SetServerResponseConfig
  startServer: StartServerResponseConfig
  stopServer: StopServerResponseConfig
  sudo: SudoResponseConfig
  say: SayResponseConfig
  list: ListResponseConfig
  killServer: KillServerResponseConfig
}

// 插件主配置：包含服务端路径、权限分层、广播文案、命令回复消息和指令触发词。
export interface Config {
  serverPaths: Record<string, string>
  batName: string
  trustGroups: string[]
  untrustGroups: string[]
  adminIds: string[]
  runtime: 'windows' | 'linux'
  encoding: 'utf-8' | 'gbk'
  injectMcChatToKoishi: boolean
  injectTargetGroups: string[]
  llmPrefix: string
  llmBotIds: string[]
  commands: CommandConfig
  broadcasts: BroadcastConfig
  responses: ResponseConfig
}

// 指令配置 Schema
const CommandConfigSchema: Schema<CommandConfig> = Schema.object({
  setServer: Schema.string().default('setserver').description('切换服务器指令'),
  startServer: Schema.string().default('开服').description('启动服务器指令'),
  stopServer: Schema.string().default('关服').description('关闭服务器指令'),
  sudo: Schema.string().default('sudo').description('发送控制台命令指令'),
  say: Schema.string().default('say').description('发送消息指令'),
  list: Schema.string().default('list').description('查询在线玩家指令'),
  killServer: Schema.string().default('杀死服务器进程').description('强制终止服务器指令'),
}).description('指令配置')

// 广播信息 Schema
const BroadcastConfigSchema: Schema<BroadcastConfig> = Schema.object({
  mcChat: Schema.string().default('[MC] {player}: {message}').description('MC 聊天转发到群聊的广播模板'),
  stopByUser: Schema.string().default('服务器似了啦，都你害的').description('主动关服时的群聊广播'),
  stopUnexpectedly: Schema.string().default('哎......服务器怎么寄了~').description('服务端非预期退出时的群聊广播'),
}).description('广播到所有群聊的消息配置')

// 指令返回消息 Schema
const ResponseConfigSchema: Schema<ResponseConfig> = Schema.object({
  common: Schema.object({
    noControlPermission: Schema.string().default('你没有控制服务器的权限！').description('无控制权限时的提示'),
    pathUnavailable: Schema.string().default('服务器路径"{path}"不可用！').description('服务端路径不可用时的提示'),
    serverNotRunning: Schema.string().default('服务器没开呢~').description('服务器未运行时的提示'),
    killFailed: Schema.string().default('处决失败！系统返回错误：{error}').description('执行强制终止失败时的提示'),
  }).description('通用返回消息'),
  setServer: Schema.object({
    runningBlocked: Schema.string().default('服务器开着呢，不能热插拔啦~').description('运行中禁止切换服务端时的提示'),
    invalidName: Schema.string().default('爬！服务器列表里只有\n{available}').description('服务端名称无效时的提示'),
    success: Schema.string().default('当前服务器已切换为 {name}\n{path}').description('切换服务端成功时的提示'),
  }).description('切换服务端命令返回消息'),
  startServer: Schema.object({
    alreadyRunning: Schema.string().default('别吵别吵，服务器已经在运行了，PID: {pid}').description('服务器已在运行时的提示'),
    starting: Schema.string().default('服务器正在启动中，请稍等~').description('服务器正在启动时的提示'),
    noServerSelected: Schema.string().default('未指定服务端！').description('未指定服务端时的提示'),
    startFailed: Schema.string().default('启动出错: {error}').description('启动失败时的提示'),
    startAccepted: Schema.string().default('正在启动{serverName}，PID: {pid}').description('启动成功接管进程时的提示'),
  }).description('开服命令返回消息'),
  stopServer: Schema.object({
    stopCommandSent: Schema.string().default('stop指令发送喽~').description('已发送 stop 指令时的提示'),
    forceKilling: Schema.string().default('stop无法正常关闭，强制处决中......').description('stop 超时后开始强制终止时的提示'),
    stopFailed: Schema.string().default('停止指令发送失败: {error}').description('发送 stop 指令失败时的提示'),
  }).description('关服命令返回消息'),
  sudo: Schema.object({
    emptyCommand: Schema.string().default('你sudo你🐎呢').description('未提供控制台命令时的提示'),
    noOutput: Schema.string().default('命令已发送，无输出').description('控制台命令无输出时的提示'),
    sendFailed: Schema.string().default('命令发送失败: {error}').description('控制台命令发送失败时的提示'),
  }).description('sudo 命令返回消息'),
  say: Schema.object({
    noPermission: Schema.string().default('你没有发送信息的权限！').description('无 say 权限时的提示'),
    emptyContent: Schema.string().default('你say你🐎呢').description('未提供 say 内容时的提示'),
    sendFailed: Schema.string().default('发送失败: {error}').description('say 命令失败时的提示'),
  }).description('say 命令返回消息'),
  list: Schema.object({
    noOutput: Schema.string().default('命令已发送，但无输出').description('list 命令无输出时的提示'),
    queryFailed: Schema.string().default('查询失败: {error}').description('list 命令失败时的提示'),
  }).description('list 命令返回消息'),
  killServer: Schema.object({
    killSuccess: Schema.string().default('处决成功！已清理进程~').description('强制终止成功时的提示'),
  }).description('强制终止命令返回消息'),
}).description('命令执行后的返回消息配置')

// 插件主配置 Schema
export const Config: Schema<Config> = Schema.object({
  runtime: Schema.union(['windows', 'linux']).default('windows').description('运行环境'),
  serverPaths: Schema.dict(String).role('table').description('服务端名称与目录（绝对路径）').required(),
  batName: Schema.string().description('启动脚本名称').required(),
  trustGroups: Schema.array(String).default([]).description('受信任群组（拥有全部指令权限）'),
  untrustGroups: Schema.array(String).default([]).description('非受信任群组（仅允许 say / list）'),
  adminIds: Schema.array(String).description('允许控制的用户账号').required(),
  encoding: Schema.union(['utf-8', 'gbk']).default('utf-8').description('服务端日志编码'),
  injectMcChatToKoishi: Schema.boolean().default(false).description('将MC玩家聊天注入到Koishi消息处理链'),
  injectTargetGroups: Schema.array(String).default([]).description('注入目标群组ID列表（留空则使用 trustGroups + untrustGroups）'),
  llmPrefix: Schema.string().default('执行/').description('LLM触发前缀（匹配到后将其后内容发送到服务端控制台）'),
  llmBotIds: Schema.array(String).default([]).description('允许触发后台指令的云端机器人账号ID'),
  commands: CommandConfigSchema.required(),
  tipsTittle: Schema.object({}).description('消息配置可用的模板变量'),
  tipsMessage: Schema.object({}).description('{player} {message} {available} {name} {path} {serverName} {pid} {error}'),
  broadcasts: BroadcastConfigSchema,
  responses: ResponseConfigSchema,
}).description('注意：建议启动脚本保持前台运行，不要在脚本内自行脱离控制台。')
