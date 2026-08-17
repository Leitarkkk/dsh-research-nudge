/**
 * dsh-research-nudge
 *
 * A zero-LLM-overhead "research debt" policy for DeepSeek Harness.
 *
 * Adapter note: DSH's tool lifecycle surface is the `tools` service waterfall
 * `tools/post-execute` (the same hook the in-box `dsh-repeat-tool-reminder`
 * guard uses), and model-visible reminders are delivered as
 * `additionalContexts` user messages on the returned decision — never by
 * touching the agent loop. The policy engine in `./policy.js` is independent,
 * fully deterministic, and covered by `tests/policy.test.mjs`.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  defaultPolicy, isResearchTool, newState, recordResearch, recordTool,
  shouldNudge, type PolicyConfig, type ResearchState,
} from './policy.js'

export const name = 'dsh-research-nudge'
export const inject = []

export interface Config extends Partial<PolicyConfig> {
  enabled?: boolean
  researchTools?: string[]
  reminder?: string
  debug?: boolean
}

const DEFAULT_RESEARCH_TOOLS = [
  'web_search', 'websearch', 'web_fetch', 'webfetch',
  'search_web', 'browser_search', 'github_search', 'search_github',
  'fetch_url', 'http_get', 'docs_search', 'documentation_search',
]

const DEFAULT_REMINDER = `[Research Nudge]

You have accumulated significant research debt through local tool use without consulting external information.

Before continuing, consider whether external research could resolve the current uncertainty faster:
- search official documentation for unfamiliar APIs;
- search GitHub for existing implementations and issues;
- check whether a mature library already solves the problem;
- search exact error messages after repeated failures.

Do not search merely to satisfy this reminder. If the task is self-contained and external research would not help, continue normally.`

// Loose structural views of the runtime objects the tools waterfall hands us.
type ToolExec = { name?: unknown; arguments?: unknown; agent?: unknown }
type ToolResult = { isError?: boolean; error?: unknown; content?: unknown }
type PostDecision = { kind?: unknown; feedback?: unknown; additionalContexts?: unknown[] }
type NudgeContext = {
  on(event: string, listener: (...args: any[]) => any): unknown
}

function randomMessageId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return cryptoApi?.randomUUID?.() ?? Math.random().toString(36).slice(2)
}

function toolName(exec: ToolExec): string {
  return typeof exec.name === 'string' ? exec.name : ''
}

function resultOk(result: ToolResult): boolean {
  return result != null && result.isError !== true && result.error === undefined
}

/** Flatten post-execute `content` (string or block list) for failure fingerprints. */
function resultText(result: ToolResult): string {
  if (result == null) return ''
  const content = result.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block !== null && typeof block === 'object') {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string') return text
      }
      return String(block)
    }).filter((text) => text.length > 0).join('\n')
  }
  return ''
}

/** One plugin-source user message, shaped like the in-box reminder plugins. */
function createNudgeMessage(text: string, summary: string) {
  return {
    id: randomMessageId(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary },
  }
}

function renderMetrics(s: ResearchState, cfg: PolicyConfig): string {
  return `\n\nCurrent signals: debt=${s.debt}/${cfg.debtThreshold}, ` +
    `tool_calls_since_research=${s.callsSinceResearch}, ` +
    `failures=${s.failuresSinceResearch}, repeated_failures=${s.repeatedFailures}.`
}

export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return

  const cfg: PolicyConfig = { ...defaultPolicy, ...config }
  const researchTools = config.researchTools ?? DEFAULT_RESEARCH_TOOLS
  const reminder = config.reminder ?? DEFAULT_REMINDER
  const states = new WeakMap<object, ResearchState>()

  const stateFor = (agent: object): ResearchState => {
    let state = states.get(agent)
    if (!state) states.set(agent, state = newState())
    return state
  }

  /**
   * Fold one finished tool execution into the agent's policy state and return
   * the nudge message to deliver, if the threshold was just crossed.
   */
  const observe = (exec: ToolExec, result: ToolResult) => {
    if (exec == null) return undefined
    const agent = exec.agent
    if (agent === undefined || agent === null || typeof agent !== 'object') return undefined
    if (toolName(exec) === '') return undefined
    const state = stateFor(agent)
    const tool = toolName(exec)

    if (isResearchTool(tool, researchTools)) {
      recordResearch(state)
      if (config.debug) console.error(`[research-nudge] research reset by ${tool}`)
      return undefined
    }

    const ok = resultOk(result)
    const fingerprint = !ok && result != null ? (result.error ?? resultText(result)) : undefined
    recordTool(state, cfg, tool, ok, fingerprint)
    if (!shouldNudge(state, cfg)) return undefined

    state.lastNudgeAt = Date.now()
    if (config.debug) console.error('[research-nudge] threshold reached; nudge queued')
    const text = reminder + renderMetrics(state, cfg)
    return createNudgeMessage(text, `research debt ${state.debt}/${cfg.debtThreshold}`)
  }

  const c = ctx as unknown as NudgeContext
  c.on('tools/post-execute', async (
    exec: ToolExec,
    result: ToolResult,
    next: () => Promise<PostDecision>,
  ) => {
    // This waterfall runs inside the tool pipeline where ONE throwing
    // listener turns the finished tool call into an error result. The nudge
    // is advisory, so our own observation must be fully contained: on any
    // unexpected shape bug it logs and passes the call through untouched.
    let nudge
    try {
      nudge = observe(exec, result)
    } catch (error) {
      console.error('[research-nudge] observation failed; tool call passed through:', error)
    }
    const downstream = await next()
    if (nudge === undefined) return downstream
    const existing = downstream.additionalContexts ?? []
    if (downstream.kind === 'block') {
      return { kind: 'block', feedback: downstream.feedback, additionalContexts: [nudge, ...existing] }
    }
    return { ...downstream, additionalContexts: [nudge, ...existing] }
  })
}