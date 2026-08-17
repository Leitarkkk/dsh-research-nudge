import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'

// Adapter tests simulate the `tools/post-execute` waterfall surface exactly as
// the DSH tool pipeline drives it (see dsh-tools postExecute). Tests import
// the built JS, so run `npm run build` before `npm test`.
import { apply, name as pluginName } from '../lib/index.js'

/** Minimal Cordis context capturing whatever the plugin registers. */
function makeCtx() {
  const listeners = new Map()
  return { ctx: { on(event, listener) { listeners.set(event, listener) } }, listeners }
}

function plugin(listeners) {
  return listeners.get('tools/post-execute')
}

/** Drive one finished tool execution through the waterfall. */
async function runTool(listener, agent, name, result, { downstream = { kind: 'accept' } } = {}) {
  const exec = execution(agent, name)
  return listener(exec, result, async () => downstream)
}

function execution(agent, name) {
  return {
    token: Symbol('tool'),
    callId: 'call-1',
    rootCallId: 'call-1',
    name,
    arguments: {},
    agent,
    signal: new AbortController().signal,
  }
}

function succeeded(text = 'ok') {
  return { isError: false, value: null, content: [{ type: 'text', text }] }
}

function nudgeOf(decision) {
  return decision.additionalContexts?.[0]
}

function failed(text) {
  return { isError: true, error: { message: text }, content: [{ type: 'text', text: `Error: ${text}` }] }
}

test('adapter registers a tools/post-execute listener', () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, {})
  assert.equal(listeners.has('tools/post-execute'), true)
})

test('enabled:false registers no listener', () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { enabled: false })
  assert.equal(listeners.has('tools/post-execute'), false)
})

test('tool-call-count threshold queues a nudge on the exact crossing call', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { maxToolCallsWithoutResearch: 5, debtThreshold: 999, maxMinutesWithoutResearch: 999 })
  const listener = plugin(listeners)
  const agent = {}
  const exec = execution(agent, 'read')

  for (let i = 0; i < 4; i += 1) {
    const decision = await listener(exec, succeeded(), async () => ({ kind: 'accept' }))
    assert.equal(nudgeOf(decision), undefined, `call ${i + 1} must not nudge yet`)
  }
  const decision = await listener(exec, succeeded(), async () => ({ kind: 'accept' }))
  assert.ok(nudgeOf(decision), '5th call must nudge')
  assert.equal(nudgeOf(decision).source.plugin, pluginName)
  assert.equal(nudgeOf(decision).role, 'user')
  assert.equal(nudgeOf(decision).content[0].type, 'text')
  assert.match(nudgeOf(decision).content[0].text, /\[Research Nudge\]/)
})

test('failure debt triggers a nudge on the crossing call', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { debtThreshold: 10, maxToolCallsWithoutResearch: 999, maxMinutesWithoutResearch: 999 })
  const listener = plugin(listeners)
  const agent = {}
  // 1 (ordinary) + 4 (failure) per distinct failing call: 5, then 10.
  const decision1 = await runTool(listener, agent, 'grep', failed('first error'))
  assert.equal(nudgeOf(decision1), undefined)
  const decision2 = await runTool(listener, agent, 'grep', failed('second error'))
  assert.ok(nudgeOf(decision2), 'debt threshold crossed on the 2nd distinct failing call')
  assert.match(nudgeOf(decision2).content[0].text, /debt=10\/10/)
})

test('repeated equivalent failures escalate through the adapter', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { debtThreshold: 20, maxToolCallsWithoutResearch: 999, maxMinutesWithoutResearch: 999 })
  const listener = plugin(listeners)
  const agent = {}
  // Identical failures: 5 debt, then 16 (+6 repeat penalty), then 27 — the
  // repeated penalty is what crosses 20 on the 3rd call.
  const decision1 = await runTool(listener, agent, 'grep', failed('TypeError at line 123'))
  const decision2 = await runTool(listener, agent, 'grep', failed('TypeError at line 456'))
  assert.equal(nudgeOf(decision1), undefined)
  assert.equal(nudgeOf(decision2), undefined)
  const decision3 = await runTool(listener, agent, 'grep', failed('TypeError at line 789'))
  assert.ok(nudgeOf(decision3), 'repeat penalty must cross 20 on the 3rd identical failure')
  assert.match(nudgeOf(decision3).content[0].text, /repeated_failures=2/)
})

test('research tool resets the accumulation', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { maxToolCallsWithoutResearch: 5, debtThreshold: 999, maxMinutesWithoutResearch: 999 })
  const listener = plugin(listeners)
  const agent = {}
  const exec = execution(agent, 'read')
  for (let i = 0; i < 4; i += 1) {
    const decision = await listener(exec, succeeded(), async () => ({ kind: 'accept' }))
    assert.equal(nudgeOf(decision), undefined)
  }
  const crossed = await listener(exec, succeeded(), async () => ({ kind: 'accept' }))
  assert.ok(nudgeOf(crossed), '5th call must nudge')
  assert.match(nudgeOf(crossed).content[0].text, /tool_calls_since_research=5/)

  const researchAgent = {}
  await listener(execution(researchAgent, 'web_search'), succeeded(), async () => ({ kind: 'accept' }))
  for (let i = 0; i < 3; i += 1) {
    const decision = await listener(execution(researchAgent, 'read'), succeeded(), async () => ({ kind: 'accept' }))
    assert.equal(nudgeOf(decision), undefined, 'research reset must clear accumulated debt')
  }
})

test('cooldown suppresses further nudges until it elapses', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { maxToolCallsWithoutResearch: 3, debtThreshold: 999, maxMinutesWithoutResearch: 999, cooldownMinutes: 10 })
  const listener = plugin(listeners)
  const agent = {}
  const exec = execution(agent, 'read')
  await listener(exec, succeeded(), async () => ({ kind: 'accept' }))
  await listener(exec, succeeded(), async () => ({ kind: 'accept' }))
  const first = await listener(exec, succeeded(), async () => ({ kind: 'accept' }))
  assert.ok(nudgeOf(first), 'first crossing nudges')
  const after = await listener(exec, succeeded(), async () => ({ kind: 'accept' }))
  assert.equal(nudgeOf(after), undefined, 'cooldown must suppress the next nudge')
})

test('nudge prepends while preserving a blocked downstream decision', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { maxToolCallsWithoutResearch: 1, debtThreshold: 999, maxMinutesWithoutResearch: 999 })
  const listener = plugin(listeners)
  const agent = {}
  const downstream = { kind: 'block', feedback: [{ type: 'text', text: 'blocked by policy' }], additionalContexts: [{ id: 'other' }] }
  const decision = await runTool(listener, agent, 'read', succeeded(), { downstream })
  assert.equal(decision.kind, 'block')
  assert.deepEqual(decision.feedback, downstream.feedback)
  assert.equal(decision.additionalContexts[0].source.plugin, pluginName, 'nudge must be first')
  assert.deepEqual(decision.additionalContexts[1], { id: 'other' })
})

test('policy state is isolated per agent', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { maxToolCallsWithoutResearch: 3, debtThreshold: 999, maxMinutesWithoutResearch: 999 })
  const listener = plugin(listeners)
  const busy = {}
  const idle = {}
  const exec = execution(busy, 'read')
  for (let i = 0; i < 2; i += 1) {
    const decision = await listener(exec, succeeded(), async () => ({ kind: 'accept' }))
    assert.equal(nudgeOf(decision), undefined)
  }
  const busyNudge = await listener(exec, succeeded(), async () => ({ kind: 'accept' }))
  assert.ok(nudgeOf(busyNudge), '3rd call on the busy agent must nudge')
  const idleDecision = await listener(execution(idle, 'read'), succeeded(), async () => ({ kind: 'accept' }))
  assert.equal(nudgeOf(idleDecision), undefined, 'idle agent must not inherit the busy agent\'s debt')
})

test('unexpected shapes are tolerated without throwing or nudging', async () => {
  const { ctx, listeners } = makeCtx()
  // Extremely lax thresholds: this test only asserts shape toleration — a
  // result-less call is legitimately counted as a failure (never a throw),
  // so it must not cross any nudge threshold here.
  apply(ctx, { maxToolCallsWithoutResearch: 999, debtThreshold: 999, maxMinutesWithoutResearch: 999 })
  const listener = plugin(listeners)
  const weird = [
    [{}, succeeded(), async () => ({ kind: 'accept' })],
    [null, succeeded(), async () => ({ kind: 'accept' })],
    [{ name: 'read', arguments: {}, agent: null }, undefined, async () => ({ kind: 'accept' })],
    [{ name: 'read', arguments: {}, agent: {} }, undefined, async () => ({ kind: 'accept' })],
  ]
  const logged = []
  const originalError = console.error
  console.error = (...args) => { logged.push(args) }
  try {
    for (const [exec, result, next] of weird) {
      const decision = await listener(exec, result, next)
      assert.equal(nudgeOf(decision), undefined)
    }
  } finally {
    console.error = originalError
  }
  assert.equal(logged.length, 3, 'malformed lifecycle inputs are contained and diagnosed')
})

test('adapter composes through a real Cordis waterfall', async () => {
  const ctx = new Context()
  apply(ctx, { maxToolCallsWithoutResearch: 1, debtThreshold: 999, maxMinutesWithoutResearch: 999 })
  const decision = await ctx.waterfall(
    ctx,
    'tools/post-execute',
    execution({}, 'read'),
    succeeded(),
    () => Promise.resolve({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.additionalContexts.length, 1)
  assert.equal(decision.additionalContexts[0].source.kind, 'plugin')
  assert.equal(decision.additionalContexts[0].source.form, 'notice')
  assert.equal(typeof decision.additionalContexts[0].id, 'string')
})
