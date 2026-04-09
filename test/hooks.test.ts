import { describe, it } from "node:test"
import assert from "node:assert/strict"

// Inlined copy of the production regex from src/hooks.ts.
// Keep in sync if the regex is updated there.
const GIT_MUTATION_RE =
  /(?:^|[;&|]\s*)(?:\w+=\S+\s+)*git(?:\s+-C\s+\S+|\s+--\S+(?:=\S+)?)*\s+(commit|merge|rebase|pull|cherry-pick|switch|reset)\b/

describe("GIT_MUTATION_RE", () => {
  const positive = [
    "git commit -m 'fix'",
    "git merge feature",
    "git rebase main",
    "git pull origin main",
    "git cherry-pick abc1234",
    "git switch main",
    "git reset --hard HEAD~1",
    "git -C /path/to/repo commit",
    "GIT_DIR=/tmp git commit",
    "git --work-tree=/foo reset --hard",
  ]
  const negative = [
    "git status",
    "git log --oneline",
    "git diff",
    "git show HEAD",
    "echo 'just a commit'",
    "git checkout -- file.txt",
    "cat gitcommit.md",
    "mygit commit",
  ]

  for (const cmd of positive) {
    it(`matches: ${cmd}`, () => {
      assert.ok(GIT_MUTATION_RE.test(cmd), `expected match: ${cmd}`)
    })
  }
  for (const cmd of negative) {
    it(`does not match: ${cmd}`, () => {
      assert.ok(!GIT_MUTATION_RE.test(cmd), `expected no match: ${cmd}`)
    })
  }
})

// -----------------------------------------------------------------------
// extractGitDashCPath — parses `git -C <target>` out of a bash command and
// resolves it to a real git root. The resolve step uses findGitRoot which
// actually runs `git rev-parse`, so these tests rely on the gitnexus-opencode
// repo root itself (the test runs from the package directory).
// -----------------------------------------------------------------------
import { extractGitDashCPath } from "../src/hooks.js"
import { execFileSync } from "node:child_process"

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: process.cwd(),
  encoding: "utf-8",
}).trim()

describe("extractGitDashCPath", () => {
  it("returns the repo root when `-C <abs-root>` points to a real repo", () => {
    assert.equal(
      extractGitDashCPath(`git -C ${REPO_ROOT} commit -m fix`, "/tmp"),
      REPO_ROOT,
    )
  })

  it("returns null when there is no `-C` flag", () => {
    assert.equal(extractGitDashCPath("git commit -m fix", REPO_ROOT), null)
  })

  it("returns null when `-C` points to a non-repo path", () => {
    assert.equal(extractGitDashCPath("git -C /tmp commit -m fix", REPO_ROOT), null)
  })

  it("handles quoted paths with spaces (no spaces in our test repo, but parser must accept)", () => {
    // Parser should accept the quoted form even if the target does not exist.
    // The result is null because the parsed target is not a real repo, but
    // the important assertion is that parsing did not throw.
    assert.doesNotThrow(() =>
      extractGitDashCPath('git -C "/some/other path" commit', "/tmp"),
    )
  })

  it("handles leading env var assignments", () => {
    assert.equal(
      extractGitDashCPath(`GIT_DIR=/tmp git -C ${REPO_ROOT} commit`, "/tmp"),
      REPO_ROOT,
    )
  })

  it("resolves relative paths against cwd", () => {
    // Running the test from REPO_ROOT itself, `.` relative to cwd=REPO_ROOT
    // still resolves to REPO_ROOT (findGitRoot walks up).
    assert.equal(
      extractGitDashCPath("git -C . commit", REPO_ROOT),
      REPO_ROOT,
    )
  })

  it("returns null on empty command", () => {
    assert.equal(extractGitDashCPath("", REPO_ROOT), null)
  })

  it("returns null when -C is followed by nothing parseable", () => {
    // `git -C` with no target after it -> match fails, returns null.
    assert.equal(extractGitDashCPath("git -C", REPO_ROOT), null)
  })
})
