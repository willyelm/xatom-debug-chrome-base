import { ChromeDebuggingProtocolLauncher } from './launcher'
import { ChromeDebuggingProtocolDebugger } from './debugger'

import { get, first, clone } from 'lodash'
import { normalize } from 'path'
import { realpath } from 'fs'

export class ChromeDebuggingProtocolPlugin {

  public options: Object
  public name: String
  public iconPath: String
  public pluginClient: any
  public launcher: any
  public debugger: any

  private isConsoleEnabled: boolean = true

  normalizePath (dir: string, verify?: boolean) {
    return new Promise<string>((resolve, reject) => {
      let fixedPath = dir.replace(/^~/, process.env.HOME)
      let normalizedPath = normalize(fixedPath)
      if (verify) {
        realpath(normalizedPath, (err, resolvedPath) => {
          if (err) {
            reject(err)
          }
          resolve(resolvedPath)
        })
      } else {
        resolve(normalizedPath)
      }
    })
  }

  register (pluginClient) {
    this.pluginClient = pluginClient
  }

  enableConsole() {
    this.isConsoleEnabled = true
  }

  disableConsole () {
    this.isConsoleEnabled = false
  }

  didLaunchError (message: string) {}

  addEventListeners () {
    this.launcher.didStop(() => this.pluginClient.stop())
    this.launcher.didFail((message) => {
      this.pluginClient.status.update(message, 'status-error')
      this.pluginClient.status.stopLoading()
      this.didLaunchError(message)
      this.didStop()
    })
    this.launcher.didReceiveOutput((message) => {
      this.pluginClient.console.log(message)
    })
    this.launcher.didReceiveError((message) => {
      this.pluginClient.console.log(message)
    })
    this.debugger.didClose(() => this.pluginClient.stop())
    this.debugger.didThrownException((params) => {
      let description = get(params, 'exceptionDetails.exception.description', 'Unknown Error')
      this.pluginClient.status.update(description, 'status-error')
    })
    this.debugger.didLogMessage((params) => {
      if (this.isConsoleEnabled === false) return
      this.pluginClient.console.output(params.type, params.args)
    })
    this.debugger.didPause((params) => {
      // set status to pause
      this.pluginClient.status.update('Debugger Paused', 'status-warning')
      this.pluginClient.pause()
      // get call stack
      let callstackFrames = this.debugger.getCallStack()
      if (params.hitBreakpoints && params.hitBreakpoints.length > 0) {
        params.hitBreakpoints.forEach(async (id) => {
          let breakpoint = await this.debugger.getBreakpointById(id)
          if (breakpoint) {
            atom.focus()
            this.pluginClient.status.update('Debugger Breakpoint', 'status-success')
            this.pluginClient.activateBreakpoint(breakpoint.url, breakpoint.lineNumber)
          } else {
            this.activateFirstFrame(callstackFrames)
          }
        })
      } else {
        this.activateFirstFrame(callstackFrames)
      }
      this.pluginClient.setCallStack(callstackFrames)
      this.pluginClient.setScope(this.debugger.getScope())
    })
    this.debugger.didResume(() => {
      this.pluginClient.status.update('Debugger Resumed', 'status-success')
      this.pluginClient.resume()
    })
    this.debugger.didLoadScript((script) => {
      this.addBreakpointsForScript(script)
    })
  }

  activateFirstFrame (callFrames: Array<any>) {
    let firstFrame = first(callFrames)
    if (firstFrame) {
      let { filePath, lineNumber, columnNumber } = firstFrame
      this.pluginClient.activateBreakpoint(filePath, lineNumber, columnNumber)
    }
  }

  addBreakpointsForScript (script: any) {
    let breaks = this.pluginClient.getBreakpoints()
    breaks.forEach((b) => {
      let { filePath, lineNumber, condition } = b
      if (filePath === script.url) {
        this.didAddBreakpoint(filePath, lineNumber, condition)
      }
    })
  }

  // Plugin Actions
  async didStop () {
    this.pluginClient.status.reset()
    this.pluginClient.console.clear()
    await this.debugger.disconnect()
    await this.launcher.stop()
    this.pluginClient.stop()
    this.pluginClient.status.stopLoading()
  }
  async didResume () {
    if (this.debugger.connected) {
      return this.debugger.resume()
    }
  }
  async didPause () {
    if (this.debugger.connected) {
      return this.debugger.pause()
    }
  }
  async didAddBreakpoint (filePath, lineNumber, condition) {
    if (this.debugger.connected) {
      return await this.debugger.addBreakpoint(filePath, lineNumber, condition)
    }
  }
  async didChangeBreakpoint (filePath, lineNumber, condition) {
    this.didAddBreakpoint(filePath, lineNumber, condition)
  }
  async didRemoveBreakpoint (filePath, lineNumber) {
    if (this.debugger.connected) {
      return this.debugger.removeBreakpoint(filePath, lineNumber)
    }
  }

  async didStepOver () {
    if (this.debugger.connected) {
      return this.debugger.stepOver()
    }
  }

  async didStepInto () {
    if (this.debugger.connected) {
      this.debugger.stepInto()
    }
  }

  async didStepOut () {
    if (this.debugger.connected) {
      this.debugger.stepOut()
    }
  }

  async didRequestProperties (request, propertyView) {
    if (this.debugger.connected) {
      let properties: any = await this.debugger.getProperties({
        accessorPropertiesOnly: false,
        generatePreview: false,
        objectId: request.objectId,
        ownProperties: true
      })
      propertyView.insertFromDescription(properties.result)
    }
  }

  async didEvaluateExpression (expression: string, evaluationView) {
    if (this.debugger.connected && this.debugger.paused) {
      let response: any = await this
        .debugger
        .evaluate(expression)
        .catch((e) => {
          // do nothing
        })
      if (response) {
        let result = response.result
        if (result) {
          evaluationView.insertFromResult(result)
        }
      }
    }
  }
}
