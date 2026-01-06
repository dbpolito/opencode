// @refresh reload
import { render } from "solid-js/web"
import { App, PlatformProvider, Platform } from "@opencode-ai/app"
import { open, save } from "@tauri-apps/plugin-dialog"
import { openUrl as shellOpen } from "@tauri-apps/plugin-opener"
import { AsyncStorage } from "@solid-primitives/storage"
import { fetch as tauriFetch } from "@tauri-apps/plugin-http"
import { Store } from "@tauri-apps/plugin-store"
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification"

// For mobile, inject the server URL via query parameter
// The app.tsx checks for ?url= parameter first
const serverUrl = `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "192.168.1.179"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`

// Add the server URL as a query parameter so app.tsx picks it up
if (!window.location.search.includes("url=")) {
  const url = new URL(window.location.href)
  url.searchParams.set("url", serverUrl)
  window.history.replaceState({}, "", url.toString())
}

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",
  )
}

const platform: Platform = {
  platform: "tauri",
  version: "0.0.1",

  async openDirectoryPickerDialog(opts) {
    const result = await open({
      directory: true,
      multiple: opts?.multiple ?? false,
      title: opts?.title ?? "Choose a folder",
    })
    return result
  },

  async openFilePickerDialog(opts) {
    const result = await open({
      directory: false,
      multiple: opts?.multiple ?? false,
      title: opts?.title ?? "Choose a file",
    })
    return result
  },

  async saveFilePickerDialog(opts) {
    const result = await save({
      title: opts?.title ?? "Save file",
      defaultPath: opts?.defaultPath,
    })
    return result
  },

  openLink(url: string) {
    void shellOpen(url).catch(() => undefined)
  },

  async restart() {
    window.location.reload()
  },

  storage: (name = "default.dat") => {
    type StoreLike = {
      get(key: string): Promise<string | null | undefined>
      set(key: string, value: string): Promise<unknown>
      delete(key: string): Promise<unknown>
      clear(): Promise<unknown>
      keys(): Promise<string[]>
      length(): Promise<number>
    }

    const memory = () => {
      const data = new Map<string, string>()
      const store: StoreLike = {
        get: async (key) => data.get(key),
        set: async (key, value) => {
          data.set(key, value)
        },
        delete: async (key) => {
          data.delete(key)
        },
        clear: async () => {
          data.clear()
        },
        keys: async () => Array.from(data.keys()),
        length: async () => data.size,
      }
      return store
    }

    const api: AsyncStorage & { _store: Promise<StoreLike> | null; _getStore: () => Promise<StoreLike> } = {
      _store: null,
      _getStore: async () => {
        if (api._store) return api._store
        api._store = Store.load(name).catch(() => memory())
        return api._store
      },
      getItem: async (key: string) => {
        const store = await api._getStore()
        const value = await store.get(key).catch(() => null)
        if (value === undefined) return null
        return value
      },
      setItem: async (key: string, value: string) => {
        const store = await api._getStore()
        await store.set(key, value).catch(() => undefined)
      },
      removeItem: async (key: string) => {
        const store = await api._getStore()
        await store.delete(key).catch(() => undefined)
      },
      clear: async () => {
        const store = await api._getStore()
        await store.clear().catch(() => undefined)
      },
      key: async (index: number) => {
        const store = await api._getStore()
        return (await store.keys().catch(() => []))[index]
      },
      getLength: async () => {
        const store = await api._getStore()
        return await store.length().catch(() => 0)
      },
      get length() {
        return api.getLength()
      },
    }
    return api
  },

  notify: async (title, description) => {
    const granted = await isPermissionGranted().catch(() => false)
    const permission = granted ? "granted" : await requestPermission().catch(() => "denied")
    if (permission !== "granted") return

    await Promise.resolve()
      .then(() => {
        new Notification(title, {
          body: description ?? "",
          icon: "https://opencode.ai/favicon-96x96.png",
        })
      })
      .catch(() => undefined)
  },

  // Use native fetch - tauriFetch doesn't support SSE streams properly
  fetch: window.fetch.bind(window),
}

render(() => {
  return (
    <PlatformProvider value={platform}>
      <App />
    </PlatformProvider>
  )
}, root!)
