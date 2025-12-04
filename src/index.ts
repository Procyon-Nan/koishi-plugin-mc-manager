import { Context, Schema } from 'koishi'
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'

export const name = 'mc-manager'

// 定义配置项：让用户在网页控制台填写的参数
export interface Config {
  serverPath: string
  batName: string
  allowedGroup: string
}

export const Config: Schema<Config> = Schema.object({
  serverPath: Schema.string().description('服务端根目录(绝对路径)').required(),
  batName: Schema.string().default('run.bat').description('启动脚本名称'),
  allowedGroup: Schema.string().description('允许控制的群号').required(),
})

export function apply(ctx: Context, config: Config) {
  // 这里的变量存在于插件生命周期内，用于持有服务端进程
  let mcProcess: ChildProcess | null = null
  const logger = ctx.logger('MC-Server')

  // --- 指令：开服 ---
  ctx.command('所长开服', '启动MC服务器')
    .action(async ({ session }) => {
      // 1. 权限校验
      if (session.guildId !== config.allowedGroup) return

      // 2. 状态检查
      if (mcProcess) {
        return '别吵别吵，服务器已经在运行了，PID: ' + mcProcess.pid
      }

      session.send('正在启动服务器……请等待1~2分钟……')

      try {
        // 3. 启动进程
        // spawn 允许我们保持与子进程的连接
        mcProcess = spawn(config.batName, [], {
          cwd: config.serverPath, // 关键：设置工作目录
          shell: true,            // 关键：允许运行bat脚本
          stdio: 'pipe'           // 关键：启用输入输出流
        })

        logger.info(`服务器已启动 (PID: ${mcProcess.pid})`)

        // 4. 监听服务端日志输出 (STDOUT)
        mcProcess.stdout?.on('data', (data) => {
          // 将Buffer转为字符串。注意：Windows CMD中文通常是GBK，这里可能乱码，但不影响运行
          const log = data.toString().trim()
          if (log) logger.info(log) 
        })

        // 5. 监听错误流 (STDERR)
        mcProcess.stderr?.on('data', (data) => {
          logger.warn(data.toString().trim())
        })

        // 6. 监听进程结束
        mcProcess.on('close', (code) => {
          logger.info(`服务端进程已退出，代码: ${code}`)
          mcProcess = null // 清空变量，允许下次启动
          session.send(`看来服务器已经似了有一会儿了……(Exit Code: ${code})`)
        })

      } catch (e) {
        logger.error(e)
        mcProcess = null
        return '启动出错: ' + e.message
      }
    })

  // --- 指令：关服 ---
  ctx.command('所长关服', '关闭MC服务器')
    .action(async ({ session }) => {
      // 1. 权限校验
      if (session.guildId !== config.allowedGroup) return

      // 2. 状态检查
      if (!mcProcess) {
        return '服务器都没开你关什么……'
      }

      // 3. 发送停止指令
      try {
        // 向服务端虚拟终端输入 stop 并回车
        mcProcess.stdin?.write('stop\n')
        return 'stop指令发过去了，关不关的掉听天由命吧~'
      } catch (e) {
        logger.error(e)
        return '写入指令失败: ' + e.message
      }
    })
}