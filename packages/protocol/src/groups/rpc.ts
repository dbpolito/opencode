import { optional } from "@opencode/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { RpcError, RpcInternalError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export const RpcInput = Schema.Struct({ input: optional(Schema.Unknown) }).annotate({ identifier: "Rpc.Input" })
export const RpcOutput = Schema.Struct({ output: Schema.optionalKey(Schema.Unknown) }).annotate({
  identifier: "Rpc.Output",
})

export const RpcGroup = HttpApiGroup.make("server.rpc")
  .add(
    HttpApiEndpoint.post("rpc.call", "/api/rpc/:rpcID/:method", {
      params: { rpcID: Schema.String, method: Schema.String },
      query: LocationQuery,
      payload: RpcInput,
      success: RpcOutput,
      error: [RpcError, RpcInternalError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "rpc.call",
          summary: "Call a plugin RPC",
          description: "Dispatch a method to the currently registered RPC at the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("rpc.connect", "/api/rpc/:rpcID/:method/connect", {
      params: { rpcID: Schema.String, method: Schema.String },
      query: { ...LocationQuery.fields, input: Schema.String },
      success: Schema.Void,
      error: [RpcError, RpcInternalError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "rpc.connect",
          summary: "Connect to a duplex plugin RPC",
          description: "Authenticated WebSocket; input is a JSON-encoded query parameter validated by the plugin.",
          transform: (operation) => ({ ...operation, "x-websocket": true }),
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "rpc", description: "Plugin RPC routes." }))
