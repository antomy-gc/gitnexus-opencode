import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildAgentContext, buildUserToast } from "../src/context.js"
import type { RepoInfo } from "../src/discovery.js"

const stubBehind = (_: string) => 3

describe("buildAgentContext", () => {
  it("returns null for empty repo list", () => {
    assert.equal(buildAgentContext([], stubBehind), null)
  })

  it("lists indexed up-to-date repos", () => {
    const repos: RepoInfo[] = [
      { name: "alpha", path: "/tmp/alpha", hasIndex: true, isStale: false },
    ]
    const ctx = buildAgentContext(repos, stubBehind)
    assert.ok(ctx)
    assert.match(ctx!, /\[gitnexus\] Graph status:/)
    assert.match(ctx!, /Indexed: alpha \(up to date\)/)
    assert.doesNotMatch(ctx!, /Auto-refreshing/)
  })

  it("shows stale count from injected commitsBehindFn", () => {
    const repos: RepoInfo[] = [
      { name: "beta", path: "/tmp/beta", hasIndex: true, isStale: true },
    ]
    const ctx = buildAgentContext(repos, stubBehind)
    assert.ok(ctx)
    assert.match(ctx!, /beta \(stale, 3 commits behind\)/)
    assert.match(ctx!, /Auto-refreshing stale indexes in background/)
  })

  it("separates indexed and unindexed", () => {
    const repos: RepoInfo[] = [
      { name: "alpha", path: "/a", hasIndex: true, isStale: false },
      { name: "gamma", path: "/g", hasIndex: false, isStale: false },
    ]
    const ctx = buildAgentContext(repos, stubBehind)
    assert.ok(ctx)
    assert.match(ctx!, /Indexed: alpha \(up to date\)/)
    assert.match(ctx!, /Not indexed: gamma/)
  })
})

describe("buildUserToast", () => {
  it("returns null for empty list", () => {
    assert.equal(buildUserToast([]), null)
  })

  it("returns null when all repos are indexed and fresh", () => {
    const repos: RepoInfo[] = [
      { name: "a", path: "/a", hasIndex: true, isStale: false },
    ]
    assert.equal(buildUserToast(repos), null)
  })

  it("reports single stale repo (no plural)", () => {
    const repos: RepoInfo[] = [
      { name: "a", path: "/a", hasIndex: true, isStale: true },
    ]
    const toast = buildUserToast(repos)
    assert.equal(toast, "Knowledge graph: 1 stale repo. Ask agent to index.")
  })

  it("reports combined stale and unindexed with plural", () => {
    const repos: RepoInfo[] = [
      { name: "a", path: "/a", hasIndex: true, isStale: true },
      { name: "b", path: "/b", hasIndex: false, isStale: false },
    ]
    const toast = buildUserToast(repos)
    assert.equal(toast, "Knowledge graph: 1 stale, 1 unindexed repos. Ask agent to index.")
  })
})
