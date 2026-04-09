import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createMainSessionRegistry, type MainSessionRegistry } from "../src/main-sessions.js"

describe("MainSessionRegistry", () => {
  let registry: MainSessionRegistry
  beforeEach(() => {
    registry = createMainSessionRegistry()
  })

  it("fresh state: no sessions are main", () => {
    assert.equal(registry.isMain("X"), false)
  })

  it("trackCreated with no parentID marks the session as main", () => {
    registry.trackCreated({ id: "X" })
    assert.equal(registry.isMain("X"), true)
  })

  it("trackCreated with parentID does NOT mark as main (it is a subagent)", () => {
    registry.trackCreated({ id: "Y", parentID: "X" })
    assert.equal(registry.isMain("Y"), false)
  })

  it("trackDeleted removes a previously tracked main session", () => {
    registry.trackCreated({ id: "X" })
    assert.equal(registry.isMain("X"), true)
    registry.trackDeleted({ id: "X" })
    assert.equal(registry.isMain("X"), false)
  })

  it("multiple main sessions are tracked independently", () => {
    registry.trackCreated({ id: "A" })
    registry.trackCreated({ id: "B" })
    registry.trackCreated({ id: "C" })
    assert.equal(registry.isMain("A"), true)
    assert.equal(registry.isMain("B"), true)
    assert.equal(registry.isMain("C"), true)
    registry.trackDeleted({ id: "B" })
    assert.equal(registry.isMain("A"), true)
    assert.equal(registry.isMain("B"), false)
    assert.equal(registry.isMain("C"), true)
  })

  it("reset clears every tracked session", () => {
    registry.trackCreated({ id: "A" })
    registry.trackCreated({ id: "B" })
    registry.reset()
    assert.equal(registry.isMain("A"), false)
    assert.equal(registry.isMain("B"), false)
  })

  it("deleting an unknown session is a no-op (no error)", () => {
    assert.doesNotThrow(() => registry.trackDeleted({ id: "never-existed" }))
    assert.equal(registry.isMain("never-existed"), false)
  })

  it("two independent registries do not share state", () => {
    const a = createMainSessionRegistry()
    const b = createMainSessionRegistry()
    a.trackCreated({ id: "same-id" })
    assert.equal(a.isMain("same-id"), true)
    // b has not seen this id
    assert.equal(b.isMain("same-id"), false)
  })
})
