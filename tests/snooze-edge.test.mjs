import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'

// Snooze adversarial suite: clamping, defaults, expiry boundaries, debt
// preservation, research interplay, per-call semantics, and hostile argument
// shapes via a controllable fake clock. Tests import the built JS, so run
// `npm run build` before `npm test`.
import { apply, name as pluginName, inject as pluginInject } from '../lib/index.js'

const MIN = 60_000

function makeCtx() {
  const listeners = new Map()
  const tools = new Map()
  return {
    ctx: {
      on(event, listener) { listeners.set(event, listener) },
      tools: { register(tool) { tools.set(tool.name, tool) } },
    },
    listeners,
    tools,
  }
}

function plugin(listeners) {
  return listeners.get('tools/post-execute')
}

async function runTool(listener, agent, name, result, { downstream = { kind: 'accept' }, arguments: args = {} } = {}) {
  const exec = execution(agent, name, args)
  return listener(exec, result, async () => downstream)
}

function execution(agent, name, args = {}) {
  return {
    token: Symbol('tool'),
    callId: 'call-' + Math.random().toString(36).slice(2),
    rootCallId: 'call-x',
    name,
    arguments: args,
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

/** Always-nudge config: every ordinary call crosses the stale-time threshold. */
const ALWAYS = { debtThreshold: 999, maxToolCallsWithoutResearch: 999, maxMinutesWithoutResearch: 0, cooldownMinutes: 0 }

/** Fake global clock; returns a setter. Restores on dispose(). */
function fakeClock(start) {
  const real = Date.now
  let now = start
  Date.now = () => now
  return {
    set: (v) => { now = v },
    add: (ms) => { now += ms },
    get: () => now,
    dispose: () => { Date.now = real },
  }
}

test('inject export declares the tools service dependency', () => {
  assert.deepEqual(pluginInject, ['tools'])
})

test('snooze minutes are capped by maxAgentSnoozeMinutes', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { ...ALWAYS, maxAgentSnoozeMinutes: 2 })
  const listener = plugin(listeners)
  const agent = {}
  const clock = fakeClock(1_000_000)
  try {
    await runTool(listener, agent, 'research_nudge_snooze', succeeded(), { arguments: { minutes: 999 } })
    clock.add(2 * MIN - 1)
    const during = await runTool(listener, agent, 'read', succeeded())
    assert.equal(nudgeOf(during), undefined, 'at cap-1ms the nudge must still be suppressed')
    clock.add(2)
    const after = await runTool(listener, agent, 'read', succeeded())
    assert.ok(nudgeOf(after), 'at cap+1ms the nudge must fire — 999 must have been capped to 2 minutes')
  } finally { clock.dispose() }
})

test('missing minutes defaults to a 30 minute snooze', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { ...ALWAYS })
  const listener = plugin(listeners)
  const agent = {}
  const clock = fakeClock(2_000_000)
  try {
    await runTool(listener, agent, 'research_nudge_snooze', succeeded(), { arguments: {} })
    clock.add(30 * MIN - 1)
    const during = await runTool(listener, agent, 'read', succeeded())
    assert.equal(nudgeOf(during), undefined, 'at 30min-1ms the nudge must be suppressed')
    clock.add(2)
    const after = await runTool(listener, agent, 'read', succeeded())
    assert.ok(nudgeOf(after), 'at 30min+1ms the nudge must fire — default must be 30 minutes')
  } finally { clock.dispose() }
})

test('zero and negative minutes clamp to a one minute snooze', async () => {
  for (const minutes of [0, -5]) {
    const { ctx, listeners } = makeCtx()
    apply(ctx, { ...ALWAYS })
    const listener = plugin(listeners)
    const agent = {}
    const clock = fakeClock(3_000_000)
    try {
      await runTool(listener, agent, 'research_nudge_snooze', succeeded(), { arguments: { minutes } })
      const immediate = await runTool(listener, agent, 'read', succeeded())
      assert.equal(nudgeOf(immediate), undefined, `minutes=${minutes} must still suppress immediately`)
      clock.add(MIN + 1)
      const after = await runTool(listener, agent, 'read', succeeded())
      assert.ok(nudgeOf(after), `minutes=${minutes} must expire after one minute`)
    } finally { clock.dispose() }
  }
})

test('the snooze call itself never nudges and records no debt', async () => {
  const { ctx, listeners } = makeCtx()
  // Every ordinary call nudges, so the snooze call would too if it fell through.
  apply(ctx, { ...ALWAYS, maxToolCallsWithoutResearch: 3 })
  const listener = plugin(listeners)
  const agent = {}
  const clock = fakeClock(4_000_000)
  try {
    await runTool(listener, agent, 'read', succeeded())
    const snoozeDecision = await runTool(listener, agent, 'research_nudge_snooze', succeeded(), { arguments: { minutes: 10 } })
    assert.equal(nudgeOf(snoozeDecision), undefined, 'the snooze call itself must not produce a nudge')
    assert.equal(snoozeDecision.kind, 'accept', 'snooze must pass the downstream accept decision through unchanged')
    // Prove the snooze call recorded no tool call: two ordinary reads happened,
    // threshold is 3, and after expiry one more read (3rd ordinary call) nudges.
    clock.add(10 * MIN + 1)
    const cross = await runTool(listener, agent, 'read', succeeded())
    assert.ok(nudgeOf(cross), '3rd ordinary call must cross — proving snooze added no call of its own')
  } finally { clock.dispose() }
})

test('debt and counters survive the snooze untouched', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { maxToolCallsWithoutResearch: 2, debtThreshold: 999, maxMinutesWithoutResearch: 999, cooldownMinutes: 0 })
  const listener = plugin(listeners)
  const agent = {}
  const clock = fakeClock(5_000_000)
  try {
    await runTool(listener, agent, 'read', succeeded())
    const first = await runTool(listener, agent, 'read', succeeded())
    assert.ok(nudgeOf(first), 'baseline: 2 calls must cross the threshold')
    await runTool(listener, agent, 'research_nudge_snooze', succeeded(), { arguments: { minutes: 60 } })
    clock.add(60 * MIN + 1)
    // Counters were never reset: the very next call (3rd since research) nudges.
    const next = await runTool(listener, agent, 'read', succeeded())
    assert.ok(nudgeOf(next), 'after expiry the pre-snooze debt must still trigger on the next call')
  } finally { clock.dispose() }
})

test('research during snooze still resets the accumulation', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { maxToolCallsWithoutResearch: 2, debtThreshold: 999, maxMinutesWithoutResearch: 999, cooldownMinutes: 0 })
  const listener = plugin(listeners)
  const agent = {}
  const clock = fakeClock(6_000_000)
  try {
    await runTool(listener, agent, 'research_nudge_snooze', succeeded(), { arguments: { minutes: 30 } })
    await runTool(listener, agent, 'read', succeeded())
    await runTool(listener, agent, 'read', succeeded())
    const research = await runTool(listener, agent, 'web_search', succeeded())
    assert.equal(nudgeOf(research), undefined, 'research call records no nudge')
    clock.add(30 * MIN + 1)
    const firstAfter = await runTool(listener, agent, 'read', succeeded())
    assert.equal(nudgeOf(firstAfter), undefined, 'research during snooze must have reset the counter — 1st call after expiry must not nudge')
    const secondAfter = await runTool(listener, agent, 'read', succeeded())
    assert.ok(nudgeOf(secondAfter), '2nd call after expiry must cross the fresh accumulation')
  } finally { clock.dispose() }
})

test('snooze is per agent: one agent snoozing cannot shield another', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { ...ALWAYS })
  const listener = plugin(listeners)
  const a = {}
  const b = {}
  const clock = fakeClock(7_000_000)
  try {
    await runTool(listener, a, 'research_nudge_snooze', succeeded(), { arguments: { minutes: 45 } })
    const shielded = await runTool(listener, a, 'read', succeeded())
    assert.equal(nudgeOf(shielded), undefined, 'snoozed agent must be silent')
    const other = await runTool(listener, b, 'read', succeeded())
    assert.ok(nudgeOf(other), 'another agent must still be nudged')
  } finally { clock.dispose() }
})

test('hostile snooze argument shapes never throw and pass through', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { ...ALWAYS })
  const listener = plugin(listeners)
  const agent = {}
  const shapes = [
    undefined,
    'nonsense',
    42,
    null,
    [],
    { minutes: 'abc' },
    { minutes: null },
    { minutes: true },
    { minutes: 1.9 },
    { minutes: Number.POSITIVE_INFINITY },
    { minutes: Number.NaN },
    { minutes: -0 },
  ]
  const clock = fakeClock(8_000_000)
  try {
    for (const args of shapes) {
      const decision = await runTool(listener, agent, 'research_nudge_snooze', succeeded(), { arguments: args })
      assert.equal(decision.kind, 'accept', `shape ${JSON.stringify(args)} must pass through`)
      assert.equal(nudgeOf(decision), undefined, `shape ${JSON.stringify(args)} must not nudge`)
      const during = await runTool(listener, agent, 'read', succeeded())
      assert.equal(nudgeOf(during), undefined, `shape ${JSON.stringify(args)} must have armed a snooze`)
      clock.add(60 * MIN + 1_000)
      await runTool(listener, agent, 'read', succeeded()) // let the snooze expire
      clock.add(60 * MIN + 1_000)
    }
  } finally { clock.dispose() }
})

test('uppercase or separator variants of the tool name still snooze', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { ...ALWAYS })
  const listener = plugin(listeners)
  const agent = {}
  const clock = fakeClock(9_000_000)
  try {
    await runTool(listener, agent, 'ResearchNudgeSnooze', succeeded(), { arguments: { minutes: 5 } })
    const during = await runTool(listener, agent, 'read', succeeded())
    assert.equal(nudgeOf(during), undefined, 'normalized tool name variants must be recognized')
    clock.add(5 * MIN + 1)
    const after = await runTool(listener, agent, 'read', succeeded())
    assert.ok(nudgeOf(after), 'the 5 minute snooze must have expired')
  } finally { clock.dispose() }
})

test('the registered snooze tool reports exactly the applied clamp', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, { maxAgentSnoozeMinutes: 2 })
  const tool = tools.get('research_nudge_snooze')
  assert.ok(tool, 'snooze tool must be registered')
  const capped = await tool.execute({ minutes: 999 }, { signal: new AbortController().signal })
  assert.match(String(capped), /2 minutes/, 'over-cap request must report the capped value')
  // The 30-minute default is itself capped: execute() must agree with the
  // observe path, which applies Math.min(30, maxMinutes).
  const cappedDefault = await tool.execute({}, { signal: new AbortController().signal })
  assert.match(String(cappedDefault), /2 minutes/, 'missing minutes must report min(30, cap)')
  const singular = await tool.execute({ minutes: 1 }, { signal: new AbortController().signal })
  assert.match(String(singular), /1 minute\./, 'singular phrasing for one minute')
  const { ctx: ctx2, tools: tools2 } = makeCtx()
  apply(ctx2, {})
  const defaulted = await tools2.get('research_nudge_snooze').execute({}, { signal: new AbortController().signal })
  assert.match(String(defaulted), /30 minutes/, 'missing minutes must report the 30 minute default at the default cap')
  // defineTool schema-validates before execute: junk never reaches the body.
  await assert.rejects(
    tool.execute({ minutes: 'abc' }, { signal: new AbortController().signal }),
    /must be a number/,
    'non-numeric minutes must be rejected by schema validation at dispatch',
  )
  await assert.rejects(
    tool.execute({ minutes: null }, { signal: new AbortController().signal }),
    /must be a number/,
    'null minutes must be rejected by schema validation at dispatch',
  )
})

test('a failed (isError) snooze call arms nothing and counts as an ordinary call', async () => {
  // Validation failures reach post-execute as normal error results (dsh-tools:
  // "Tool and unknown-tool failures still receive post-execute"). The plugin
  // must not arm suppression from them; the failed call falls through and
  // counts as an ordinary tool call.
  const { ctx, listeners } = makeCtx()
  apply(ctx, { maxToolCallsWithoutResearch: 2, debtThreshold: 999, maxMinutesWithoutResearch: 999, cooldownMinutes: 0 })
  const listener = plugin(listeners)
  const agent = {}
  await runTool(listener, agent, 'read', succeeded())
  const failedCall = await runTool(
    listener,
    agent,
    'research_nudge_snooze',
    { isError: true, error: { message: '"minutes" must be a number' }, content: [{ type: 'text', text: 'Error: invalid arguments' }] },
    { arguments: { minutes: 'abc' } },
  )
  assert.ok(nudgeOf(failedCall), 'failed snooze is ordinary call #2 — threshold crossed unsuppressed')
  const after = await runTool(listener, agent, 'read', succeeded())
  assert.ok(nudgeOf(after), 'nothing may be armed by a failed snooze call')
})

test('enabled:false registers neither listener nor snooze tool', () => {
  const { ctx, listeners, tools } = makeCtx()
  apply(ctx, { enabled: false })
  assert.equal(listeners.has('tools/post-execute'), false)
  assert.equal(tools.size, 0, 'no tool may be registered when disabled')
})

test('snooze composes through a real Cordis waterfall without altering the decision', async () => {
  const ctx = new Context()
  ctx.tools = { register() {} }
  apply(ctx, { ...ALWAYS })
  const agent = {}
  const decision = await ctx.waterfall(
    ctx,
    'tools/post-execute',
    execution(agent, 'research_nudge_snooze', { minutes: 5 }),
    succeeded(),
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.additionalContexts, undefined, 'a snooze call must inject no context')
})

test('agent-less snooze execution is ignored without throwing', async () => {
  const { ctx, listeners } = makeCtx()
  apply(ctx, { ...ALWAYS })
  const listener = plugin(listeners)
  const decision = await listener(execution(undefined, 'research_nudge_snooze', { minutes: 10 }), succeeded(), async () => ({ kind: 'accept' }))
  assert.equal(decision.kind, 'accept')
})
