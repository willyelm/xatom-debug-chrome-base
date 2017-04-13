import { EventEmitter }  from 'events'
import { spawn, exec, ChildProcess } from 'child_process'
import { request } from 'http'
import { type, arch, platform } from 'os'
import { extend } from 'lodash'
const { BufferedProcess } = require('atom')

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
  emitFailure (text: string) {
    this.events.emit('didFail', text)
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
    // this.process.stdin.end()
    // if(platform() === 'win32') {
    //   exec('taskkill /pid ' + this.process.pid + ' /T /F')
    // } else {
    //   this.process.kill()
    // }
    // process.kill(-this.process.pid, 'SIGINT');
    this.process.stdin.end()
    this.process.stderr.removeAllListeners()
    this.process.stderr.pause()
    this.process.stdout.removeAllListeners()
    this.process.stdout.pause()
    this.process.removeAllListeners()
    this.process.kill('SIGINT')
    this.events.emit('didStop')
  }
  start (): Promise<string> {
    this.attempt = 0
    let launchArgs = this.getLauncherArguments()
    let binaryPath = this.getBinaryPath()
    let options = extend(this.getProcessOptions(), {
      detached: true
    })
    if (binaryPath) {
      let output = ''
      this.process = spawn(binaryPath, launchArgs, options)
      // this.process = new BufferedProcess({
      //   command: binaryPath,
      //   args: launchArgs,
      //   options: options
      // })
      this.process.stdout.on('data', (res: Uint8Array) => {
        // console.log('stdout', res.toString())
        this.events.emit('didReceiveOutput', res)
      })
      this.process.stderr.on('data', (res: Uint8Array) => {
        // console.log('stderr', res.toString())
        if (res.toString().length > 0) {
          output += res.toString()
          this.events.emit('didReceiveError', res)
        }
      })
      this.process.on('close', (code) => {
        if (code > 1) {
          this.events.emit('didFail', output)
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
      setTimeout(() => {
        this.attempt++
        this
          .getPages()
          .catch(() => {
            if (this.attempt < this.maxAttempts) {
              resolve(this.getSocketUrl())
            } else {
              reject('Unable to get remote debugger pages')
            }
          })
          .then((pages) => {
            resolve(this.findSocketUrl(pages))
          })
      }, 500)
    })
  }
}
