import { Context, Schema } from 'koishi'
import { spawn, ChildProcess, exec } from 'child_process'
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

// 延时函数
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
export function apply(ctx: Context, config: Config) {
  // 此处变量存在于插件生命周期内，用于持有服务端进程
  let mcProcess: ChildProcess | null = null
  let isCapturing = false
  let captureBuffer: string[] = []
  const logger = ctx.logger('MC-Server')

  // 功能：权限检查
  const checkPermission = (session: any) => {
    const isGroupAllowed = config.allowedGroups.includes(session.guildId)
    const isUserAllowed = config.adminIds.includes(session.userId)
    return isGroupAllowed || isUserAllowed
  }

  // 指令：开启服务器
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
          if (log) {
            logger.info(log)
            if (isCapturing) {
              captureBuffer.push(log)
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
          session.send(`服务器似了啦，都你害的`)
        })

      } catch (e) {
        logger.error(e)
        mcProcess = null
        return '启动出错: ' + e.message
      }
    })

  // 指令：关闭服务器
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

  // 指令：向服务器发送命令
  ctx.command('所长，执行 <command:text>', '向服务器发送控制台命令')
    .action(async ({ session }, command) => {
      // 权限校验
      if (!checkPermission(session))
        return '你没有控制服务器的权限！'

      // 状态检查
      if (!mcProcess) {
        return '服务器都没开，执行个鬼'
      }

      // 命令参数检查
      if (!command) {
        return '你执行个寂寞'
      }

      // 向服务端控制台发送命令
      try {
        isCapturing = true                        // 开始捕获输出
        captureBuffer = []
        mcProcess.stdin?.write(command + '\n')
        await sleep(500)
        isCapturing = false                       // 停止捕获输出   
        if (captureBuffer.length === 0) {
          return '命令已发送，无输出'
        }
        const output = captureBuffer.length > 10
          ? captureBuffer.slice(0, 10).join('\n（输出过长，已截断）')
          : captureBuffer.join('\n')
        return output
      } catch (e) {                               // 停止捕获输出  
        isCapturing = false
        logger.error(e)
        return '命令发送失败: ' + e.message
      }
    })

  // 指令：强制杀死服务器进程
  ctx.command('所长，把服杀了', '强制杀死服务器进程')
    .action(async ({ session }) => {
      // 权限校验
      if (!checkPermission(session))
        return '你没有控制服务器的权限！'

      // 状态检查
      if (!mcProcess || mcProcess.killed) {
        return '服务器未运行，或者已经似了'
      }

      const currentPid = mcProcess.pid

      // 杀死服务器进程
      try {
        exec(`taskkill /pid ${currentPid} /T /F`, (error, stdout, stderr) => {
          if (error) {
            logger.error(`杀死服务端进程失败: ${error.message}`)
            session.send(`处决失败！系统返回错误：${error.message}`)
          } else {
            logger.info('已执行 taskkill，等待进程树清理……')
            session.send('处决成功！正在清理进程树。')
          }
        })
        return
      } catch (e) {
        logger.error(e)
        return '纳尼，居然杀不掉？'
      }
    })
}