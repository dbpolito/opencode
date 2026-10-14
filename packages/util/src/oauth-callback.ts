export * as OAuthCallback from "./oauth-callback.js"

import { Deferred, Effect } from "effect"
import type { ServerResponse } from "node:http"

export function loopback(uri: string) {
  const url = new URL(uri)
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.port ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("OAuth callback must be an HTTP loopback URI with a port")
  return url
}

export function read(url: URL, state: string, redirectURI?: string) {
  if (redirectURI && url.origin + url.pathname !== redirectURI) throw new Error("OAuth callback URI mismatch")
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
  if (error) throw new Error(error)
  if (url.searchParams.get("state") !== state) throw new Error("OAuth state mismatch")
  const code = url.searchParams.get("code")
  if (!code) throw new Error("Missing authorization code")
  return { code, iss: url.searchParams.get("iss") ?? undefined }
}

export const listen = (input: { redirectURI?: string; port?: number; path?: string } = {}) =>
  Effect.gen(function* () {
    const redirectURI = input.redirectURI
    const redirect = redirectURI ? yield* Effect.try(() => loopback(redirectURI)) : undefined
    const callback = yield* Deferred.make<{ url: URL; response: ServerResponse }, Error>()
    const pending: { response?: ServerResponse } = {}
    const path = redirect?.pathname ?? input.path ?? "/callback"
    // Keep node:http lazy for callers that can also run without a local listener.
    const { createServer } = yield* Effect.promise(() => import("node:http"))
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", uri)
      if (request.method !== "GET" || url.pathname !== path) {
        response.writeHead(404).end()
        return
      }
      if (Effect.runSync(Deferred.isDone(callback))) {
        response.writeHead(409).end()
        return
      }
      pending.response = response
      Effect.runSync(Deferred.succeed(callback, { url, response }))
    })
    const port = yield* Effect.callback<number, Error>((resume) => {
      server.once("error", (error) => resume(Effect.fail(error)))
      server.listen(input.port ?? (Number(redirect?.port) || 0), "127.0.0.1", () => {
        const address = server.address()
        resume(
          address && typeof address === "object"
            ? Effect.succeed(address.port)
            : Effect.fail(new Error("Could not determine OAuth callback port")),
        )
      })
    })
    const uri = redirect?.href ?? `http://127.0.0.1:${port}${path}`
    return {
      redirectURI: uri,
      callback: Deferred.await(callback),
      close: (result?: { status: number; contentType: string; body: string }) => {
        if (result) pending.response?.writeHead(result.status, { "Content-Type": result.contentType }).end(result.body)
        if (!result) pending.response?.destroy()
        pending.response = undefined
        Effect.runSync(Deferred.fail(callback, new Error("OAuth callback receiver closed")))
        server.close()
      },
    }
  })
