import { spawn, spawnSync, type ChildProcess } from "node:child_process"

const windows = process.platform === "win32"
const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawn(process.execPath, args, { stdio: "inherit", detached: !windows, env })

const children = [
  run(["--watch", "src/main.ts"], { ...process.env, PUBLIC_URL: "http://localhost:5173" }),
  run(["node_modules/vite/bin/vite.js", "--config", "web/vite.config.ts"]),
]

function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return
  if (windows) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"])
  else process.kill(-child.pid)
}

function stop(code: number | null) {
  children.forEach(kill)
  process.exit(code ?? 0)
}

children.forEach((child) => child.once("exit", stop))
process.on("SIGINT", () => stop(130))
process.on("SIGTERM", () => stop(143))
