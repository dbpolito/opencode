import { defineConfig } from "vite"
import appPlugin from "@opencode-ai/app/vite"

const host = process.env.TAURI_DEV_HOST || "0.0.0.0"
// For iOS dev, set the OpenCode server host to your Mac's IP
const serverHost = process.env.OPENCODE_SERVER_HOST || "192.168.1.179"

export default defineConfig({
  plugins: [appPlugin],
  clearScreen: false,
  define: {
    "import.meta.env.VITE_OPENCODE_SERVER_HOST": JSON.stringify(serverHost),
    "import.meta.env.VITE_OPENCODE_SERVER_PORT": JSON.stringify("4096"),
  },
  esbuild: {
    keepNames: true,
  },
  server: {
    port: 1430,
    strictPort: true,
    host,
    hmr: {
      protocol: "ws",
      host: process.env.TAURI_DEV_HOST || "localhost",
      port: 1431,
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
})
