import { Context, Schema } from 'koishi'
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'

export const name = 'mc-manager'

// 网页控制台配置项
export interface Config {
  serverPath: string
  batName: string
  allowedGroups: string[]
  adminIds: string[]
}

export const Config: Schema<Config> = Schema.object({
  serverPath: Schema.string().description('服务端根目录(绝对路径)').required(),
  batName: Schema.string().default('run.bat').description('启动脚本名称'),
  allowedGroups: Schema.array(String).description('允许控制的群组').required(),
  adminIds: Schema.array(String).description('允许控制的用户账号').required(),
})

export function apply(ctx: Context, config: Config) {
  // 此处变量存在于插件生命周期内，用于持有服务端进程
  let mcProcess: ChildProcess | null = null
  const logger = ctx.logger('MC-Server')

  // 权限检查
  const checkPermission = (session: any) => {
    const isGroupAllowed = config.allowedGroups.includes(session.guildId)
    const isUserAllowed = config.adminIds.includes(session.userid)
    return isGroupAllowed || isUserAllowed
  }

  // 开服指令
  ctx.command('所长开服', '启动MC服务器')
    .action(async ({ session }) => {
      // 权限检查
      if (!checkPermission(session))
        return '你没有控制服务器的权限！'

      // 状态检查
      if (mcProcess) {
        return '别吵别吵，服务器已经在运行了，PID: ' + mcProcess.pid
      }

      session.send('正在启动服务器……请等待1~2分钟……')

      // 启动服务端进程
      try {
        // spawn 允许保持与子进程的连接
        mcProcess = spawn(config.batName, [], {
          cwd: config.serverPath,                 // 设置工作目录
          shell: true,                            // 允许运行bat脚本
          stdio: 'pipe'                           // 启用输入输出流
        })

        logger.info(`服务器已启动 (PID: ${mcProcess.pid})`)

        // 监听服务端日志输出
        mcProcess.stdout?.on('data', (data) => {
          const log = data.toString().trim()
          if (log) logger.info(log)
        })

        // 监听错误流
        mcProcess.stderr?.on('data', (data) => {
          logger.warn(data.toString().trim())
        })

        // 监听进程结束
        mcProcess.on('close', (code) => {
          logger.info(`服务端进程已退出，代码: ${code}`)
          mcProcess = null
          session.send(`看来服务器已经似了有一会儿了……(Exit Code: ${code})`)
        })

      } catch (e) {
        logger.error(e)
        mcProcess = null
        return '启动出错: ' + e.message
      }
    })

  // 关服指令
  ctx.command('所长关服', '关闭MC服务器')
    .action(async ({ session }) => {
      // 权限校验
      if (!checkPermission(session))
        return '你没有控制服务器的权限！'

      // 状态检查
      if (!mcProcess) {
        return '服务器都没开你关什么……'
      }

      // 停止服务端
      try {
        mcProcess.stdin?.write('stop\n')
        return 'stop指令发过去了，关不关的掉听天由命吧~'
      } catch (e) {
        logger.error(e)
        return '停止指令发送失败: ' + e.message
      }
    })

  // 强行杀死服务器进程指令
  ctx.command('所长，把服杀了', '强制杀死服务器进程')
    .action(async ({ session }) => {
      // 权限校验
      if (!checkPermission(session))
        return '你没有控制服务器的权限！'

      // 状态检查
      if (!mcProcess) {
        return '服务器未运行，你杀牛魔'
      }

      // 杀死服务器进程
      try {
        mcProcess.kill()
        mcProcess = null
        return '已对服务端进程执行处决！'
      } catch(e) {
        logger.error(e)
        return '纳尼，居然杀不掉'
      }
    })
}