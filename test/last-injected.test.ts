import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createLastInjectedRegistry, type LastInjectedRegistry } from "../src/last-injected.js"

describe("LastInjectedRegistry", () => {
  let registry: LastInjectedRegistry
  beforeEach(() => {
    registry = createLastInjectedRegistry()
  })

  it("fresh state: get returns undefined for any session", () => {
    assert.equal(registry.get("X"), undefined)
  })

  it("set then get returns the stored envelope", () => {
    registry.set("X", "<gitnexus_graph>v1</gitnexus_graph>")
    assert.equal(registry.get("X"), "<gitnexus_graph>v1</gitnexus_graph>")
  })

  it("set overwrites previous value for the same session", () => {
    registry.set("X", "v1")
    registry.set("X", "v2")
    assert.equal(registry.get("X"), "v2")
  })

  it("clear removes the entry; subsequent get returns undefined", () => {
    registry.set("X", "v1")
    registry.clear("X")
    assert.equal(registry.get("X"), undefined)
  })

  it("clear of unknown session is a no-op", () => {
    assert.doesNotThrow(() => registry.clear("never-set"))
  })

  it("sessions are independent", () => {
    registry.set("A", "envA")
    registry.set("B", "envB")
    assert.equal(registry.get("A"), "envA")
    assert.equal(registry.get("B"), "envB")
    registry.clear("A")
    assert.equal(registry.get("A"), undefined)
    assert.equal(registry.get("B"), "envB")
  })

  it("reset wipes every session", () => {
    registry.set("A", "envA")
    registry.set("B", "envB")
    registry.reset()
    assert.equal(registry.get("A"), undefined)
    assert.equal(registry.get("B"), undefined)
  })

  it("two registries do not share state", () => {
    const a = createLastInjectedRegistry()
    const b = createLastInjectedRegistry()
    a.set("same-id", "from-a")
    assert.equal(a.get("same-id"), "from-a")
    assert.equal(b.get("same-id"), undefined)
  })

  it("empty-string envelope is a valid stored value (distinct from absence)", () => {
    registry.set("X", "")
    assert.equal(registry.get("X"), "")
  })
})
