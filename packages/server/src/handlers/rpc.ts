import { Rpc } from "@opencode/core/rpc"
import { Plugin } from "@opencode/core/plugin"
import { RpcError, RpcInternalError } from "@opencode/protocol/errors"
import { Effect, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const RpcHandler = HttpApiBuilder.group(Api, "server.rpc", (handlers) =>
  handlers
    .handle("rpc.call", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* Plugin.awaitActivation
        const rpc = yield* Rpc.Service
        const output = yield* rpc.call(params.rpcID, params.method, payload.input)
        return output === undefined ? {} : { output }
      }).pipe(
        Effect.mapError(rpcError),
        // Defects outside handler execution are still logged, never echoed to the client.
        Effect.catchDefect((defect) =>
          Effect.logError("rpc call failed", { rpc: params.rpcID, method: params.method, defect }).pipe(
            Effect.andThen(Effect.fail(new RpcInternalError({ type: "rpc.internal", message: "RPC call failed" }))),
          ),
        ),
      ),
    )
    .handleRaw("rpc.connect", (ctx) =>
      Effect.gen(function* () {
        yield* Plugin.awaitActivation
        const rpc = yield* Rpc.Service
        const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(ctx.query.input).pipe(
          Effect.mapError(() => new RpcError({ type: "rpc.invalid_input", message: "Invalid JSON RPC input" })),
        )
        yield* rpc
          .connect(ctx.params.rpcID, ctx.params.method, input, Effect.orDie(ctx.request.upgrade))
          .pipe(Effect.mapError(rpcError))
        return HttpServerResponse.empty()
      }).pipe(
        Effect.catchDefect((defect) =>
          Effect.logError("rpc connection failed", { rpc: ctx.params.rpcID, method: ctx.params.method, defect }).pipe(
            Effect.andThen(
              Effect.fail(new RpcInternalError({ type: "rpc.internal", message: "RPC connection failed" })),
            ),
          ),
        ),
      ),
    ),
)

function rpcError(error: Rpc.Failure) {
  if (error.type === "rpc.invalid_output" || error.type === "rpc.internal")
    return new RpcInternalError({ type: error.type, message: error.message })
  return new RpcError({
    type: error.type,
    message: error.message,
    ...(error.data === undefined ? {} : { data: error.data }),
  })
}
