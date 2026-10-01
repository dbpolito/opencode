import { session, type WebContents } from "electron"
import type { Session } from "@opencode/schema/session"
import { Browser } from "@opencode/plugin-browser/rpc"
import { BrowserProxy } from "@opencode/plugin-browser/proxy"
import { BrowserStream } from "@opencode/plugin-browser/stream"
import { Effect } from "effect"

export type BrowserNetwork = Effect.Success<ReturnType<typeof createBrowserNetwork>>

export const createBrowserNetwork = Effect.fn("BrowserNetwork.create")(function* (input: {
  baseUrl: string
  headers: Readonly<Record<string, string>>
  attachment: { sessionID: Session.ID; connectionID: string }
  location: { directory: string; workspace?: string }
  partition: string
}) {
  const proxy = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      BrowserProxy.make({
        async connect(target, signal) {
          const { NodeWS } = await import("@effect/platform-node/NodeSocket")
          if (signal.aborted) throw new Error("Browser tunnel connection cancelled")
          const url = new URL(
            `${input.baseUrl.replace(/\/$/, "")}/api/rpc/${Browser.Definition.id}/tunnel.connect/connect`,
          )
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
          url.searchParams.set("location[directory]", input.location.directory)
          url.searchParams.set("input", JSON.stringify({ ...input.attachment, target }))
          const socket = new NodeWS.WebSocket(url, {
            headers: input.headers,
            perMessageDeflate: false,
            maxPayload: Browser.TUNNEL_CHUNK_BYTES + 1,
            handshakeTimeout: 15_000,
          })
          const stream = new BrowserStream.TunnelStream(
            (frame) =>
              new Promise<void>((resolve, reject) =>
                socket.send(frame, (error) => (error ? reject(error) : resolve())),
              ),
            () => socket.terminate(),
          )
          const cancel = () => stream.destroy(new Error("Browser tunnel connection cancelled"))
          signal.addEventListener("abort", cancel, { once: true })
          stream.once("close", () => signal.removeEventListener("abort", cancel))
          socket.once("open", () => stream.start())
          socket.on("message", (data, binary) =>
            stream.receive(
              !binary
                ? data.toString()
                : Array.isArray(data)
                  ? Buffer.concat(data)
                  : data instanceof ArrayBuffer
                    ? new Uint8Array(data)
                    : data,
            ),
          )
          socket.once("error", (error) => stream.destroy(error))
          socket.once("close", () =>
            stream.destroy(
              stream.readableEnded && stream.writableFinished ? undefined : new Error("Browser tunnel disconnected"),
            ),
          )
          await stream.ready.promise
          return stream
        },
      }),
    ),
    (proxy) => Effect.promise(() => proxy.close()),
  )
  const partition = session.fromPartition(input.partition)
  yield* Effect.addFinalizer(() => Effect.promise(() => partition.closeAllConnections()))
  // This is the browser's private partition, not the app/API connection. Never
  // bypass localhost: it must resolve on the machine running the OC2 server.
  yield* Effect.tryPromise(() =>
    partition.setProxy({ mode: "fixed_servers", proxyRules: proxy.url, proxyBypassRules: "<-loopback>" }),
  )
  yield* Effect.tryPromise(() => partition.closeAllConnections())
  return {
    attach(contents: WebContents) {
      const login = (
        event: Electron.Event,
        _details: Electron.AuthenticationResponseDetails,
        auth: Electron.AuthInfo,
        callback: (username?: string, password?: string) => void,
      ) => {
        if (
          !auth.isProxy ||
          auth.scheme !== "basic" ||
          auth.host !== proxy.host ||
          auth.port !== proxy.port ||
          auth.realm !== "OpenCode Browser Proxy"
        )
          return
        event.preventDefault()
        callback(proxy.credentials.username, proxy.credentials.password)
      }
      contents.on("login", login)
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")
      return () => contents.off("login", login)
    },
  }
})
