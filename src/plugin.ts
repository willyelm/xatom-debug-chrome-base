import { ChromeDebuggingProtocolLauncher } from './launcher'
import { ChromeDebuggingProtocolDebugger } from './debugger'

export class ChromeDebuggingProtocolPlugin {

  public options: Object
  public name: String
  public iconPath: String
  public pluginClient: any
  public launcher: any
  public debugger: any

  register (pluginClient) {
    this.pluginClient = pluginClient
  }

  didLoad() {}

  addEventListeners () {
    this.launcher.didStop(() => {
      this.pluginClient.stop()
    })
    this.launcher.didFail((message) => {
      this.pluginClient.console.error(message)
    })
    this.launcher.didReceiveError((message) => {
      this.pluginClient.console.error(message)
    })
    this.debugger.didLoad(async () => {
      // apply breakpoints
      let breaks = this.pluginClient.getBreakpoints()
      await Promise.all(breaks.map((b) => {
        let { filePath, lineNumber } = b
        return this.didAddBreakpoint(filePath, lineNumber)
      }))
      this.didLoad()
    })
    this.debugger.didLogMessage((params) => {
      params.args.forEach((a) => {
        switch (a.type) {
          case 'string': {
            this.pluginClient.console[params.type](a.value)
          } break
          default:
            console.log('unhandled console', params)
        }
      })
    })
    this.debugger.didClose(() => {
      this.pluginClient.stop()
    })
    this.debugger.didPause((params) => {
      if (params.hitBreakpoints && params.hitBreakpoints.length > 0) {
        params.hitBreakpoints.forEach(async (id) => {
          let breakpoint = await this.debugger.getBreakpointById(id)
          this.pluginClient.activateBreakpoint(breakpoint.url, breakpoint.lineNumber)
        })
      }
      this.pluginClient.setCallStack(this.debugger.getCallStack())
      this.pluginClient.setScope(this.debugger.getScope())
      // set status to pause
      this.pluginClient.pause()
    })
    this.debugger.didResume(() => this.pluginClient.resume())
  }

  // Actions
  async didStop () {
    this.pluginClient.console.clear()
    await this.debugger.disconnect()
    await this.launcher.stop()
    this.pluginClient.stop()
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
  async didAddBreakpoint (filePath, lineNumber) {
    if (this.debugger.connected) {
      return await this.debugger.addBreakpoint(filePath, lineNumber)
    }
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
