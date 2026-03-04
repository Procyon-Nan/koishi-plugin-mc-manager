import { Context, Schema } from 'koishi'
import { spawn, ChildProcess, exec } from 'child_process'
import * as fs from 'fs'
import { TextDecoder } from 'util'

export const name = 'local-mcs-runner'

// 指令配置接口
export interface CommandConfig {
  setServer: string
  startServer: string
  stopServer: string
  sudo: string
  say: string
  list: string
  killServer: string
}

// 网页控制台配置项
export interface Config {
  serverPaths: Record<string, string>
  batName: string
  allowedGroups: string[]
  adminIds: string[]
  runtime: 'windows' | 'linux'
  encoding: 'utf-8' | 'gbk'
  injectMcChatToKoishi: boolean
  injectTargetGroup: string
  commands: CommandConfig
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
}).description('指令触发消息配置')

export const Config: Schema<Config> = Schema.object({
  runtime: Schema.union(['windows', 'linux']).default('windows').description('运行环境'),
  serverPaths: Schema.dict(String).role('table').description('服务端名称与目录（绝对路径）').required(),
  batName: Schema.string().description('启动脚本名称').required(),
  allowedGroups: Schema.array(String).default([]).description('允许控制的群组'),
  adminIds: Schema.array(String).description('允许控制的用户账号').required(),
  encoding: Schema.union(['utf-8', 'gbk']).default('utf-8').description('服务端日志编码'),
  injectMcChatToKoishi: Schema.boolean().default(false).description('将MC玩家聊天注入到Koishi消息处理链'),
  injectTargetGroup: Schema.string().default('').description('注入目标群组ID（留空则使用allowedGroups）'),
  commands: CommandConfigSchema.required(),
}).description('注意：重载配置会导致服务器进程 PID 丢失，重载配置前，请先停止服务器进程！')

// 延时函数
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function apply(ctx: Context, config: Config) {
  // 此处变量存在于插件生命周期内，用于持有服务端进程
  let mcProcess: ChildProcess | null = null
  let isCapturing = false
  let captureBuffer: string[] = []
  let currentServerName = Object.keys(config.serverPaths)[0] || ''

  const logger = ctx.logger('MC-Server')
  const decoder = new TextDecoder(config.encoding)

  // 杀死服务器进程
  const killProcessByRuntime = (pid: number, force = true, callback?: (error?: Error) => void) => {
    const cmd = config.runtime === 'linux'
      ? `kill ${force ? '-KILL' : '-TERM'} ${pid}`
      : `taskkill /pid ${pid} /T /F`

    exec(cmd, (error) => {
      if (callback) callback(error || undefined)
    })
  }

  // 按运行环境启动服务器进程
  const startProcessByRuntime = (targetPath: string) => {
    if (config.runtime === 'linux') {
      const linuxScript = config.batName.startsWith('./') ? config.batName : `./${config.batName}`
      return spawn(linuxScript, [], {
        cwd: targetPath,
        shell: true,
        stdio: 'pipe'
      })
    }

    return spawn(config.batName, [], {
      cwd: targetPath,
      shell: true,
      stdio: 'pipe'
    })
  }

  // 日志清洗工具
  const cleanLog = (log: string): string | null => {
    // 匹配标准控制台输出格式
    const regex = /^\[\d{2}:\d{2}:\d{2}\] \[.*?\]:?\s*(.*)$/
    const match = log.match(regex)
    if (match && match[1]) {
      return match[1].trim()
    }
    return log
  }

  // 聊天信息检测
  const parseChat = (log: string) => {
    const chatRegex = /]:\s*<([^>]+)>\s*(.*)$/
    const match = log.match(chatRegex)
    if (match) {
      return { player: match[1], message: match[2] }
    }
    return null
  }

  // 聊天信息广播
  const broadcastToGroup = async (message: string) => {
    for (const bot of ctx.bots) {
      for (const groupId of config.allowedGroups) {
        try {
          await bot.sendMessage(groupId, message)
        } catch (e) {
          logger.warn(`转发消息到群组 ${groupId} 失败: ${e.message}`)
        }
      }
    }
  }

  // 将MC聊天注入到Koishi消息处理链
  const injectMcChatToKoishi = async (player: string, message: string) => {
    if (!config.injectMcChatToKoishi) return
    const content = message?.trim()
    if (!content) return

    const targetGroups = config.injectTargetGroup
      ? [config.injectTargetGroup]
      : config.allowedGroups

    if (!targetGroups.length) {
      logger.warn('MC聊天注入已开启，但没有可用的目标群组（injectTargetGroup / allowedGroups）')
      return
    }

    for (const bot of ctx.bots) {
      for (const groupId of targetGroups) {
        try {
          const safePlayer = player.replace(/[^\w\u4e00-\u9fa5-]/g, '_')
          const userId = `mc_${safePlayer}`
          const now = Date.now()
          const session = bot.session() as any

          session.type = 'message'
          session.subtype = 'group'
          session.platform = bot.platform
          session.selfId = bot.selfId
          session.userId = userId
          session.channelId = groupId
          session.guildId = groupId
          session.content = content
          session.messageId = `mc-${now}-${Math.random().toString(36).slice(2, 8)}`
          session.timestamp = now
          session.isDirect = false

          session.author = {
            id: userId,
            name: `MC-${player}`,
            username: `MC-${player}`,
            nickname: player,
          }

          session.event ??= {}
          session.event.user = {
            id: userId,
            name: `MC-${player}`,
          }
          session.event.channel = {
            id: groupId,
            type: 0,
          }
          session.event.message = {
            id: session.messageId,
            content,
            user: session.event.user,
            channel: session.event.channel,
            timestamp: now,
          }

          await session.execute(content)
        } catch (e) {
          logger.warn(`注入MC聊天到Koishi失败（${groupId}）: ${e.message}`)
        }
      }
    }
  }

  // 功能：权限检查
  const checkPermission = (session: any) => {
    const isGroupAllowed = config.allowedGroups.includes(session.guildId)
    const isUserAllowed = config.adminIds.includes(session.userId)
    return isGroupAllowed || isUserAllowed
  }

  // 指令：指定服务端
  ctx.command(`${config.commands.setServer} <name:string>`, '指定当前操作的服务端')
    .action(async ({ session }, name) => {
      // 权限检查
      if (!checkPermission(session)) return '你没有控制服务器的权限！'

      // 状态检查
      if (mcProcess) return '服务器开着呢，不能热插拔啦~'

      // 检查服务端名称
      if (!Object.keys(config.serverPaths).includes(name) || !name) {
        const available = Object.keys(config.serverPaths).join(' | ')
        return '爬！服务器列表里只有\n' + available
      }

      const targetPath = config.serverPaths[name]
      try {
        if (!targetPath || !fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
          return `服务器路径"${targetPath}"不可用！"`
        }
      } catch (e) {
        return `服务器路径"${targetPath}"不可用！`
      }

      currentServerName = name
      return '当前服务器已切换为 ' + name + '\n' + targetPath
    })

  // 指令：开启服务器
  ctx.command(config.commands.startServer, '启动MC服务器')
    .action(async ({ session }) => {
      // 权限检查
      if (!checkPermission(session)) return '你没有控制服务器的权限！'

      // 状态检查
      if (mcProcess) {
        return '别吵别吵，服务器已经在运行了，PID: ' + mcProcess.pid
      }

      // 检查服务端名称
      if (!currentServerName) {
        return '未指定服务端！'
      }

      const targetPath = config.serverPaths[currentServerName]
      session.send(`正在启动${currentServerName}，请等待1~2分钟……`)

      try {
        // 按运行环境启动并保持与子进程连接
        mcProcess = startProcessByRuntime(targetPath)

        logger.info(`服务器已启动 (PID: ${mcProcess.pid})`)

        // 监听服务端日志输出
        mcProcess.stdout?.on('data', (data) => {
          const chunk = decoder.decode(data, { stream: true }).trim()
          const lines = chunk.split('\n')

          for (const line of lines) {
            const rawLog = line.trim()
            if (!rawLog) continue

            // 记录日志到后台
            logger.info(rawLog)

            // 检测聊天信息
            if (!isCapturing) {
              const chat = parseChat(rawLog)
              if (chat) {
                const msg = `[MC] ${chat.player}: ${chat.message}`
                broadcastToGroup(msg)
                injectMcChatToKoishi(chat.player, chat.message)
              }
            } else {
              const cleanContent = cleanLog(rawLog)
              if (cleanContent) {
                captureBuffer.push(cleanContent)
              }
            }
          }
        })

        // 监听错误流
        mcProcess.stderr?.on('data', (data) => {
          logger.warn(data.toString().trim())
        })

        // 监听进程结束
        mcProcess.on('close', (code) => {
          logger.info(`服务端进程已退出，代码: ${code}`)
          mcProcess = null
          broadcastToGroup(`服务器似了啦，都你害的`)
        })

      } catch (e) {
        logger.error(e)
        mcProcess = null
        return '启动出错: ' + e.message
      }
    })

  // 指令：关闭服务器
  ctx.command(config.commands.stopServer, '关闭MC服务器')
    .action(async ({ session }) => {
      // 权限校验
      if (!checkPermission(session)) return '你没有控制服务器的权限！'

      // 状态检查
      if (!mcProcess) {
        return '服务器都没开你关什么……'
      }

      const currentPid = mcProcess.pid

      try {
        mcProcess.stdin?.write('stop\n')
        session.send('stop指令发送喽~')

        await sleep(10000)

        if (mcProcess) {
          session.send('stop无法正常关闭，强制处决中......')
          killProcessByRuntime(currentPid, true, (error) => {
            if (error) {
              logger.error(`杀死服务端进程失败: ${error.message}`)
              session.send(`处决失败！系统返回错误：${error.message}`)
            } else {
              logger.info(`已执行 ${config.runtime} 进程终止命令，等待进程清理……`)
            }
          })
        }

        return
      } catch (e) {
        logger.error(e)
        return '停止指令发送失败: ' + e.message
      }
    })

  // 指令：向服务器发送命令
  ctx.command(`${config.commands.sudo} <command:text>`, '向服务器发送控制台命令')
    .action(async ({ session }, command) => {
      // 权限校验
      if (!checkPermission(session)) return '你没有控制服务器的权限！'

      // 状态检查
      if (!mcProcess) {
        return '服务器都没开，你sudo你🐎呢'
      }

      // 命令参数检查
      if (!command) {
        return '你sudo你🐎呢'
      }

      try {
        isCapturing = true // 开始捕获输出
        captureBuffer = []

        mcProcess.stdin?.write(command + '\n')

        await sleep(1000)

        isCapturing = false // 停止捕获输出

        if (captureBuffer.length === 0) {
          return '命令已发送，无输出'
        }

        const output = captureBuffer.join('\n')
        return output.length > 300 ? output.substring(0, 300) + '\n...（消息过长，已截断）' : output

      } catch (e) {
        isCapturing = false // 停止捕获输出
        logger.error(e)
        return '命令发送失败: ' + e.message
      }
    })

  // 指令：向服务器发送信息
  ctx.command(`${config.commands.say} <content:text>`, '向服务器发送信息')
    .action(async ({ session }, content) => {
      // 权限校验
      if (!checkPermission(session)) return '你没有发送信息的权限！'

      // 状态检查
      if (!mcProcess) return '服务器都没开，你say你🐎呢'

      // 内容检查
      if (!content) return '你say你🐎呢'

      try {
        const senderName = session.username || session.userId
        mcProcess.stdin?.write(`say ${senderName}：${content}\n`)
        return null
      } catch (e) {
        logger.error(e)
        return '发送失败: ' + e.message
      }
    })

  // 指令：查询在线玩家
  ctx.command(config.commands.list, '查询服务器在线玩家')
    .action(async ({ session }) => {
      // 权限校验
      if (!checkPermission(session)) return '你没有控制服务器的权限！'

      // 状态检查
      if (!mcProcess) return '服务器都没开，你list你🐎呢'

      try {
        isCapturing = true
        captureBuffer = []

        mcProcess.stdin?.write('list\n')

        await sleep(2000)

        isCapturing = false

        if (captureBuffer.length === 0) {
          return '命令已发送，但无输出'
        }

        const output = captureBuffer.join('\n')
        return output.length > 500 ? output.substring(0, 500) + '\n...（消息过长）' : output

      } catch (e) {
        isCapturing = false
        logger.error(e)
        return '查询失败: ' + e.message
      }
    })

  // 指令：强制杀死服务器进程
  ctx.command(config.commands.killServer, '强制杀死服务器进程')
    .action(async ({ session }) => {
      // 权限校验
      if (!checkPermission(session)) return '你没有控制服务器的权限！'

      // 状态检查
      if (!mcProcess || mcProcess.killed) {
        return '服务器未运行，或者已经似了'
      }

      const currentPid = mcProcess.pid

      try {
        killProcessByRuntime(currentPid, true, (error) => {
          if (error) {
            logger.error(`杀死服务端进程失败: ${error.message}`)
            session.send(`处决失败！系统返回错误：${error.message}`)
          } else {
            logger.info(`已执行 ${config.runtime} 进程终止命令，等待进程树清理……`)
            session.send('处决成功！已清理进程~')
          }
        })
        return
      } catch (e) {
        logger.error(e)
        return `处决失败！系统返回错误：${e.message}`
      }
    })
}
