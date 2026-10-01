import { expect, test } from "bun:test"
import { Browser } from "../src/rpc.js"
import { BrowserStream } from "../src/stream.js"

function pair(delay = 0) {
  const frames: number[] = []
  const left = new BrowserStream.TunnelStream(
    async (frame) => {
      frames.push(frame.byteLength)
      if (delay) {
        setTimeout(() => right.receive(frame), delay)
        return
      }
      right.receive(frame)
    },
    () => right.destroy(),
  )
  const right = new BrowserStream.TunnelStream(
    async (frame) => {
      if (delay) {
        setTimeout(() => left.receive(frame), delay)
        return
      }
      left.receive(frame)
    },
    () => left.destroy(),
  )
  left.start()
  right.start()
  return { left, right, frames }
}

test("binary streams preserve ordering and half-close across multiple credit windows", async () => {
  const { left, right, frames } = pair()
  const bytes = Buffer.alloc(BrowserStream.WINDOW_BYTES * 3 + 17)
  bytes.forEach((_value, index) => {
    bytes[index] = index % 251
  })
  const received = (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of left) chunks.push(chunk)
    return Buffer.concat(chunks)
  })()
  right.pipe(right)
  left.end(bytes)
  expect(await received).toEqual(bytes)
  expect(Math.max(...frames)).toBeLessThanOrEqual(Browser.TUNNEL_CHUNK_BYTES + 1)
})

test("a stalled consumer bounds buffered bytes and resumes without losing data", async () => {
  const { left, right } = pair()
  const bytes = Buffer.alloc(BrowserStream.WINDOW_BYTES * 2 + 11, 203)
  let completed = false
  left.write(bytes, () => {
    completed = true
  })
  await Bun.sleep(30)
  expect(completed).toBe(false)
  expect(right.readableLength).toBeLessThanOrEqual(BrowserStream.WINDOW_BYTES)
  expect(right.readableLength).toBeGreaterThan(0)
  const received = (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of right) chunks.push(chunk)
    return Buffer.concat(chunks)
  })()
  left.end()
  expect(await received).toEqual(bytes)
  expect(completed).toBe(true)
  right.end()
  left.resume()
})

test("many frames can cross a delayed link without one round trip per chunk", async () => {
  const { left, right, frames } = pair(50)
  const bytes = Buffer.alloc(BrowserStream.WINDOW_BYTES / 2, 117)
  const received = (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of right) chunks.push(chunk)
    return Buffer.concat(chunks)
  })()
  await left.ready.promise
  left.end(bytes)
  await Bun.sleep(20)
  // All eight data frames are sent before even one can arrive at the peer.
  expect(frames.filter((size) => size > 5)).toHaveLength(8)
  expect(await received).toEqual(bytes)
  right.end()
  left.resume()
})

test("invalid frames and excess credits close the connection", async () => {
  const { left, right } = pair()
  const closed = new Promise<void>((resolve) => left.once("close", resolve))
  left.receive(new Uint8Array([9]))
  await closed
  expect(left.destroyed).toBe(true)
  expect(right.destroyed).toBe(true)
  const another = pair()
  await another.left.ready.promise
  const frame = Buffer.alloc(5)
  frame[0] = 1
  frame.writeUInt32BE(BrowserStream.WINDOW_BYTES, 1)
  another.left.receive(frame)
  expect(another.left.destroyed).toBe(true)
})

test("disconnect fails a write waiting for credit", async () => {
  const { left, right } = pair()
  const result = Promise.withResolvers<Error | null | undefined>()
  left.write(Buffer.alloc(BrowserStream.WINDOW_BYTES * 2), (error) => result.resolve(error))
  await Bun.sleep(20)
  right.destroy()
  expect(await result.promise).toBeInstanceOf(Error)
})

test("disconnect during a send does not leave the next frame waiting for credit", async () => {
  const sent = Promise.withResolvers<void>()
  const sending = Promise.withResolvers<void>()
  const stream = new BrowserStream.TunnelStream(
    (frame) => {
      if (frame[0] !== 0) return Promise.resolve()
      sent.resolve()
      return sending.promise
    },
    () => undefined,
  )
  const credit = Buffer.alloc(5)
  credit[0] = 1
  credit.writeUInt32BE(Browser.TUNNEL_CHUNK_BYTES, 1)
  stream.receive(credit)
  const result = Promise.withResolvers<Error | null | undefined>()
  stream.write(Buffer.alloc(Browser.TUNNEL_CHUNK_BYTES * 2), (error) => result.resolve(error))
  await sent.promise
  stream.destroy()
  sending.resolve()
  expect(await result.promise).toBeInstanceOf(Error)
})
