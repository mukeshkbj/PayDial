import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const api = "http://localhost:8787"

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    proxy: { "/api": api, "/paypal": api, "/fake-paypal": api, "/mcp": api },
  },
})
