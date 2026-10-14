import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export const OAuthRpcs = RpcGroup.make(
  Rpc.make("OAuthListen", {
    payload: { redirectURI: Schema.optional(Schema.String) },
    success: Schema.Struct({ token: Schema.String, redirectURI: Schema.String }),
  }),
  Rpc.make("OAuthCallback", { payload: { token: Schema.String }, success: Schema.String }),
  Rpc.make("OAuthClose", {
    payload: {
      token: Schema.String,
      result: Schema.optional(Schema.Struct({ success: Schema.Boolean, message: Schema.String })),
    },
  }),
)
