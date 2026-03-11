import { Context } from 'koishi'
import { spawn, ChildProcess, exec } from 'child_process'
import * as fs from 'fs'
import { TextDecoder } from 'util'
export { Config } from './config'
import { Config as PluginConfig } from './config' 

export const name = 'local-mcs-runner'

// 运行时状态提升到全局，用于在 Koishi 热重载插件时保留对子进程的控制句柄。
type RuntimeStatus = 'stopped' | 'starting' | 'running' | 'stopping'

interface PluginRuntime {
  child: ChildProcess | null
  status: RuntimeStatus
  currentServerName: string
  expectedExit: boolean
  isCapturing: boolean
  captureBuffer: string[]
  cleanupListeners: (() => void) | null
}

const runtimeKey = Symbol.for('koishi-plugin-local-mcs-runner.runtime')

// 初始化全局共享运行时；仅在当前 Node 进程首次加载插件时创建一次。
const createRuntime = (): PluginRuntime => ({
  child: null,
  status: 'stopped',
  currentServerName: '',
  expectedExit: false,
  isCapturing: false,
  captureBuffer: [],
  cleanupListeners: null,
})

// 从 globalThis 读取共享运行时，使新插件实例可以在热重载后复用旧进程句柄。
const getRuntime = () => {
  const host = globalThis as typeof globalThis & { [runtimeKey]?: PluginRuntime }
  host[runtimeKey] ??= createRuntime()
  return host[runtimeKey]
}

// 延时函数
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function apply(ctx: Context, config: PluginConfig) {
  // runtime 不跟随单次 apply 生命周期销毁，目的是在插件重载后继续管理原有服务端进程。
  const runtime = getRuntime()
  const logger = ctx.logger('MC-Server')
  const decoder = new TextDecoder(config.encoding)  

  // 首次加载插件时默认选择第一项服务端；重载后保留用户之前切换的目标服务端。
  if (!runtime.currentServerName) {
    runtime.currentServerName = Object.keys(config.serverPaths)[0] || ''
  }

  const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // 会话访问级别：full 可执行全部命令，limited 仅可执行 say / list。
  type AccessLevel = 'full' | 'limited' | 'none'

  // 统一替换可配置文案中的占位符，供广播内容和命令返回消息复用。
  const formatTemplate = (template: string, params: Record<string, string | number>) => {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => {
      return params[key] === undefined ? `{${key}}` : String(params[key])
    })
  }

  // 提取当前会话对应的群组ID，私聊场景下为空字符串。
  const getTargetGroupId = (session: any) => session.guildId || session.channelId || ''

  // 汇总所有受管群组，用于广播与默认注入目标。
  const getManagedGroups = () => {
    return Array.from(new Set([...config.trustGroups, ...config.untrustGroups].filter(Boolean)))
  }

  // 获取MC聊天注入目标群；未显式配置时回落到全部受管群。
  const getInjectTargetGroups = () => {
    return config.injectTargetGroups.length ? Array.from(new Set(config.injectTargetGroups.filter(Boolean))) : getManagedGroups()
  }

  // 计算当前会话的权限级别：admin 用户或 trust 群拥有 full 权限。
  const getAccessLevel = (session: any): AccessLevel => {
    const targetGroupId = getTargetGroupId(session)
    const isAdminUser = config.adminIds.includes(session.userId)
    const isTrustGroup = targetGroupId ? config.trustGroups.includes(targetGroupId) : false
    const isUntrustGroup = targetGroupId ? config.untrustGroups.includes(targetGroupId) : false

    if (isAdminUser || isTrustGroup) return 'full'
    if (isUntrustGroup) return 'limited'
    return 'none'
  }

  // 统一校验命令所需权限等级。
  const hasPermission = (session: any, required: Exclude<AccessLevel, 'none'>) => {
    const level = getAccessLevel(session)
    if (required === 'limited') return level === 'limited' || level === 'full'
    return level === 'full'
  }

  // 统一判断当前托管中的子进程是否仍然可用，避免仅凭对象存在就误判为运行中。
  const isProcessAlive = (child: ChildProcess | null = runtime.child) => {
    return !!child && !!child.pid && child.exitCode === null && !child.killed
  }

  // 清理一次命令输出捕获的临时状态，防止重载或退出后残留旧缓冲区。
  const clearCaptureState = () => {
    runtime.isCapturing = false
    runtime.captureBuffer = []
  }

  // 在服务端进程彻底退出后统一重置托管状态。
  const resetProcessState = () => {
    runtime.child = null
    runtime.status = 'stopped'
    runtime.expectedExit = false
    clearCaptureState()
  }

  // 每次热重载都需要移除旧实例绑定的监听器，避免同一子进程被重复监听。
  const detachProcessListeners = () => {
    runtime.cleanupListeners?.()
    runtime.cleanupListeners = null
  }

  // 关闭服务器时优先等待进程自行退出，超时后再走强杀流程。
  const waitForClose = (child: ChildProcess, timeout: number) => {
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (closed: boolean) => {
        if (settled) return
        settled = true
        child.off('close', onClose)
        clearTimeout(timer)
        resolve(closed)
      }
      const onClose = () => finish(true)
      const timer = setTimeout(() => finish(false), timeout)
      child.once('close', onClose)
    })
  }

  // 将 stdout / stderr / close / error 监听统一绑定到当前托管进程上。
  const attachProcessListeners = (child: ChildProcess) => {
    detachProcessListeners()

    const handleStdout = (data: Buffer) => {
      const chunk = decoder.decode(data, { stream: true }).trim()
      const lines = chunk.split('\n')

      for (const line of lines) {
        const rawLog = line.trim()
        if (!rawLog) continue

        logger.info(rawLog)

        if (!runtime.isCapturing) {
          const chat = parseChat(rawLog)
          if (chat) {
            const msg = formatTemplate(config.broadcasts.mcChat, {
              player: chat.player,
              message: chat.message,
            })
            void broadcastToGroup(msg)
            void injectMcChatToKoishi(chat.player, chat.message)
          }
        } else {
          const cleanContent = cleanLog(rawLog)
          if (cleanContent) {
            runtime.captureBuffer.push(cleanContent)
          }
        }
      }
    }

    const handleStderr = (data: Buffer) => {
      logger.warn(data.toString().trim())
    }

    // close 是最终态：无论正常关服还是异常退出，都在这里统一清理共享状态并发送对应广播。
    const handleClose = (code: number | null) => {
      logger.info(`服务端进程已退出，代码: ${code}`)
      const wasExpected = runtime.expectedExit
      detachProcessListeners()
      resetProcessState()
      void broadcastToGroup(wasExpected ? config.broadcasts.stopByUser : config.broadcasts.stopUnexpectedly)
    }

    const handleError = (error: Error) => {
      logger.error(`服务端进程异常: ${error.message}`)
    }

    child.stdout?.on('data', handleStdout)
    child.stderr?.on('data', handleStderr)
    child.on('close', handleClose)
    child.on('error', handleError)

    // 保存当前实例的解绑函数，供下次热重载或插件卸载时使用。
    runtime.cleanupListeners = () => {
      child.stdout?.off('data', handleStdout)
      child.stderr?.off('data', handleStderr)
      child.off('close', handleClose)
      child.off('error', handleError)
    }
  }

  // 如果共享状态里残留的是失效句柄，则在新实例接管前先清空。
  if (runtime.child && !isProcessAlive(runtime.child)) {
    detachProcessListeners()
    resetProcessState()
  }

  // 热重载后重新绑定现有子进程监听器，恢复插件对旧服务端进程的控制能力。
  if (runtime.child && isProcessAlive(runtime.child)) {
    attachProcessListeners(runtime.child)
    runtime.status = runtime.status === 'stopping' ? 'stopping' : 'running'
    logger.info(`检测到已存在的服务端进程，已重新绑定监听器 (PID: ${runtime.child.pid})`)
  }

  // 插件卸载/重载时只解绑监听器，不主动终止服务端进程。
  ctx.on('dispose', () => {
    detachProcessListeners()
  })

  // 监听消息，提取受信任群内 bot 发送的 LLM 控制台指令。
  ctx.on('message', async (session: any) => {
    const mcProcess = runtime.child
    if (!isProcessAlive(mcProcess) || !config.llmPrefix) return

    const targetGroupId = getTargetGroupId(session)
    const userId = session.userId
    const content = session?.content

    logger.info(`[LLM-HOOK] recv user=${userId} guild=${session.guildId} channel=${session.channelId} content=${content}`)

    if (!targetGroupId || !config.trustGroups.includes(targetGroupId)) {
      logger.info(`[LLM-HOOK] blocked by trustGroups, target=${targetGroupId || 'private'}`)
      return
    }

    const isAllowedUser = config.llmBotIds.includes(userId)
    if (!isAllowedUser) {
      logger.info(`[LLM-HOOK] blocked by identity, user=${userId}`)
      return
    }

    if (!content || typeof content !== 'string') {
      logger.info('[LLM-HOOK] blocked by empty content')
      return
    }

    const escapedPrefix = escapeRegExp(config.llmPrefix)
    const regex = new RegExp(`${escapedPrefix}\\s*([^\\n]+)`)
    const match = content.match(regex)
    if (!match || !match[1]) {
      logger.info(`[LLM-HOOK] prefix not matched, prefix=${config.llmPrefix}`)
      return
    }

    const command = match[1].replace(/^\/+/, '').trim()
    if (!command) {
      logger.info('[LLM-HOOK] matched but command empty')
      return
    }

    logger.info(`收到来自 ${userId} 的控制台指令: ${command}`)
    try {
      mcProcess.stdin?.write(command + '\n')
      logger.info(`[LLM-HOOK] command sent: ${command}`)
    } catch (e) {
      logger.error(`指令执行失败: ${e.message}`)
    }
  })

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

  // 将MC聊天广播到全部受管群。
  const broadcastToGroup = async (message: string) => {
    const targetGroups = getManagedGroups()
    for (const bot of ctx.bots) {
      for (const groupId of targetGroups) {
        try {
          await bot.sendMessage(groupId, message)
        } catch (e) {
          logger.warn(`转发消息到群组 ${groupId} 失败: ${e.message}`)
        }
      }
    }
  }

  // 将MC聊天注入到指定群组对应的Koishi消息处理链。
  const injectMcChatToKoishi = async (player: string, message: string) => {
    if (!config.injectMcChatToKoishi) return
    const content = message?.trim()
    if (!content) return

    const targetGroups = getInjectTargetGroups()

    if (!targetGroups.length) {
      logger.warn('MC聊天注入已开启，但没有可用的目标群组（injectTargetGroups / trustGroups / untrustGroups）')
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

  // 指令：指定服务端
  ctx.command(`${config.commands.setServer} <name:string>`, '指定当前操作的服务端')
    .action(async ({ session }, name) => {
      // 权限检查
      if (!hasPermission(session, 'full')) return config.responses.common.noControlPermission

      // 状态检查
      if (isProcessAlive()) return config.responses.setServer.runningBlocked

      // 检查服务端名称
      if (!Object.keys(config.serverPaths).includes(name) || !name) {
        const available = Object.keys(config.serverPaths).join(' | ')
        return formatTemplate(config.responses.setServer.invalidName, { available })
      }

      const targetPath = config.serverPaths[name]
      try {
        if (!targetPath || !fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
          return formatTemplate(config.responses.common.pathUnavailable, { path: targetPath })
        }
      } catch (e) {
        return formatTemplate(config.responses.common.pathUnavailable, { path: targetPath })
      }

      runtime.currentServerName = name
      return formatTemplate(config.responses.setServer.success, {
        name,
        path: targetPath,
      })
    })

  // 指令：开启服务器
  ctx.command(config.commands.startServer, '启动MC服务器')
    .action(async ({ session }) => {
      // 权限检查
      if (!hasPermission(session, 'full')) return config.responses.common.noControlPermission

      // 状态检查
      if (isProcessAlive()) {
        return formatTemplate(config.responses.startServer.alreadyRunning, { pid: runtime.child.pid })
      }

      if (runtime.status === 'starting') {
        return config.responses.startServer.starting
      }

      // 检查服务端名称
      if (!runtime.currentServerName) {
        return config.responses.startServer.noServerSelected
      }

      const targetPath = config.serverPaths[runtime.currentServerName]
      if (!targetPath || !fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
        return formatTemplate(config.responses.common.pathUnavailable, { path: targetPath })
      }

      try {
        // 启动阶段先进入 starting，避免用户连续触发重复开服。
        runtime.status = 'starting'
        runtime.expectedExit = false
        clearCaptureState()

        const child = startProcessByRuntime(targetPath)

        // spawn 的失败通常经由 error / close / exit 上报，因此这里显式等待短时间确认启动结果。
        const startupResult = await new Promise<{ ok: boolean, error?: Error }>((resolve) => {
          let settled = false
          const finish = (result: { ok: boolean, error?: Error }) => {
            if (settled) return
            settled = true
            child.off('error', onError)
            child.off('close', onClose)
            child.off('exit', onExit)
            clearTimeout(timer)
            resolve(result)
          }
          const onError = (error: Error) => finish({ ok: false, error })
          const onClose = () => finish({ ok: false, error: new Error('启动脚本已退出') })
          const onExit = () => finish({ ok: false, error: new Error('启动脚本已退出') })
          const timer = setTimeout(() => finish({ ok: true }), 1500)

          child.once('error', onError)
          child.once('close', onClose)
          child.once('exit', onExit)
        })

        if (!startupResult.ok) {
          runtime.status = 'stopped'
          runtime.expectedExit = false
          return formatTemplate(config.responses.startServer.startFailed, { error: startupResult.error.message })
        }

        runtime.child = child
        runtime.status = 'running'
        attachProcessListeners(child)
        logger.info(`服务器已启动并接管进程 (PID: ${child.pid})`)
        return formatTemplate(config.responses.startServer.startAccepted, {
          serverName: runtime.currentServerName,
          pid: child.pid,
        })

      } catch (e) {
        logger.error(e)
        resetProcessState()
        return formatTemplate(config.responses.startServer.startFailed, { error: e.message })
      }
    })

  // 指令：关闭服务器
  ctx.command(config.commands.stopServer, '关闭MC服务器')
    .action(async ({ session }) => {
      // 权限校验
      if (!hasPermission(session, 'full')) return config.responses.common.noControlPermission

      // 状态检查
      const mcProcess = runtime.child
      if (!isProcessAlive(mcProcess)) {
        return config.responses.common.serverNotRunning
      }

      const currentPid = mcProcess.pid

      try {
        // 标记为预期退出，避免 close 时被误判成崩服广播。
        runtime.expectedExit = true
        runtime.status = 'stopping'
        mcProcess.stdin?.write('stop\n')
        session.send(config.responses.stopServer.stopCommandSent)

        const closed = await waitForClose(mcProcess, 10000)

        if (!closed && isProcessAlive(mcProcess)) {
          session.send(config.responses.stopServer.forceKilling)
          killProcessByRuntime(currentPid, true, (error) => {
            if (error) {
              logger.error(`杀死服务端进程失败: ${error.message}`)
              session.send(formatTemplate(config.responses.common.killFailed, { error: error.message }))
            } else {
              logger.info(`已执行 ${config.runtime} 进程终止命令，等待进程清理……`)
            }
          })
        }

        return
      } catch (e) {
        logger.error(e)
        runtime.expectedExit = false
        runtime.status = isProcessAlive(mcProcess) ? 'running' : 'stopped'
        return formatTemplate(config.responses.stopServer.stopFailed, { error: e.message })
      }
    })

  // 指令：向服务器发送命令
  ctx.command(`${config.commands.sudo} <command:text>`, '向服务器发送控制台命令')
    .action(async ({ session }, command) => {
      // 权限校验
      if (!hasPermission(session, 'full')) return config.responses.common.noControlPermission

      // 状态检查
      const mcProcess = runtime.child
      if (!isProcessAlive(mcProcess)) {
        return config.responses.common.serverNotRunning
      }

      // 命令参数检查
      if (!command) {
        return config.responses.sudo.emptyCommand
      }

      try {
        runtime.isCapturing = true
        runtime.captureBuffer = []

        mcProcess.stdin?.write(command + '\n')

        await sleep(1000)

        runtime.isCapturing = false

        if (runtime.captureBuffer.length === 0) {
          return config.responses.sudo.noOutput
        }

        const output = runtime.captureBuffer.join('\n')
        runtime.captureBuffer = []
        return output.length > 300 ? output.substring(0, 300) + '\n...（消息过长，已截断）' : output

      } catch (e) {
        runtime.isCapturing = false
        logger.error(e)
        return formatTemplate(config.responses.sudo.sendFailed, { error: e.message })
      }
    })

  // 指令：向服务器发送信息
  ctx.command(`${config.commands.say} <content:text>`, '向服务器发送信息')
    .action(async ({ session }, content) => {
      // 权限校验
      if (!hasPermission(session, 'limited')) return config.responses.say.noPermission

      // 状态检查
      const mcProcess = runtime.child
      if (!isProcessAlive(mcProcess)) return config.responses.common.serverNotRunning

      // 内容检查
      if (!content) return config.responses.say.emptyContent

      try {
        const senderName = session.username || session.userId
        mcProcess.stdin?.write(`say ${senderName}：${content}\n`)
        return null
      } catch (e) {
        logger.error(e)
        return formatTemplate(config.responses.say.sendFailed, { error: e.message })
      }
    })

  // 指令：查询在线玩家
  ctx.command(config.commands.list, '查询服务器在线玩家')
    .action(async ({ session }) => {
      // 权限校验
      if (!hasPermission(session, 'limited')) return config.responses.common.noControlPermission

      // 状态检查
      const mcProcess = runtime.child
      if (!isProcessAlive(mcProcess)) return config.responses.common.serverNotRunning

      try {
        runtime.isCapturing = true
        runtime.captureBuffer = []

        mcProcess.stdin?.write('list\n')

        await sleep(2000)

        runtime.isCapturing = false

        if (runtime.captureBuffer.length === 0) {
          return config.responses.list.noOutput
        }

        const output = runtime.captureBuffer.join('\n')
        runtime.captureBuffer = []
        return output.length > 500 ? output.substring(0, 500) + '\n...（消息过长）' : output

      } catch (e) {
        runtime.isCapturing = false
        logger.error(e)
        return formatTemplate(config.responses.list.queryFailed, { error: e.message })
      }
    })

  // 指令：强制杀死服务器进程
  ctx.command(config.commands.killServer, '强制杀死服务器进程')
    .action(async ({ session }) => {
      // 权限校验
      if (!hasPermission(session, 'full')) return config.responses.common.noControlPermission

      // 状态检查
      const mcProcess = runtime.child
      if (!isProcessAlive(mcProcess)) {
        return config.responses.common.serverNotRunning
      }

      const currentPid = mcProcess.pid

      try {
        // 强杀同样属于预期退出，最终状态仍交由 close 回调统一收口。
        runtime.expectedExit = true
        runtime.status = 'stopping'
        killProcessByRuntime(currentPid, true, (error) => {
          if (error) {
            logger.error(`杀死服务端进程失败: ${error.message}`)
            session.send(formatTemplate(config.responses.common.killFailed, { error: error.message }))
          } else {
            logger.info(`已执行 ${config.runtime} 进程终止命令，等待进程树清理……`)
            session.send(config.responses.killServer.killSuccess)
          }
        })
        return
      } catch (e) {
        logger.error(e)
        return formatTemplate(config.responses.common.killFailed, { error: e.message })
      }
    })
}
