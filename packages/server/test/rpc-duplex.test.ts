import { expect } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { NodeWS } from "@effect/platform-node/NodeSocket"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { define } from "@opencode/plugin/effect/plugin"
import { Browser } from "../../plugin-browser/src/rpc"
import { BrowserStream } from "../../plugin-browser/src/stream"
import { BrowserTunnel } from "../../plugin-browser/src/tunnel"
import { Rpc } from "@opencode/schema/rpc"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { createServer } from "node:net"
import { once } from "node:events"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

const Streaming = Rpc.define({
  id: "streaming",
  methods: {
    connect: {
      input: Schema.Struct({ target: Browser.TunnelTarget }),
      output: Schema.Void,
      duplex: true,
    },
  },
  events: {},
})

it.live("authenticated duplex RPC relays binary TCP traffic with half-close and cleans up on disconnect", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const context = yield* Layer.build(
      createRoutes({
        password: "secret",
        database: { path: ":memory:" },
        models: { fetch: false },
        config: { directory: directory.path, project: false, content: "{}" },
        fs: { filewatcher: false },
      }).pipe(Layer.provide(NodeHttpServer.layerHttpServices)),
    )
    const network = BrowserTunnel.make()
    yield* Effect.addFinalizer(() => Effect.sync(() => network.dispose()))
    const sdk = Context.get(context, SdkPlugins.Service)
    yield* sdk.register(
      define({
        id: "streaming-rpc",
        effect: (ctx) =>
          ctx.rpc
            .register(Streaming, {
              connect: (input, call) =>
                Effect.gen(function* () {
                  const id = yield* Effect.acquireRelease(network.open(input.target), (id) => network.close(id))
                  const socket = yield* call.socket
                  yield* network.connect(id, socket)
                }).pipe(Effect.scoped, Effect.orDie),
            })
            .pipe(Effect.asVoid, Effect.orDie),
      }),
    )
    const http = yield* Effect.gen(function* () {
      const { createServer } = yield* Effect.promise(() => import("node:http"))
      return yield* NodeHttpServer.make(() => createServer(), { port: 0, host: "127.0.0.1" })
    })
    yield* http
      .serve(Context.get(context, HttpRouter.HttpRouter).asHttpEffect())
      .pipe(Effect.provide(context), Effect.provide(NodeHttpServer.layerHttpServices))
    const base = HttpServer.formatAddress(http.address)
    const headers = { authorization: `Basic ${btoa("opencode:secret")}` }
    const url = new URL("/api/rpc/streaming/connect/connect", base)
    url.searchParams.set("location[directory]", directory.path)
    url.searchParams.set("input", "{}")
    expect((yield* Effect.promise(() => fetch(url))).status).toBe(401)
    const invalid = yield* Effect.promise(() => fetch(url, { headers }))
    expect(invalid.status).toBe(400)
    expect(yield* Effect.promise(() => invalid.json())).toMatchObject({ type: "rpc.invalid_input" })
    url.searchParams.set("input", "{")
    expect((yield* Effect.promise(() => fetch(url, { headers }))).status).toBe(400)
    const target = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const server = createServer((socket) => socket.pipe(socket))
        await once(server.listen(0, "127.0.0.1"), "listening")
        return server
      }),
      (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    )
    const address = target.address()
    if (!address || typeof address === "string") throw new Error("No TCP address")
    url.searchParams.set("input", JSON.stringify({ target: { host: "127.0.0.1", port: address.port } }))
    url.protocol = "ws:"
    const stream = yield* Effect.acquireRelease(
      Effect.promise(() => openStream(url, headers)),
      (stream) => Effect.sync(() => stream.destroy()),
    )
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 203)
    const received = yield* Effect.promise(async () => {
      const result = (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of stream) chunks.push(chunk)
        return Buffer.concat(chunks)
      })()
      stream.end(bytes)
      return result
    })
    expect(received).toEqual(bytes)
    const idle = yield* Effect.acquireRelease(
      Effect.promise(() => openStream(url, headers)),
      (stream) => Effect.sync(() => stream.destroy()),
    )
    const closed = once(idle, "close")
    network.dispose()
    yield* Effect.promise(() => closed)
    expect(idle.destroyed).toBe(true)
  }),
)

async function openStream(url: URL, headers: Readonly<Record<string, string>>) {
  const socket = new NodeWS.WebSocket(url, { headers, perMessageDeflate: false })
  const stream = new BrowserStream.TunnelStream(
    (frame) =>
      new Promise<void>((resolve, reject) => socket.send(frame, (error) => (error ? reject(error) : resolve()))),
    () => socket.terminate(),
  )
  socket.on("open", () => stream.start())
  socket.on("message", (data) =>
    stream.receive(
      Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data,
    ),
  )
  socket.on("error", (error) => stream.destroy(error))
  socket.on("close", () => stream.destroy())
  await stream.ready.promise
  return stream
}
