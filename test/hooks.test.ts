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
