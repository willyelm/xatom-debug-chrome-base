import { EventEmitter }  from 'events'
import { spawn, exec, ChildProcess } from 'child_process'
import { request } from 'http'
import { type, arch, platform } from 'os'
import { extend, isObject } from 'lodash'
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
  private launched: boolean
  private events: EventEmitter = new EventEmitter()
  quote (value: string) {
    var c, i, l = value.length, o = '"'
    for (i = 0; i < l; i += 1) {
        c = value.charAt(i)
        if (c >= ' ') {
          if (c === '\\' || c === '"') {
            o += '\\'
          }
          o += c
        } else {
          switch (c) {
            case '\b':
              o += '\\b'
              break
            case '\f':
              o += '\\f'
              break
            case '\n':
              o += '\\n'
              break
            case '\r':
              o += '\\r'
              break
            case '\t':
              o += '\\t'
              break
            default:
              c = c.charCodeAt()
              o += '\\u00' + Math.floor(c / 16).toString(16) +
                  (c % 16).toString(16)
          }
        }
    }
    return o + '"'
  }
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
        if (this.launched !== true ) {
          this.events.emit('didFail', output)
        }
        this.events.emit('didStop')
      })
      return this.getSocketUrl()
    } else {
      throw new Error('No binary path specified')
    }
  }
  getPages () {
    return new Promise<Pages>((resolve, reject) => {
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
  findSocketUrl (pages) {
    return new Promise<string>((resolve, reject) => {
      // get first page with a socket url
      let found = (pages || []).find((page: Page) => {
        return Boolean(page.webSocketDebuggerUrl)
      })
      if (found) {
        resolve(found.webSocketDebuggerUrl)
      } else {
        reject('Unable to find page with socket')
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
  getSocketUrl () {
    return new Promise<string | void>(async (resolve, reject) => {
      let pages
      for (var i = 0; i < this.maxAttempts; i++) {
        pages = await this
          .getPages()
          .catch((e) => {
            // continue
          })
        if (isObject(pages)) {
          break;
        }
      }
      await this
        .findSocketUrl(pages)
        .catch((message) => {
          reject(message)
        })
        .then((socketUrl) => {
          this.launched = true
          resolve(socketUrl)
        })
    })
  }
}
