import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createSessionRegistry, type SessionRegistry } from "../src/sessions.js"

describe("SessionRegistry", () => {
  let registry: SessionRegistry
  beforeEach(() => {
    registry = createSessionRegistry()
  })

  it("fresh state: unknown sessions default to main (safer failure mode after plugin reload)", () => {
    assert.equal(registry.isMain("X"), true)
  })

  it("trackCreated with no parentID leaves the session as main (default)", () => {
    registry.trackCreated({ id: "X" })
    assert.equal(registry.isMain("X"), true)
  })

  it("trackCreated with parentID marks the session as a subagent (not main)", () => {
    registry.trackCreated({ id: "Y", parentID: "X" })
    assert.equal(registry.isMain("Y"), false)
  })

  it("trackDeleted reverts a subagent back to default-main", () => {
    registry.trackCreated({ id: "Y", parentID: "X" })
    assert.equal(registry.isMain("Y"), false)
    registry.trackDeleted({ id: "Y" })
    assert.equal(registry.isMain("Y"), true)
  })

  it("multiple subagents are tracked independently", () => {
    registry.trackCreated({ id: "A", parentID: "main" })
    registry.trackCreated({ id: "B", parentID: "main" })
    registry.trackCreated({ id: "C", parentID: "main" })
    assert.equal(registry.isMain("A"), false)
    assert.equal(registry.isMain("B"), false)
    assert.equal(registry.isMain("C"), false)
    registry.trackDeleted({ id: "B" })
    assert.equal(registry.isMain("A"), false)
    assert.equal(registry.isMain("B"), true)
    assert.equal(registry.isMain("C"), false)
  })

  it("reset clears every tracked subagent (everything reverts to default-main)", () => {
    registry.trackCreated({ id: "A", parentID: "main" })
    registry.trackCreated({ id: "B", parentID: "main" })
    registry.reset()
    assert.equal(registry.isMain("A"), true)
    assert.equal(registry.isMain("B"), true)
  })

  it("deleting an unknown session is a no-op (no error)", () => {
    assert.doesNotThrow(() => registry.trackDeleted({ id: "never-existed" }))
    assert.equal(registry.isMain("never-existed"), true)
  })

  it("two independent registries do not share state", () => {
    const a = createSessionRegistry()
    const b = createSessionRegistry()
    a.trackCreated({ id: "same-id", parentID: "x" })
    assert.equal(a.isMain("same-id"), false)
    assert.equal(b.isMain("same-id"), true)
  })

  it("hydration via repeated trackCreated: replaying a session.list() restores subagent classification", () => {
    const sessionsFromApi = [
      { id: "main-1" },
      { id: "sub-1", parentID: "main-1" },
      { id: "sub-2", parentID: "main-1" },
      { id: "main-2" },
    ]
    for (const s of sessionsFromApi) registry.trackCreated(s)
    assert.equal(registry.isMain("main-1"), true)
    assert.equal(registry.isMain("sub-1"), false)
    assert.equal(registry.isMain("sub-2"), false)
    assert.equal(registry.isMain("main-2"), true)
    assert.equal(registry.isMain("never-seen"), true)
  })
})
