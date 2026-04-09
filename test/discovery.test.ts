import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverRepos } from "../src/discovery.js"

function gitInit(dir: string) {
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] })
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] })
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] })
  execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] })
}

describe("discoverRepos", () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "gitnexus-discover-"))
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("returns empty list for non-git directory with no children", () => {
    const repos = discoverRepos(tmpRoot)
    assert.deepEqual(repos, [])
  })

  it("detects single repo when parentDir is itself a git repo", () => {
    gitInit(tmpRoot)
    const repos = discoverRepos(tmpRoot)
    assert.equal(repos.length, 1)
    assert.equal(repos[0]!.path, tmpRoot)
    assert.equal(repos[0]!.hasIndex, false)
  })

  it("detects multiple child repos one level deep", () => {
    const alpha = join(tmpRoot, "alpha")
    const beta = join(tmpRoot, "beta")
    mkdirSync(alpha)
    mkdirSync(beta)
    gitInit(alpha)
    gitInit(beta)

    const repos = discoverRepos(tmpRoot)
    const names = repos.map((r) => r.name).sort()
    assert.deepEqual(names, ["alpha", "beta"])
  })

  it("calls onError callback for unreadable root dir", () => {
    const bogus = join(tmpRoot, "does-not-exist")
    let reported = ""
    const repos = discoverRepos(bogus, (msg) => {
      reported = msg
    })
    assert.deepEqual(repos, [])
    assert.match(reported, /Cannot read/)
  })
})
