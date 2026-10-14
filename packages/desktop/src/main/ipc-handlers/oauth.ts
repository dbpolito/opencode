import { Effect } from "effect"
import { OAuthCallback } from "@opencode/util/oauth-callback"
import { OAuthRpcs } from "../../shared/ipc-rpc"
import { IpcPortHandoff } from "../ipc-transport"
import { sender } from "./context"

export const oauthHandlers = OAuthRpcs.toLayer(
  Effect.gen(function* () {
    const handoff = yield* IpcPortHandoff
    const receivers = new Map<
      string,
      {
        owner: number
        receiver: Effect.Success<ReturnType<typeof OAuthCallback.listen>>
        dispose: (result?: { success: boolean; message: string }) => void
      }
    >()
    yield* Effect.addFinalizer(() => Effect.sync(() => receivers.forEach((entry) => entry.dispose())))

    return OAuthRpcs.of({
      OAuthListen: ({ redirectURI }, context) =>
        Effect.gen(function* () {
          const owner = sender(handoff, context)
          const receiver = yield* OAuthCallback.listen({ redirectURI })
          const token = crypto.randomUUID()
          const dispose = (result?: { success: boolean; message: string }) => {
            clearTimeout(timeout)
            owner.removeListener("destroyed", dispose)
            receiver.close(
              result
                ? {
                    status: result.success ? 200 : 400,
                    contentType: "text/plain; charset=utf-8",
                    body: result.message,
                  }
                : undefined,
            )
            receivers.delete(token)
          }
          const timeout = setTimeout(dispose, 10 * 60 * 1000)
          owner.once("destroyed", dispose)
          receivers.set(token, { owner: owner.id, receiver, dispose })
          return { token, redirectURI: receiver.redirectURI }
        }).pipe(Effect.orDie),
      OAuthCallback: ({ token }, context) =>
        Effect.gen(function* () {
          const entry = receivers.get(token)
          if (!entry || entry.owner !== sender(handoff, context).id)
            return yield* Effect.die(new Error("OAuth callback receiver not found"))
          return (yield* entry.receiver.callback).url.href
        }).pipe(Effect.orDie),
      OAuthClose: ({ token, result }, context) =>
        Effect.sync(() => {
          const entry = receivers.get(token)
          if (!entry || entry.owner !== sender(handoff, context).id) return
          entry.dispose(result)
        }),
    })
  }),
)
