import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import path from "node:path"
import { app, BrowserWindow } from "electron"
import { Browser } from "@opencode/plugin-browser/rpc"
import { OpenCode } from "@opencode/client"
import { Schema } from "effect"
import { createBrowserPane } from "../../src/main/browser-pane"
import { openDatabase } from "../../src/main/storage/database"
import { createStateStore } from "../../src/main/storage/state"
import { Smoke } from "./contract"

process.on("uncaughtException", (error) => {
  console.error(error)
  app.exit(1)
})
process.on("unhandledRejection", (error) => {
  console.error(error)
  app.exit(1)
})

async function main() {
  app.setPath("userData", path.join(process.env.SMOKE_ROOT!, "electron-data"))
  // Only Chromium knows this hostname, simulating client-local dnsmasq.
  app.commandLine.appendSwitch("host-resolver-rules", "MAP browser-desktop.test 127.0.0.1")
  app.on("window-all-closed", () => {})
  await app.whenReady()
  const web = createServer((request, response) => {
    if (request.url === "/api") {
      response.end("desktop fetch proof")
      return
    }
    response.setHeader("content-type", "text/html")
    response.end('<button onclick="this.textContent=\'Clicked on desktop\'">Click me</button>')
  })
  await once(web.listen(0, "127.0.0.1"), "listening")
  const address = web.address()
  assert(address && typeof address !== "string")
  const url = `http://browser-desktop.test:${address.port}`
  const client = OpenCode.make({
    baseUrl: process.env.SMOKE_URL!,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${process.env.SMOKE_PASSWORD}`).toString("base64")}` },
  })
  const location = { directory: process.env.SMOKE_SERVER_FILES! }
  const rpc = client.rpc(Smoke)
  const session = await client.session.create({ title: "Desktop network", location })
  const database = openDatabase(path.join(process.env.SMOKE_ROOT!, "browser.sqlite"))
  const storage = createStateStore(database.db)
  const pane = createBrowserPane(storage)
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadURL("about:blank")
  async function call(action: Browser.Action) {
    const { type, ...input } = action
    const result = await rpc.execute(
      { sessionID: session.id, code: `return await tools.browser.${type}(${JSON.stringify(input)})` },
      { location },
    )
    assert(!result.error, result.output)
    return result.output
  }
  try {
    await pane.register(win, "desktop", {
      serverKey: "desktop-network-suite",
      sessionID: session.id,
      endpoint: { url: process.env.SMOKE_URL!, password: process.env.SMOKE_PASSWORD },
      network: "desktop",
    })
    assert.equal(
      Schema.decodeUnknownSync(Browser.State)(JSON.parse(await call({ type: "tabs.list" }))).network,
      "desktop",
    )
    const tab = Schema.decodeUnknownSync(Browser.Tab)(JSON.parse(await call({ type: "tabs.open", url })))
    assert.equal(tab.url, `${url}/`)
    assert.equal(tab.loadError, undefined)
    await call({ type: "evaluate", tabID: tab.id, script: "document.querySelector('button').click()" })
    assert.match(await call({ type: "snapshot", tabID: tab.id }), /Clicked on desktop/)
    assert.match(
      await call({ type: "evaluate", tabID: tab.id, script: "fetch('/api').then(response => response.text())" }),
      /desktop fetch proof/,
    )
    console.log("PASS desktop network with client-only DNS and no server tunnels")
  } finally {
    await pane.dispose()
    win.destroy()
    web.closeAllConnections()
    await new Promise<void>((resolve) => web.close(() => resolve()))
    storage.close()
    database.close()
  }
}

void main().then(() => app.exit(0), (error) => {
  console.error(error)
  app.exit(1)
})
