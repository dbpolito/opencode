export * as BrowserStream from "./stream.js"

import { Duplex } from "node:stream"
import { Browser } from "./rpc.js"

export const WINDOW_BYTES = 1024 * 1024
// Bun's server WebSocket cannot pause reads, so credits bound buffered bytes.
const CREDIT_THRESHOLD = WINDOW_BYTES / 4

export class TunnelStream extends Duplex {
  readonly ready = Promise.withResolvers<void>()
  private credit = 0
  private remaining = WINDOW_BYTES
  private ended = false
  private waiting?: ReturnType<typeof Promise.withResolvers<void>>

  constructor(
    private readonly send: (frame: Uint8Array) => Promise<void>,
    private readonly disconnect: (error: Error | null) => void,
  ) {
    super({ highWaterMark: Browser.TUNNEL_CHUNK_BYTES, allowHalfOpen: true })
    void this.ready.promise.catch(() => undefined)
    this.on("error", () => undefined)
  }

  start() {
    this.grant(WINDOW_BYTES)
  }

  receive(frame: Uint8Array | string) {
    if (this.destroyed) return
    if (typeof frame === "string" || frame.byteLength === 0) {
      this.destroy(new Error("Invalid browser tunnel frame"))
      return
    }
    const data = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
    if (data[0] === 1 && data.byteLength === 5) {
      const credit = data.readUInt32BE(1)
      if (!credit || this.credit + credit > WINDOW_BYTES) {
        this.destroy(new Error("Invalid browser tunnel credit"))
        return
      }
      this.credit += credit
      this.ready.resolve()
      this.waiting?.resolve()
      return
    }
    if (data[0] === 2 && data.byteLength === 1 && !this.ended) {
      this.ended = true
      this.push(null)
      return
    }
    if (
      data[0] !== 0 ||
      this.ended ||
      data.byteLength < 2 ||
      data.byteLength > Browser.TUNNEL_CHUNK_BYTES + 1 ||
      data.byteLength - 1 > this.remaining
    ) {
      this.destroy(new Error("Invalid browser tunnel data or exceeded receive window"))
      return
    }
    this.remaining -= data.byteLength - 1
    if (this.push(data.subarray(1))) this._read()
  }

  override _read() {
    if (this.destroyed || this.ended) return
    const consumed = WINDOW_BYTES - this.remaining - this.readableLength
    if (consumed < CREDIT_THRESHOLD) return
    this.remaining += consumed
    this.grant(consumed)
  }

  override _write(data: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    void (async () => {
      for (let offset = 0; offset < data.byteLength; ) {
        if (this.destroyed) throw new Error("Browser tunnel closed")
        if (!this.credit) {
          this.waiting = Promise.withResolvers<void>()
          await this.waiting.promise
          this.waiting = undefined
        }
        if (this.destroyed) throw new Error("Browser tunnel closed")
        const size = Math.min(this.credit, Browser.TUNNEL_CHUNK_BYTES, data.byteLength - offset)
        const frame = Buffer.allocUnsafe(size + 1)
        frame[0] = 0
        data.copy(frame, 1, offset, offset + size)
        this.credit -= size
        offset += size
        await this.send(frame)
      }
    })().then(() => callback(), callback)
  }

  override _final(callback: (error?: Error | null) => void) {
    void this.send(new Uint8Array([2])).then(() => callback(), callback)
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    const failure = error ?? new Error("Browser tunnel closed")
    this.ready.reject(failure)
    this.waiting?.reject(failure)
    this.disconnect(error)
    callback(error)
  }

  private grant(bytes: number) {
    const frame = Buffer.alloc(5)
    frame[0] = 1
    frame.writeUInt32BE(bytes, 1)
    void this.send(frame).catch((error: Error) => this.destroy(error))
  }
}
