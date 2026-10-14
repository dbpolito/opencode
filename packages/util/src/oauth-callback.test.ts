import { expect, test } from "bun:test"
import { Effect } from "effect"
import { OAuthCallback } from "./oauth-callback.js"

test.each([false, true])("loopback callback waits for server confirmation (fixed URI: %s)", async (fixed) => {
  const initial = await Effect.runPromise(OAuthCallback.listen())
  const receiver = fixed
    ? await (async () => {
        initial.close()
        const receiver = await Effect.runPromise(
          OAuthCallback.listen({ redirectURI: initial.redirectURI.replace("/callback", "/custom") }),
        )
        expect(receiver.redirectURI).toBe(initial.redirectURI.replace("/callback", "/custom"))
        return receiver
      })()
    : initial
  const url = `${receiver.redirectURI}?code=accepted&state=state&iss=https%3A%2F%2Fissuer.test`
  const response = fetch(url)
  expect((await Effect.runPromise(receiver.callback)).url.href).toBe(url)
  receiver.close({ status: 200, contentType: "text/plain", body: "Signed in" })
  const page = await response
  expect(page.status).toBe(200)
  expect(await page.text()).toBe("Signed in")
})

test("closing a loopback callback receiver releases the pending waiter", async () => {
  const receiver = await Effect.runPromise(OAuthCallback.listen())
  receiver.close()
  await expect(Effect.runPromise(receiver.callback)).rejects.toThrow("OAuth callback receiver closed")
})
