import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readMeta, hasIndex, isStale } from "../src/staleness.js"

function gitInit(dir: string): string {
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] })
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] })
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] })
  execFileSync("git", ["commit", "--allow-empty", "-m", "init", "-q"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] })
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim()
}

function writeMeta(dir: string, lastCommit: string) {
  mkdirSync(join(dir, ".gitnexus"), { recursive: true })
  writeFileSync(
    join(dir, ".gitnexus", "meta.json"),
    JSON.stringify({ lastCommit, indexedAt: new Date().toISOString(), repoPath: dir }),
  )
}

describe("readMeta", () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "gitnexus-stale-"))
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it("returns null when meta file is missing", () => {
    assert.equal(readMeta(repo), null)
  })

  it("returns null on malformed JSON", () => {
    mkdirSync(join(repo, ".gitnexus"))
    writeFileSync(join(repo, ".gitnexus", "meta.json"), "{ broken")
    assert.equal(readMeta(repo), null)
  })

  it("parses well-formed meta", () => {
    writeMeta(repo, "abc1234")
    const meta = readMeta(repo)
    assert.ok(meta)
    assert.equal(meta!.lastCommit, "abc1234")
  })
})

describe("hasIndex", () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "gitnexus-hasindex-"))
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it("false when no meta.json", () => {
    assert.equal(hasIndex(repo), false)
  })

  it("true when meta.json exists", () => {
    writeMeta(repo, "any")
    assert.equal(hasIndex(repo), true)
  })
})

describe("isStale", () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "gitnexus-isstale-"))
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it("false when no index", () => {
    gitInit(repo)
    assert.equal(isStale(repo), false)
  })

  it("false when HEAD matches meta.lastCommit", () => {
    const head = gitInit(repo)
    writeMeta(repo, head)
    assert.equal(isStale(repo), false)
  })

  it("true when HEAD differs from meta.lastCommit", () => {
    gitInit(repo)
    writeMeta(repo, "0000000000000000000000000000000000000000")
    assert.equal(isStale(repo), true)
  })
})
