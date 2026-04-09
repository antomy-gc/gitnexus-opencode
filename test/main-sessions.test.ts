import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  trackSessionCreated,
  trackSessionDeleted,
  isMainSession,
  __resetMainSessions,
} from "../src/main-sessions.js"

describe("main-sessions registry", () => {
  beforeEach(() => __resetMainSessions())

  it("fresh state: no sessions are main", () => {
    assert.equal(isMainSession("X"), false)
  })

  it("trackSessionCreated with no parentID marks the session as main", () => {
    trackSessionCreated({ id: "X" })
    assert.equal(isMainSession("X"), true)
  })

  it("trackSessionCreated with parentID does NOT mark as main (it is a subagent)", () => {
    trackSessionCreated({ id: "Y", parentID: "X" })
    assert.equal(isMainSession("Y"), false)
  })

  it("trackSessionDeleted removes a previously tracked main session", () => {
    trackSessionCreated({ id: "X" })
    assert.equal(isMainSession("X"), true)
    trackSessionDeleted({ id: "X" })
    assert.equal(isMainSession("X"), false)
  })

  it("multiple main sessions are tracked independently", () => {
    trackSessionCreated({ id: "A" })
    trackSessionCreated({ id: "B" })
    trackSessionCreated({ id: "C" })
    assert.equal(isMainSession("A"), true)
    assert.equal(isMainSession("B"), true)
    assert.equal(isMainSession("C"), true)
    trackSessionDeleted({ id: "B" })
    assert.equal(isMainSession("A"), true)
    assert.equal(isMainSession("B"), false)
    assert.equal(isMainSession("C"), true)
  })

  it("__resetMainSessions clears every tracked session", () => {
    trackSessionCreated({ id: "A" })
    trackSessionCreated({ id: "B" })
    __resetMainSessions()
    assert.equal(isMainSession("A"), false)
    assert.equal(isMainSession("B"), false)
  })

  it("deleting an unknown session is a no-op (no error)", () => {
    assert.doesNotThrow(() => trackSessionDeleted({ id: "never-existed" }))
    assert.equal(isMainSession("never-existed"), false)
  })
})
