import { EventEmitter }  from 'events'
import { spawn, ChildProcess } from 'child_process'
import { request } from 'http'
import { type, arch } from 'os'

export interface Page {
  type: string,
  url: string,
  webSocketDebuggerUrl?: string
}

export type Pages = Array<Page>

export class ChromeDebuggingProtocolLauncher {
  public portNumber: number
  public hostName: string
  private process: ChildProcess
  private maxAttempts: number = 3
  private attempt: number = 0
  private events: EventEmitter = new EventEmitter()
  // Events
  didStop (cb) {
    this.events.on('didStop', cb)
  }
  didFail (cb) {
    this.events.on('didFail', cb)
  }
  didReceiveOutput(cb) {
    this.events.on('didReceiveOutput', cb)
  }
  didReceiveError(cb) {
    this.events.on('didReceiveError', cb)
  }
  // Actions
  getLauncherArguments (): Array<string> {
    return []
  }
  getBinaryPath (): string {
    return null
  }
  getProcessOptions (): Object {
    return {
      shell: true
    }
  }
  stop () {
    this.process.kill()
    this.events.emit('didStop')
  }
  start (): Promise<string> {
    let launchArgs = this.getLauncherArguments()
    let binaryPath = this.getBinaryPath()
    if (binaryPath) {
      this.process = spawn(binaryPath, launchArgs, this.getProcessOptions())
      this.process.stdout.on('data', (res: Uint8Array) => {
        this.events.emit('didReceiveOutput', res)
      })
      this.process.stderr.on('data', (res: Uint8Array) => {
        if (res.toString().length > 0) {
          this.events.emit('didReceiveError', res)
        }
      })
      this.process.on('close', (code) => {
        if (code !== 0) {
          this.events.emit('didFail')
        }
        this.events.emit('didStop')
      })
      return this.getSocketUrl()
    } else {
      throw new Error('no binary path specified')
    }
  }
  getPages (): Promise<Pages> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        let req = request({
          hostname: this.hostName,
          port: this.portNumber,
          path: '/json',
          method: 'GET'
        }, (res) => {
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            try {
              resolve(JSON.parse(String(chunk)) as Pages)
            } catch (e) {
              reject(e)
            }
          })
        })
        req.on('error', reject)
        req.end()
      }, 500)
    })
  }
  findSocketUrl (pages): Promise<string> {
    return new Promise((resolve, reject) => {
      // get first page with a socket url
      let found = (pages || []).find((page: Page) => {
        return Boolean(page.webSocketDebuggerUrl)
      })
      if (found) {
        resolve(found.webSocketDebuggerUrl)
      } else {
        reject('unable to find page with socket')
      }

      // let found = (pages || []).find((page: Page) => {
      //   return (page.url === 'chrome://newtab/')
      // })
      // if (found) {
      //   resolve(found.webSocketDebuggerUrl)
      // } else {
      //   reject('unable to find page with socket')
      // }
    })
  }
  getSocketUrl (): Promise<string> {
    return new Promise((resolve, reject) => {
      setTimeout(async () => {
        let pages = await this
          .getPages()
          .catch(() => {
            if (this.attempt <= this.maxAttempts) {
              resolve(this.getSocketUrl())
            } else {
              reject('unable to get pages')
            }
          })
        resolve(this.findSocketUrl(pages))
      }, 500)
    })
  }
}
