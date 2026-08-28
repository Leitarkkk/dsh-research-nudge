import test from 'node:test'
import assert from 'node:assert/strict'

// Tests import the built JS, so run `npm run build` before `npm test`.
import {
  defaultPolicy, isResearchTool, newState, recordResearch,
  recordTool, shouldNudge, snoozeResearchNudges,
} from '../lib/policy.js'

test('research tool recognition is normalization tolerant', () => {
  assert.equal(isResearchTool('WebSearch', ['web_search']), true)
  assert.equal(isResearchTool('github-search', ['github_search']), true)
  assert.equal(isResearchTool('str_replace_editor', ['web_search']), false)
})

test('ordinary calls accumulate debt and trigger call threshold', () => {
  const cfg = {...defaultPolicy, maxToolCallsWithoutResearch: 3, debtThreshold: 999}
  const s = newState(0)
  recordTool(s, cfg, 'read_file', true, null, 1)
  recordTool(s, cfg, 'read_file', true, null, 2)
  assert.equal(shouldNudge(s, cfg, 2), false)
  recordTool(s, cfg, 'read_file', true, null, 3)
  assert.equal(shouldNudge(s, cfg, 3), true)
})

test('repeated failures are expensive', () => {
  const cfg = {...defaultPolicy, debtThreshold: 10, maxToolCallsWithoutResearch: 999, maxMinutesWithoutResearch: 999}
  const s = newState(0)
  recordTool(s, cfg, 'bash', false, 'TypeError at line 123', 1)
  recordTool(s, cfg, 'bash', false, 'TypeError at line 456', 2)
  assert.ok(s.repeatedFailures >= 1)
  assert.equal(shouldNudge(s, cfg, 2), true)
})

test('research resets debt', () => {
  const s = newState(0)
  s.debt = 99
  s.callsSinceResearch = 50
  recordResearch(s, 100)
  assert.equal(s.debt, 0)
  assert.equal(s.callsSinceResearch, 0)
  assert.equal(s.lastResearchAt, 100)
})

test('snooze suppresses nudges without erasing debt and expires exactly on time', () => {
  const cfg = { ...defaultPolicy, debtThreshold: 1, maxToolCallsWithoutResearch: 1, maxMinutesWithoutResearch: 999 }
  const s = newState(0)
  recordTool(s, cfg, 'read_file', true, null, 1)
  assert.equal(shouldNudge(s, cfg, 1), true)
  snoozeResearchNudges(s, 10, 1)
  assert.ok(s.debt > 0, 'snooze must preserve accumulated debt')
  assert.equal(shouldNudge(s, cfg, 600_000), false)
  assert.equal(shouldNudge(s, cfg, 600_001), true)
})

test('elapsed-time threshold and cooldown use their configured boundaries', () => {
  const cfg = { ...defaultPolicy, maxMinutesWithoutResearch: 1, cooldownMinutes: 10, debtThreshold: 999, maxToolCallsWithoutResearch: 999 }
  const s = newState(0)
  assert.equal(shouldNudge(s, cfg, 59_999), false)
  assert.equal(shouldNudge(s, cfg, 60_000), true)
  s.lastNudgeAt = 60_000
  assert.equal(shouldNudge(s, cfg, 659_999), false)
  assert.equal(shouldNudge(s, cfg, 660_000), true)
})
