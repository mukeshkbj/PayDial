import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"

const PRIVATE = [
  "launch",
  "docs/hillclimb",
  "docs/plans",
  "docs/research/2026-10-19-feature-candidates.md",
  "docs/research/2026-10-19-feature-pitches.md",
  "docs/research/research-landscape.md",
  "docs/research/research-platform.md",
  "docs/research/research-winners.md",
  "CLAUDE.md",
  "progress.md",
]

const index = ".git/public-index"
const env = { ...process.env, GIT_INDEX_FILE: index }
const git = (args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => execFileSync("git", args, { encoding: "utf8", ...options }).trim()

const source = process.argv[2] ?? "dial"
const head = git(["rev-parse", "--short", source])
const parent = (() => {
  try {
    return git(["rev-parse", "--verify", "--quiet", "refs/heads/main"])
  } catch {
    return ""
  }
})()

try {
  git(["read-tree", source], { env })
  git(["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", ...PRIVATE], { env })
  const tree = git(["write-tree"], { env })
  if (parent && git(["rev-parse", `${parent}^{tree}`]) === tree) {
    console.log(`main already matches ${source} ${head}`)
    process.exit(0)
  }
  const commit = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `Public tree from ${source} ${head}`])
  git(["update-ref", "refs/heads/main", commit])
  console.log(`main is now ${commit.slice(0, 7)}, the public tree of ${source} ${head}`)
} finally {
  rmSync(index, { force: true })
}
