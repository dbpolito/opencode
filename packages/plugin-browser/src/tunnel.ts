export * as BrowserTunnel from "./tunnel.js"

import { createConnection } from "node:net"
import { Effect } from "effect"
import { Socket } from "effect/unstable/socket"
import { Browser } from "./rpc.js"
import { BrowserStream } from "./stream.js"

export type Tunnels = ReturnType<typeof make>

// One instance belongs to one desktop attachment. Socket buffers provide
// backpressure; reads never collect an unbounded stream in application memory.
export function make() {
  const sockets = new Map<string, { socket: ReturnType<typeof createConnection>; error?: Error }>()
  let disposed = false
  const close = (id: string) =>
    Effect.sync(() => {
      sockets.get(id)?.socket.destroy()
      sockets.delete(id)
    })

  return {
    connect: Effect.fn("BrowserTunnel.connect")(function* (id: string, socket: Socket.Socket) {
      const entry = sockets.get(id)
      if (!entry) return yield* Effect.fail(new Error("Browser tunnel is closed or unknown."))
      const write = yield* socket.writer
      const stream = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const stream = new BrowserStream.TunnelStream(
            (frame) => Effect.runPromise(write(frame)),
            (error) => {
              entry.socket.destroy()
              void Effect.runPromise(write(new Socket.CloseEvent(error ? 1011 : 1000))).catch(() => undefined)
            },
          )
          entry.socket.once("error", (error) => stream.destroy(error))
          entry.socket.once("close", () => {
            if (disposed || !sockets.has(id) || !entry.socket.readableEnded)
              stream.destroy(new Error("Browser tunnel target closed"))
          })
          stream.pipe(entry.socket)
          entry.socket.pipe(stream)
          return stream
        }),
        (stream) => Effect.sync(() => stream.destroy()),
      )
      yield* socket
        .runRaw((frame) => stream.receive(frame), { onOpen: Effect.sync(() => stream.start()) })
        .pipe(Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void))
    }),
    open: Effect.fn("BrowserTunnel.open")(function* (target: Browser.TunnelTarget) {
      if (disposed) return yield* Effect.fail(new Error("Browser attachment is closed."))
      if (sockets.size >= 64)
        return yield* Effect.fail(new Error("Browser attachment has reached its 64-connection limit."))
      const socket = yield* Effect.try({
        try: () => createConnection({ ...target, allowHalfOpen: true }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      })
      const id = crypto.randomUUID()
      const entry = { socket, error: undefined as Error | undefined }
      socket.on("error", (error) => {
        entry.error = error
      })
      sockets.set(id, entry)
      yield* Effect.callback<void, Error>((resume) => {
        const connected = () => {
          cleanup()
          socket.setNoDelay(true)
          resume(Effect.void)
        }
        const failed = (error: Error) => {
          cleanup()
          resume(Effect.fail(error))
        }
        const closed = () => failed(entry.error ?? new Error("Browser tunnel closed while connecting."))
        const cleanup = () => {
          socket.off("connect", connected)
          socket.off("error", failed)
          socket.off("close", closed)
        }
        socket.once("connect", connected)
        socket.once("error", failed)
        socket.once("close", closed)
        if (socket.destroyed) closed()
        if (!socket.destroyed && !socket.connecting) connected()
        return Effect.sync(cleanup)
      }).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(new Error("Browser tunnel target connection timed out.")),
        }),
        Effect.onError(() => close(id)),
      )
      return id
    }),
    close,
    dispose() {
      disposed = true
      sockets.forEach((entry) => entry.socket.destroy())
      sockets.clear()
    },
  }
}
