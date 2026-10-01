import { expect, test } from "bun:test"
import { createConnection, createServer, type Socket } from "node:net"
import { request } from "node:http"
import { once } from "node:events"
import { Effect } from "effect"
import { Browser } from "../src/rpc.js"
import { BrowserTunnel } from "../src/tunnel.js"
import { BrowserProxy } from "../src/proxy.js"

test("attachment disposal closes sockets and rejects new connections", async () => {
  const accepted = Promise.withResolvers<Socket>()
  const server = createServer((socket) => accepted.resolve(socket))
  await once(server.listen(0, "127.0.0.1"), "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No TCP address")
  const tunnel = BrowserTunnel.make()
  try {
    await Effect.runPromise(tunnel.open({ host: "127.0.0.1", port: address.port }))
    const peer = await accepted.promise
    const closed = once(peer, "close")
    tunnel.dispose()
    await closed
    await expect(Effect.runPromise(tunnel.open({ host: "127.0.0.1", port: address.port }))).rejects.toThrow("closed")
  } finally {
    tunnel.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 15_000)

test("HTTP proxy requires credentials and resolves targets through its transport", async () => {
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      return Response.json({
        body: await req.text(),
        proxyAuthorization: req.headers.get("proxy-authorization"),
        host: req.headers.get("host"),
      })
    },
  })
  const port = target.port
  if (port === undefined) throw new Error("No HTTP port")
  const destinations: Browser.TunnelTarget[] = []
  const proxy = await BrowserProxy.make({
    async connect(destination, signal) {
      destinations.push(destination)
      const socket = createConnection({ ...destination, host: "127.0.0.1", allowHalfOpen: true, signal })
      await once(socket, "connect")
      return socket
    },
  })
  const send = (authorization?: string) =>
    new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: proxy.host,
          port: proxy.port,
          method: "POST",
          path: `http://vps-only.invalid:${port}/echo`,
          headers: authorization ? { "Proxy-Authorization": authorization } : {},
        },
        (response) => {
          let body = ""
          response.on("data", (chunk) => {
            body += chunk
          })
          response.on("end", () => resolve({ status: response.statusCode, body }))
        },
      )
      req.on("error", reject)
      req.end("from the browser")
    })
  try {
    expect((await send()).status).toBe(407)
    expect(destinations).toEqual([])
    const response = await send(
      `Basic ${Buffer.from(`${proxy.credentials.username}:${proxy.credentials.password}`).toString("base64")}`,
    )
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      body: "from the browser",
      host: `vps-only.invalid:${port}`,
      proxyAuthorization: null,
    })
    expect(destinations).toEqual([{ host: "vps-only.invalid", port }])
  } finally {
    await proxy.close()
    target.stop(true)
  }
}, 15_000)
