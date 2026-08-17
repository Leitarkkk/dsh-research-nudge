/** Advisory research-debt policy for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {
  PostToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  defaultPolicy,
  isResearchTool,
  newState,
  recordResearch,
  recordTool,
  shouldNudge,
  type PolicyConfig,
  type ResearchState,
} from './policy.js'

export const name = 'research-nudge'

const DEFAULT_RESEARCH_TOOLS = [
  'web_search',
  'websearch',
  'web_fetch',
  'webfetch',
  'search_web',
  'browser_search',
  'github_search',
  'search_github',
  'fetch_url',
  'http_get',
  'docs_search',
  'documentation_search',
]

const DEFAULT_REMINDER = `[Research Nudge]

You have accumulated significant research debt through local tool use without consulting external information.

Before continuing, consider whether external research could resolve the current uncertainty faster:
- search official documentation for unfamiliar APIs;
- search GitHub for existing implementations and issues;
- check whether a mature library already solves the problem;
- search exact error messages after repeated failures.

Do not search merely to satisfy this reminder. If the task is self-contained and external research would not help, continue normally.`

export interface Config extends Partial<PolicyConfig> {
  enabled?: boolean
  researchTools?: string[]
  reminder?: string
  debug?: boolean
}

/** Loader-visible schema; defaults and numeric bounds fail invalid config at boot. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  debtThreshold: z.number().step(1).min(1).default(defaultPolicy.debtThreshold),
  maxToolCallsWithoutResearch: z.number().step(1).min(1).default(defaultPolicy.maxToolCallsWithoutResearch),
  maxMinutesWithoutResearch: z.number().min(0).default(defaultPolicy.maxMinutesWithoutResearch),
  cooldownMinutes: z.number().min(0).default(defaultPolicy.cooldownMinutes),
  ordinaryToolDebt: z.number().step(1).min(0).default(defaultPolicy.ordinaryToolDebt),
  mutationDebt: z.number().step(1).min(0).default(defaultPolicy.mutationDebt),
  executionDebt: z.number().step(1).min(0).default(defaultPolicy.executionDebt),
  failureDebt: z.number().step(1).min(0).default(defaultPolicy.failureDebt),
  repeatedFailureDebt: z.number().step(1).min(0).default(defaultPolicy.repeatedFailureDebt),
  researchTools: z.array(z.string()).default(DEFAULT_RESEARCH_TOOLS),
  reminder: z.string().default(DEFAULT_REMINDER),
  debug: z.boolean().default(false),
})

function policyConfig(config: Config): PolicyConfig {
  return {
    debtThreshold: config.debtThreshold ?? defaultPolicy.debtThreshold,
    maxToolCallsWithoutResearch: config.maxToolCallsWithoutResearch ?? defaultPolicy.maxToolCallsWithoutResearch,
    maxMinutesWithoutResearch: config.maxMinutesWithoutResearch ?? defaultPolicy.maxMinutesWithoutResearch,
    cooldownMinutes: config.cooldownMinutes ?? defaultPolicy.cooldownMinutes,
    ordinaryToolDebt: config.ordinaryToolDebt ?? defaultPolicy.ordinaryToolDebt,
    mutationDebt: config.mutationDebt ?? defaultPolicy.mutationDebt,
    executionDebt: config.executionDebt ?? defaultPolicy.executionDebt,
    failureDebt: config.failureDebt ?? defaultPolicy.failureDebt,
    repeatedFailureDebt: config.repeatedFailureDebt ?? defaultPolicy.repeatedFailureDebt,
  }
}

function resultText(result: Readonly<ToolExecutionResult>): string {
  return result.content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function createNudgeMessage(text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary },
  })
}

function renderMetrics(state: ResearchState, config: PolicyConfig): string {
  return `\n\nCurrent signals: debt=${state.debt}/${config.debtThreshold}, `
    + `tool_calls_since_research=${state.callsSinceResearch}, `
    + `failures=${state.failuresSinceResearch}, repeated_failures=${state.repeatedFailures}.`
}

function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
  return [ours, ...theirs ?? []]
}

export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return

  const policy = policyConfig(config)
  const researchTools = config.researchTools ?? DEFAULT_RESEARCH_TOOLS
  const reminder = config.reminder ?? DEFAULT_REMINDER
  const states = new WeakMap<NonNullable<ToolExecution['agent']>, ResearchState>()

  function stateFor(agent: NonNullable<ToolExecution['agent']>): ResearchState {
    let state = states.get(agent)
    if (state === undefined) {
      state = newState()
      states.set(agent, state)
    }
    return state
  }

  function observe(exec: ToolExecution, result: Readonly<ToolExecutionResult>): UserMessage | undefined {
    if (exec.agent === undefined || exec.name === '') return undefined
    const state = stateFor(exec.agent)

    if (isResearchTool(exec.name, researchTools)) {
      recordResearch(state)
      if (config.debug) console.error(`[research-nudge] research reset by ${exec.name}`)
      return undefined
    }

    const fingerprint = result.isError ? result.error.message || resultText(result) : undefined
    recordTool(state, policy, exec.name, !result.isError, fingerprint)
    if (!shouldNudge(state, policy)) return undefined

    state.lastNudgeAt = Date.now()
    if (config.debug) console.error('[research-nudge] threshold reached; nudge queued')
    return createNudgeMessage(
      reminder + renderMetrics(state, policy),
      `research debt ${state.debt}/${policy.debtThreshold}`,
    )
  }

  // DSH 0.1.0-rc.7: post-execute is a waterfall. Always delegate, then
  // prepend the advisory context without changing accept/block semantics.
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    let nudge: UserMessage | undefined
    try {
      nudge = observe(exec, result)
    } catch (error) {
      console.error('[research-nudge] observation failed; tool call passed through:', error)
    }

    const downstream = await next()
    if (nudge === undefined) return downstream
    if (downstream.kind === 'block') {
      return {
        kind: 'block',
        feedback: downstream.feedback,
        additionalContexts: prependContext(nudge, downstream.additionalContexts),
      }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(nudge, downstream.additionalContexts),
    }
  })
}
