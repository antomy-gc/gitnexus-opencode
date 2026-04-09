import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, gitnexusCmd } from "../src/config.js"

describe("loadConfig", () => {
  let tmpProject: string

  beforeEach(() => {
    tmpProject = mkdtempSync(join(tmpdir(), "gitnexus-test-"))
    mkdirSync(join(tmpProject, ".opencode"))
  })

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true })
  })

  it("returns defaults when no project config file exists", () => {
    const cfg = loadConfig(tmpProject)
    assert.equal(cfg.autoRefreshStale, true)
    assert.equal(cfg.autoRefreshOnCommit, true)
    assert.ok(cfg.gitnexusVersion.length > 0)
  })

  it("project config overrides defaults", () => {
    writeFileSync(
      join(tmpProject, ".opencode", "gitnexus-opencode.json"),
      JSON.stringify({ gitnexusVersion: "2.0.0", autoRefreshStale: false }),
    )
    const cfg = loadConfig(tmpProject)
    assert.equal(cfg.gitnexusVersion, "2.0.0")
    assert.equal(cfg.autoRefreshStale, false)
    // Unspecified field keeps default
    assert.equal(cfg.autoRefreshOnCommit, true)
  })

  it("malformed config is silently ignored, defaults returned", () => {
    writeFileSync(
      join(tmpProject, ".opencode", "gitnexus-opencode.json"),
      "{ broken json",
    )
    const cfg = loadConfig(tmpProject)
    assert.equal(cfg.autoRefreshStale, true)
    assert.equal(cfg.autoRefreshOnCommit, true)
  })
})

describe("gitnexusCmd", () => {
  it("uses pinned version by default", () => {
    const cmd = gitnexusCmd({
      gitnexusVersion: "1.5.2",
      autoRefreshStale: true,
      autoRefreshOnCommit: true,
    })
    assert.deepEqual(cmd, ["npx", "-y", "gitnexus@1.5.2"])
  })

  it("uses bare package name when version is 'latest'", () => {
    const cmd = gitnexusCmd({
      gitnexusVersion: "latest",
      autoRefreshStale: true,
      autoRefreshOnCommit: true,
    })
    assert.deepEqual(cmd, ["npx", "-y", "gitnexus"])
  })
})
