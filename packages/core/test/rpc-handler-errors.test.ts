import { expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Rpc } from "@opencode/core/rpc"
import { AbsolutePath } from "@opencode/core/schema"
import { Effect, Layer, Logger, Schema } from "effect"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(Rpc.node, [
    Location.node.replace(Layer.succeed(Location.Service, location({ directory: AbsolutePath.make("/rpc-project") }))),
  ]),
)
const Broken = Rpc.define({
  id: "broken",
  methods: {
    dies: { input: Schema.Undefined, output: Schema.String },
    throws: { input: Schema.Undefined, output: Schema.String },
    raw: { input: Schema.Undefined, output: Schema.String },
    undeclared: { input: Schema.Undefined, output: Schema.String },
    invalidError: {
      input: Schema.Undefined,
      output: Schema.String,
      errors: { known: Schema.Struct({ count: Schema.Int }) },
    },
  },
  events: {},
})

for (const method of ["dies", "throws", "raw", "undeclared", "invalidError"] as const) {
  it.effect(`recovers from ${method} through the typed rpc.internal failure`, () =>
    Effect.gen(function* () {
      const rpc = yield* Rpc.Service
      yield* rpc.register(Broken, {
        dies: () => Effect.die(new Error("handler defect")),
        throws: () => {
          throw new Error("handler threw")
        },
        // Raw Promise rejections reach this boundary as failed Effects.
        // @ts-expect-error intentionally exercise an undeclared failure
        raw: () => Effect.fail(new Error("raw failure")),
        // @ts-expect-error intentionally exercise an undeclared error name
        undeclared: (_input, context) => Effect.fail(context.error("unknown", "Unknown")),
        invalidError: (_input, context) => Effect.fail(context.error("known", "Invalid count", { count: 1.5 })),
      })
      const logged: unknown[] = []
      const result = yield* rpc
        .client(Broken)
        [method]()
        .pipe(
          Effect.catchIf(
            (error) => "type" in error && error.type === "rpc.internal",
            (error) => Effect.succeed(error),
          ),
          Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => logged.push(entry.message))])),
        )
      expect(result).toEqual({ type: "rpc.internal", message: "RPC call failed" })
      expect(logged).toHaveLength(1)
    }),
  )
}

it.effect("duplex RPC validates transport and input before acquiring a socket", () =>
  Effect.gen(function* () {
    const rpc = yield* Rpc.Service
    const definition = Rpc.define({
      id: "duplex",
      methods: {
        connect: { input: Schema.String, output: Schema.Void, duplex: true, errors: { denied: Schema.Void } },
        ordinary: { input: Schema.Void, output: Schema.Void },
      },
      events: {},
    })
    yield* rpc.register(definition, {
      connect: (_input, context) => Effect.fail(context.error("denied", "Attachment unavailable")),
      ordinary: () => Effect.void,
    })
    const socket = Effect.die(new Error("Must not upgrade this request"))
    expect(yield* rpc.call("duplex", "connect", "hello").pipe(Effect.flip)).toMatchObject({ type: "rpc.invalid_input" })
    expect(yield* rpc.connect("duplex", "ordinary", undefined, socket).pipe(Effect.flip)).toMatchObject({
      type: "rpc.invalid_input",
    })
    expect(yield* rpc.connect("duplex", "missing", "hello", socket).pipe(Effect.flip)).toMatchObject({
      type: "rpc.method_not_found",
    })
    expect(yield* rpc.connect("duplex", "connect", 42, socket).pipe(Effect.flip)).toMatchObject({
      type: "rpc.invalid_input",
    })
    expect(yield* rpc.connect("duplex", "connect", "hello", socket).pipe(Effect.flip)).toEqual({
      type: "denied",
      message: "Attachment unavailable",
    })
    expect(Object.hasOwn(rpc.client(definition), "connect")).toBe(false)
  }),
)
