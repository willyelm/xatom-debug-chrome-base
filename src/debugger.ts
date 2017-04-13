import { spawn } from 'child_process'
import { EventEmitter }  from 'events'
import { ConsoleMessage, Domains, ChromeDebuggingProtocol }  from 'chrome-debugging-protocol'
import { dirname, join, parse as parsePath } from 'path'
import { resolve as resolveUrl, parse as parseUrl } from 'url'
import { stat, readFile } from 'fs'
import { request as requestHttp } from 'http'
import { request as requestHttps } from 'https'
import { get, find, extend, isUndefined } from 'lodash'
const { SourceMapConsumer } = require('source-map')

export interface Script {
  scriptId?: string,
  url: string,
  sourceMapURL?: string
  sourceMap?: any
}

export class ChromeDebuggingProtocolDebugger {
  public connected: boolean = false
  public paused: boolean = false
  public domains: Domains
  public protocol: ChromeDebuggingProtocol
  public breakpoints: Array<object> = []
  public scripts: Array<Script> = []
  public callFrames: Array<any> = []
  public events: EventEmitter = new EventEmitter()
  public skipFirstPause: boolean
  private ignoreUrls: Array<string> = [
    '',
    'extensions::app'
  ]
  // Methods
  public disconnect () {
    if (this.protocol) {
      this.protocol.disconnect()
    }
    this.protocol = null
    this.connected = false
    this.breakpoints = []
    this.scripts = []
  }

  // override with debugger
  didConnect (domains: Domains): Promise<any> {
    return Promise.resolve()
  }

  getFilePathFromUrl (fileUrl: string): string {
    return fileUrl
  }

  public async connect (socketUrl: string) {
    this.protocol = new ChromeDebuggingProtocol(socketUrl)
    this.domains = await this.protocol
      .connect()
      .then((domains) => {
        this.connected = true
        return domains
      })
    var {
      Console,
      Profiler,
      Runtime,
      Debugger,
      Page
    } = this.domains
    this.protocol.didClose(() => this.events.emit('didClose'))
    // Add Listeners
    Runtime.exceptionThrown((params) => {
      if (params.exceptionDetails) {
        let errorObject = {
          type: 'string',
          value: get(params, 'exceptionDetails.exception.description')
        }
        if (params.exceptionDetails.exception) {
          errorObject = params.exceptionDetails.exception
        }
        this.events.emit('didLogMessage', {
          type: 'error',
          args: [errorObject]
        })
      }
    })
    // Page.loadEventFired((params) => {
    //   this.scripts = []
    // })
    Runtime.consoleAPICalled((params) => {
      this.events.emit('didLogMessage', params)
    })
    Debugger.paused((params) => {
      if (this.skipFirstPause === true) {
        Debugger.resume()
        this.skipFirstPause = false
      } else {
        this.callFrames = params.callFrames
        this.paused = true
        this.events.emit('didPause', params)
      }
    })
    Debugger.resumed((params) => {
      this.paused = false
      this.events.emit('didResume')
    })
    Debugger.scriptParsed(async (params) => {
      let isIgnored = this.ignoreUrls['includes'](String(params.url))
      if (isIgnored ) return
      params.originalUrl = params.url
      params.url = this.getFilePathFromUrl(params.url)
      let script: Script = {
        scriptId: params.scriptId,
        url: params.url,
        sourceMapURL: params.sourceMapURL
      }
      if (params.sourceMapURL) {
        let smc
        let rawSourcemap
        let sourcePath = parsePath(params.url)
        let isBase64 = params
          .sourceMapURL
          .match(/^data\:application\/json\;(charset=.+)?base64\,(.+)$/)
        if (isBase64) {
          let base64Content = window.atob(String(isBase64[2]))
          rawSourcemap = await this.getObjectFromString(base64Content)
          smc = new SourceMapConsumer(rawSourcemap)
        } else {
          let mappingPath = join(sourcePath.dir, params.sourceMapURL)
          let mappingUrl
          rawSourcemap = await this
            .getObjectFromFile(mappingPath)
            .catch(() => {
              mappingUrl = resolveUrl(params.originalUrl, params.sourceMapURL)
            })
          if (mappingUrl && isUndefined(rawSourcemap)) {
            rawSourcemap = await this
              .getObjectFromUrl(mappingUrl)
              .catch((e) => {
                // skip: Unable to get sourcemaps.
              })
          }
        }
        if (rawSourcemap) {
          smc = new SourceMapConsumer(rawSourcemap)
          script.sourceMap = {
            getOriginalPosition: (lineNumber: number, columnNumber?: number) => {
              let lookup = {
                line: lineNumber + 1,
                column: columnNumber || 0,
                bias: SourceMapConsumer.LEAST_UPPER_BOUND
              }
              let position = smc.originalPositionFor(lookup)
              if (position.source === null) {
                lookup.bias = SourceMapConsumer.GREATEST_LOWER_BOUND
                position = smc.originalPositionFor(lookup)
              }
              let targetUrl = this.getFilePathFromUrl(position.source || '')
              if (targetUrl === position.source) {
                targetUrl = join(sourcePath.dir, position.source)
              }
              if (position.source) {
                return {
                  url: targetUrl,
                  lineNumber: position.line - 1,
                  columnNumber: position.column
                }
              } else {
                return false
              }
            }
          }
          smc.sources.forEach((sourceUrl) => {
            let targetUrl = this.getFilePathFromUrl(sourceUrl)
            if (targetUrl === sourceUrl) {
              targetUrl = join(sourcePath.dir, sourceUrl)
            }
            let mapScript: Script = {
              // scriptId: params.scriptId,
              url: targetUrl,
              sourceMap: {
                getPosition: (lineNumber: number, columnNumber?: number) => {
                  let lookup = {
                    source: sourceUrl,
                    line: lineNumber + 1,
                    column: columnNumber || 0,
                    bias: SourceMapConsumer.LEAST_UPPER_BOUND
                  }
                  let position = smc.generatedPositionFor(lookup)
                  if (position.line === null) {
                    lookup.bias = SourceMapConsumer.GREATEST_LOWER_BOUND
                    position = smc.generatedPositionFor(lookup)
                  }
                  return {
                    url: params.url,
                    lineNumber: position.line - 1
                  }
                }
              }
            }
            this.addParsedScript(mapScript)
          })
        }
      }
      this.addParsedScript(script)
    })
    // trigger connected
    return await this.didConnect(this.domains)
  }

  addParsedScript (script: Script) {
    let parsed = find(this.scripts, {
      url: script.url
    })
    if (parsed) {
      script = extend({}, parsed, script)
    }
    this.scripts.push(script)
    this.events.emit('didLoadScript', script)
  }

  getUrlForMappedSource (fileUrl: string): any {
    return null
  }

  private getObjectFromUrl (fileUrl: string) {
    let urlParts = parseUrl(fileUrl)
    let requesters = {
      'http:': requestHttp,
      'https:': requestHttps
    }
    return new Promise((resolve, reject) => {
      let requester = requesters[urlParts.protocol]
      if (requester) {
        let req = requester({
          hostname: urlParts.hostname,
          port: urlParts.port,
          path: urlParts.path,
          method: 'GET'
        }, (res) => {
          let responseData = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            responseData += chunk.toString()
          })
          res.on('end', () => {
            // console.log('responseData', responseData)
            resolve(this.getObjectFromString(responseData))
          })
        })
        req.on('error', (e) => {
          reject(`problem with request: ${e.message}`)
        })
        req.end()
      } else {
        reject('unable to identify url protocol')
      }
    })
  }

  private getObjectFromString (data) {
    return new Promise((resolve, reject) => {
      try {
        resolve(JSON.parse(data.toString()))
      } catch (e) {
        reject(e)
      }
    })
  }

  private getObjectFromFile (filePath: string) {
    return new Promise((resolve, reject) => {
      readFile(filePath, (err, data) => {
        if (err) {
          reject(err)
        } else {
          resolve(this.getObjectFromString(data))
        }
      })
    })
  }

  resume () {
    return this.domains.Debugger.resume()
  }

  pause () {
    return this.domains.Debugger.pause()
  }

  stepOver () {
    return this.domains.Debugger.stepOver()
  }

  stepInto () {
    return this.domains.Debugger.stepInto()
  }

  stepOut () {
    return this.domains.Debugger.stepOut()
  }

  getProperties (params) {
    return this.domains.Runtime.getProperties(params)
  }

  evaluateOnFrames (expression: string, frames: Array<any>) {
    return new Promise((resolve, reject) => {
      if (frames.length > 0) {
        let frame = frames.shift()
        if (frame && frame.callFrameId) {
          this
            .domains
            .Debugger
            .evaluateOnCallFrame({
              callFrameId: frame.callFrameId,
              expression: expression,
              generatePreview: false,
              silent: true,
              returnByValue: false,
              includeCommandLineAPI: false
            })
            .then((result: any) => {
              let lookOnParent = frames.length > 0 &&
                result.result.subtype === 'error' &&
                result.result.className !== 'SyntaxError'
              if (lookOnParent) {
                resolve(this.evaluateOnFrames(expression, frames))
              } else if (result && !result.exceptionDetails) {
                resolve(result)
              } else {
                reject(result)
              }
            })
        } else {
          reject('frame has no id')
        }
      } else {
        reject('there are no frames to evaluate')
      }
    })
  }

  evaluate (expression: string) {
    let frames = [...(this.callFrames || [])]
    return this.evaluateOnFrames(expression, frames)
  }

  getScriptById (scriptId: number): Script {
    return this.scripts.find((s) => {
      return parseInt(s.scriptId) === scriptId
    })
  }

  getScriptByUrl (url: string): Script {
    return this.scripts.find((s) => {
      return s.url === url
    })
  }

  getCallStack () {
    return this.callFrames
      .filter((frame: any) => {
        frame.location.script = this.getScriptById(parseInt(frame.location.scriptId))
        let sourceMap = frame.location.script.sourceMap
        if (sourceMap) {
          let position = sourceMap.getOriginalPosition(frame.location.lineNumber,
            parseInt(frame.location.columnNumber))
          if (position) {
            frame.location.script.url = position.url
            frame.location.lineNumber = position.lineNumber
            frame.location.columnNumber = position.columnNumber
            return true
          } else {
            return false
          }
        }
        return true
      })
      .map((frame) => {
        return {
          name: frame.functionName,
          columnNumber: frame.location.columnNumber,
          lineNumber: frame.location.lineNumber,
          filePath: frame.location.script.url,
          scope: this.getScopeFromFrame(frame)
        }
      })
  }

  getFrameByIndex (index: number) {
    return this.callFrames[index]
  }

  setBreakpointFromScript (script: Script, lineNumber: number) {
    return new Promise((resolve) => {
      let position = {
        url: script.url,
        lineNumber: lineNumber
      }
      if (script.sourceMap) {
        position = script.sourceMap.getPosition(lineNumber)
      }
      position.url = this.getFilePathFromUrl(position.url)
      this
        .domains
        .Debugger
        .setBreakpointByUrl(position)
        .then((breakpoint) => {
          this.breakpoints.push({
            id: breakpoint.breakpointId,
            url: script.url,
            columnNumber: 0,
            lineNumber
          })
          resolve(breakpoint)
        })
        .catch((message) => {
          console.log('e', message)
        })
    })
  }

  addBreakpoint (url: string, lineNumber: number) {
    return this
      .removeBreakpoint(url, lineNumber)
      .then(() => {
        return new Promise((resolve, reject) => {
          let script = this.getScriptByUrl(url)
          if (script) {
            resolve(this.setBreakpointFromScript(script, lineNumber))
          } else {
            reject(`${url} is not parsed`)
          }
        })
      })
  }

  getBreakpointById (id): Promise<any> {
    return new Promise ((resolve, reject) => {
      let found = this.breakpoints.find((b: any) => {
        return (b.id === id)
      })
      resolve(found)
    })
  }

  getBreakpoint (url: string, lineNumber: number) {
    return this.breakpoints.find((b: any) => {
      return (b.url === url && b.lineNumber === lineNumber)
    })
  }

  removeBreakpoint (url: string, lineNumber: number) {
    let breakpoint: any = this.getBreakpoint(url, lineNumber)
    if (breakpoint) {
      let index = this.breakpoints.indexOf(breakpoint)
      this.breakpoints.splice(index, 1)
      return this.domains.Debugger.removeBreakpoint({
        breakpointId: breakpoint.id
      })
    }
    return Promise.resolve()
  }
  getScopeFromFrame (frame) {
    let scope = [...frame.scopeChain]
    if (frame.this) {
      scope.unshift({
        type: 'this',
        object: frame.this
      })
    }
    return scope.map((s) => {
      return {
        name: s.type,
        value: s.object
      }
    })
  }
  getScope () {
    let firstFrame = this.getFrameByIndex(0)
    return this.getScopeFromFrame(firstFrame)
  }
  // Events
  didClose (cb: Function) {
    this.events.addListener('didClose', cb)
  }
  didLogMessage (cb: Function) {
    this.events.addListener('didLogMessage', cb)
  }
  didLoadScript (cb: Function) {
    this.events.addListener('didLoadScript', cb)
  }
  didPause (cb: Function) {
    this.events.addListener('didPause', cb)
  }
  didResume (cb: Function) {
    this.events.addListener('didResume', cb)
  }
}
