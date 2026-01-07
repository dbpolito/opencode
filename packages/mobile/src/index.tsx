// @refresh reload
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface, PlatformProvider, Platform } from "@opencode-ai/app"
import { open, save } from "@tauri-apps/plugin-dialog"
import { openUrl as shellOpen } from "@tauri-apps/plugin-opener"
import { AsyncStorage } from "@solid-primitives/storage"
import { Store } from "@tauri-apps/plugin-store"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"

// For mobile, inject the server URL via query parameter
// The app.tsx checks for ?url= parameter first
// Set OPENCODE_SERVER_HOST env var to your Mac's IP for physical device testing
const serverUrl = `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`

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
  platform: "desktop",
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

  storage: (() => {
    type StoreLike = {
      get(key: string): Promise<string | null | undefined>
      set(key: string, value: string): Promise<unknown>
      delete(key: string): Promise<unknown>
      clear(): Promise<unknown>
      keys(): Promise<string[]>
      length(): Promise<number>
    }

    const storeCache = new Map<string, Promise<StoreLike>>()
    const apiCache = new Map<string, AsyncStorage>()
    const memoryCache = new Map<string, StoreLike>()

    const createMemoryStore = () => {
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

    const getStore = (name: string) => {
      const cached = storeCache.get(name)
      if (cached) return cached

      const store = Store.load(name).catch(() => {
        const cached = memoryCache.get(name)
        if (cached) return cached

        const memory = createMemoryStore()
        memoryCache.set(name, memory)
        return memory
      })

      storeCache.set(name, store)
      return store
    }

    const createStorage = (name: string): AsyncStorage => {
      const api: AsyncStorage = {
        getItem: async (key: string) => {
          const store = await getStore(name)
          const value = await store.get(key).catch(() => null)
          if (value === undefined) return null
          return value
        },
        setItem: async (key: string, value: string) => {
          const store = await getStore(name)
          await store.set(key, value).catch(() => undefined)
        },
        removeItem: async (key: string) => {
          const store = await getStore(name)
          await store.delete(key).catch(() => undefined)
        },
        clear: async () => {
          const store = await getStore(name)
          await store.clear().catch(() => undefined)
        },
        key: async (index: number) => {
          const store = await getStore(name)
          return (await store.keys().catch(() => []))[index]
        },
        getLength: async () => {
          const store = await getStore(name)
          return await store.length().catch(() => 0)
        },
        get length() {
          return api.getLength()
        },
      }
      return api
    }

    return (name = "default.dat") => {
      const cached = apiCache.get(name)
      if (cached) return cached

      const api = createStorage(name)
      apiCache.set(name, api)
      return api
    }
  })(),

  notify: async (title, description) => {
    const granted = await isPermissionGranted().catch(() => false)
    const permission = granted ? "granted" : await requestPermission().catch(() => "denied")
    if (permission !== "granted") return

    try {
      sendNotification({ title, body: description ?? "" })
    } catch {
      // Notification failed silently
    }
  },

  // Use native fetch - tauriFetch doesn't support SSE streams properly
  fetch: window.fetch.bind(window),
}

render(() => {
  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders>
        <AppInterface />
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root!)
