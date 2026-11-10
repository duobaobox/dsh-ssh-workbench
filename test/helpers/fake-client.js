/**
 * Minimal ssh2 Client stand-in for broker/runtime unit tests.
 * Records instances so tests can count how many TCP-equivalent connections
 * were opened, and can inject connection-level failures.
 */
import { EventEmitter } from 'node:events'

export class FakeClient extends EventEmitter {
  static instances = []
  static outputFor = null
  static stderrFor = null
  static codeFor = null
  static hangSftpWrites = false
  static hangSftpReads = false
  static sftpStatSize = null
  static reset() {
    FakeClient.instances = []
    FakeClient.outputFor = null
    FakeClient.stderrFor = null
    FakeClient.codeFor = null
    FakeClient.hangSftpWrites = false
    FakeClient.hangSftpReads = false
    FakeClient.sftpStatSize = null
  }

  constructor() {
    super()
    this.connected = false
    this.ended = false
    this.execCount = 0
    this.commands = []
    this.streams = []
    this.sftpCount = 0
    this.failNextExec = false
    this.failNextSftp = false
    FakeClient.instances.push(this)
  }

  connect(config) {
    this.connectConfig = config
    setImmediate(() => {
      this.connected = true
      this.emit('ready')
    })
  }

  end() {
    if (this.ended) return
    this.ended = true
    this.connected = false
    setImmediate(() => this.emit('close'))
  }

  exec(command, callback) {
    this.execCount += 1
    this.commands.push(command)
    if (!this.connected) {
      callback(new Error('not connected'))
      return
    }
    const stream = new EventEmitter()
    stream.stderr = new EventEmitter()
    // Mimic an ssh2 exec channel: the broker is expected to half-close stdin.
    stream.stdinEnded = false
    stream.end = () => {
      stream.stdinEnded = true
    }
    this.streams.push(stream)
    setImmediate(() => {
      callback(null, stream)
      setImmediate(() => {
        if (this.failNextExec) {
          this.failNextExec = false
          stream.emit('error', new Error('ECONNRESET'))
          return
        }
        const text = FakeClient.outputFor ? FakeClient.outputFor(command) : `out:${command}`
        stream.emit('data', Buffer.from(text))
        if (FakeClient.stderrFor) stream.stderr.emit('data', Buffer.from(FakeClient.stderrFor(command)))
        const code = FakeClient.codeFor ? FakeClient.codeFor(command) : 0
        stream.emit('close', code, undefined)
      })
    })
  }

  sftp(callback) {
    this.sftpCount += 1
    if (!this.connected) {
      callback(new Error('not connected'))
      return
    }
    const writtenSizes = new Map()
    const sftp = {
      writtenSizes,
      open: (path, _flags, done) => {
        const handle = { path, closed: false }
        done(null, handle)
      },
      write: (handle, buffer, _offset, length, position, done) => {
        if (FakeClient.hangSftpWrites) return
        const end = position + Math.min(length, buffer.length)
        writtenSizes.set(handle.path, Math.max(writtenSizes.get(handle.path) ?? 0, end))
        done(null)
      },
      read: (_handle, buffer, _offset, length, _position, done) => {
        if (FakeClient.hangSftpReads) return
        const bytes = Math.min(length, buffer.length)
        done(null, bytes, buffer.subarray(0, bytes))
      },
      fstat: (_handle, done) => done(null, { size: 0, mtime: 0 }),
      close: (handle, done) => {
        handle.closed = true
        done(null)
      },
      readdir: (path, done) => {
        if (this.failNextSftp) {
          this.failNextSftp = false
          done(new Error('No such file'))
          return
        }
        done(null, [{ filename: 'a.txt', longname: '-rw-r--r--', attrs: { size: 1, mode: 0o100644, uid: 0, gid: 0, atime: 0, mtime: 0 } }])
      },
      stat: (path, done) => {
        const size = FakeClient.sftpStatSize ?? writtenSizes.get(path) ?? 1
        done(null, { size, mode: 0o100644, uid: 0, gid: 0, atime: 0, mtime: 0 })
      },
      end: () => {},
    }
    callback(null, sftp)
  }
}
