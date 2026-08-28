export type ResearchState = {
  debt: number
  callsSinceResearch: number
  failuresSinceResearch: number
  repeatedFailures: number
  lastResearchAt: number
  lastNudgeAt: number
  snoozedUntil: number
  lastFailureFingerprint?: string
}

export type PolicyConfig = {
  debtThreshold: number
  maxToolCallsWithoutResearch: number
  maxMinutesWithoutResearch: number
  cooldownMinutes: number
  ordinaryToolDebt: number
  mutationDebt: number
  executionDebt: number
  failureDebt: number
  repeatedFailureDebt: number
}

export const defaultPolicy: PolicyConfig = {
  debtThreshold: 20,
  maxToolCallsWithoutResearch: 15,
  maxMinutesWithoutResearch: 15,
  cooldownMinutes: 10,
  ordinaryToolDebt: 1,
  mutationDebt: 2,
  executionDebt: 1,
  failureDebt: 4,
  repeatedFailureDebt: 6,
}

export function newState(now = Date.now()): ResearchState {
  return {
    debt: 0, callsSinceResearch: 0, failuresSinceResearch: 0,
    repeatedFailures: 0, lastResearchAt: now, lastNudgeAt: 0, snoozedUntil: 0,
  }
}

export function normalizeToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
}

export function isResearchTool(name: string, patterns: string[]): boolean {
  const n = normalizeToolName(name)
  return patterns.some(p => n.includes(normalizeToolName(p)))
}

export function classifyTool(name: string): 'mutation' | 'execution' | 'ordinary' {
  const n = normalizeToolName(name)
  if (/(write|edit|replace|patch|create_file|delete_file|apply_patch)/.test(n)) return 'mutation'
  if (/(bash|shell|terminal|exec|run_command|test|compile|build)/.test(n)) return 'execution'
  return 'ordinary'
}

export function fingerprintFailure(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text.toLowerCase()
    .replace(/\b0x[0-9a-f]+\b/g, '0x#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 300)
}

export function recordResearch(s: ResearchState, now = Date.now()): void {
  s.debt = 0
  s.callsSinceResearch = 0
  s.failuresSinceResearch = 0
  s.repeatedFailures = 0
  s.lastResearchAt = now
  s.lastFailureFingerprint = undefined
}

/** Suppress advisory nudges until the requested time without discarding debt. */
export function snoozeResearchNudges(s: ResearchState, minutes: number, now = Date.now()): void {
  s.snoozedUntil = now + Math.max(0, minutes) * 60_000
}

export function recordTool(
  s: ResearchState, cfg: PolicyConfig, name: string,
  ok: boolean, result?: unknown, now = Date.now(),
): void {
  s.callsSinceResearch++
  const kind = classifyTool(name)
  s.debt += kind === 'mutation' ? cfg.mutationDebt :
            kind === 'execution' ? cfg.executionDebt : cfg.ordinaryToolDebt

  if (!ok) {
    s.failuresSinceResearch++
    s.debt += cfg.failureDebt
    const fp = fingerprintFailure(result)
    if (fp && fp === s.lastFailureFingerprint) {
      s.repeatedFailures++
      s.debt += cfg.repeatedFailureDebt
    }
    s.lastFailureFingerprint = fp
  }
}

export function shouldNudge(s: ResearchState, cfg: PolicyConfig, now = Date.now()): boolean {
  if (now < s.snoozedUntil) return false
  const cooldown = cfg.cooldownMinutes * 60_000
  if (s.lastNudgeAt && now - s.lastNudgeAt < cooldown) return false
  const staleMs = cfg.maxMinutesWithoutResearch * 60_000
  return s.debt >= cfg.debtThreshold ||
    s.callsSinceResearch >= cfg.maxToolCallsWithoutResearch ||
    now - s.lastResearchAt >= staleMs
}
