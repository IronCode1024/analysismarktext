import './globalSetting'
import path from 'path'
import { app, dialog } from 'electron'
import { initialize as remoteInitializeServer } from '@electron/remote/main'
import cli from './cli'
import setupExceptionHandler, { initExceptionLogger } from './exceptionHandler'
import log from 'electron-log'
import App from './app'
import Accessor from './app/accessor'
import setupEnvironment from './app/env'
import { getLogLevel } from './utils'

const initializeLogger = appEnvironment => {
  log.transports.console.level = process.env.NODE_ENV === 'development' ? 'info' : 'error'
  log.transports.rendererConsole = null
  log.transports.file.resolvePath = () => path.join(appEnvironment.paths.logPath, 'main.log')
  log.transports.file.level = getLogLevel()
  log.transports.file.sync = true
  initExceptionLogger()
}

// -----------------------------------------------

// NOTE: We only support Linux, macOS and Windows but not BSD nor SunOS.
// 注意：我们只支持Linux、macOS和Windows，但不支持BSD或SunOS。
if (!/^(darwin|win32|linux)$/i.test(process.platform)) {
  process.stdout.write(`Operating system "${process.platform}" is not supported! Please open an issue at "https://github.com/marktext/marktext".\n`)
  process.exit(1)
}

setupExceptionHandler()

const args = cli()
const appEnvironment = setupEnvironment(args)
initializeLogger(appEnvironment)

if (args['--disable-gpu']) {
  app.disableHardwareAcceleration()
}

// Make MarkText a single instance application.
if (!process.mas && process.env.NODE_ENV !== 'development') {
  const gotSingleInstanceLock = app.requestSingleInstanceLock()
  if (!gotSingleInstanceLock) {
    process.stdout.write('Other MarkText instance detected: exiting...\n')
    app.exit()
  }
}

// MarkText environment is configured successfully. You can now access paths, use the logger etc.
// MarkText环境配置成功。您现在可以访问路径、使用记录器等。
// Create other instances that need access to the modules from above.
// 创建需要从上面访问模块的其他实例。
let accessor = null
try {
  accessor = new Accessor(appEnvironment)
} catch (err) {
  // Catch errors that may come from invalid configuration files like settings.
  // 捕获可能来自无效配置文件（如设置）的错误。
  const msgHint = err.message.includes('Config schema violation')
    ? 'This seems to be an issue with your configuration file(s). '
    : ''
  log.error(`Loading MarkText failed during initialization! ${msgHint}`, err)

  const EXIT_ON_ERROR = !!process.env.MARKTEXT_EXIT_ON_ERROR
  const SHOW_ERROR_DIALOG = !process.env.MARKTEXT_ERROR_INTERACTION
  if (!EXIT_ON_ERROR && SHOW_ERROR_DIALOG) {
    dialog.showErrorBox(
      'There was an error during loading',
      `${msgHint}${err.message}\n\n${err.stack}`
    )
  }
  process.exit(1)
}

// Use synchronous only to report errors in early stage of startup.
// 仅使用同步在启动的早期阶段报告错误。
log.transports.file.sync = false

// -----------------------------------------------
// Be careful when changing code before this line!
// NOTE: Do not create classes or other code before this line!

// TODO: We should switch to another async API like https://nornagon.medium.com/electrons-remote-module-considered-harmful-70d69500f31.
// Enable remote module
//-----------------------------------------------

//在这一行之前更改代码时要小心！
//注意：请勿在此行之前创建类或其他代码！

//TODO：我们应该切换到另一个异步API，如https://nornagon.medium.com/electrons-remote-module-considered-harmful-70d69500f31.
//启用远程模块
remoteInitializeServer()

const marktext = new App(accessor, args)
marktext.init()
