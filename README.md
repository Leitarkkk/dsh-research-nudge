# dsh-research-nudge

[![CI](https://github.com/Leitarkkk/dsh-research-nudge/actions/workflows/ci.yml/badge.svg)](https://github.com/Leitarkkk/dsh-research-nudge/actions/workflows/ci.yml)
[![version](https://img.shields.io/github/package-json/v/Leitarkkk/dsh-research-nudge)](https://github.com/Leitarkkk/dsh-research-nudge/releases)
[![license](https://img.shields.io/github/license/Leitarkkk/dsh-research-nudge)](./LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek_Harness-0.1.0--rc.7-blue)](https://github.com/deepseek-ai/deepseek-harness)

English | [简体中文](./README.zh-CN.md)

An advisory **research-debt guard** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It notices when an agent spends a long stretch reading, editing, executing, and repeating failures without consulting external evidence, then adds a short reminder to the next model step.

It does not call an LLM, perform a search, block a tool, or force the agent to browse. The reminder explicitly allows self-contained work to continue normally.

## The problem

Agents sometimes fall into a local trial-and-error loop:

```text
read → guess an unfamiliar API → edit → run → fail → edit → run → same failure
```

A search of the official docs, an exact error message, or an existing GitHub issue may resolve that uncertainty faster. `dsh-research-nudge` turns the growing cost of the local loop into a deterministic score called **Research Debt**.

## Research Debt: a calculated example

This is a hypothetical sequence calculated from the documented default weights, not production telemetry. It shows exactly how the score would cross the threshold:

| Step | Signal | Added debt | Total |
| --- | --- | ---: | ---: |
| Read local code | ordinary tool | +1 | 1 |
| Edit a file | mutation | +2 | 3 |
| Run and fail | execution + failure | +1 +4 | 8 |
| Edit again | mutation | +2 | 10 |
| Run and hit the equivalent failure again | execution + failure + repeated failure | +1 +4 +6 | **21** |

The default threshold is 20, so the last result carries an additional model-visible context:

```text
[Research Nudge]

Pause and reflect before continuing:

1. What problem am I trying to solve right now? Restate it precisely.
2. What approach am I currently taking, and how many attempts has it taken without success?
3. Am I fully confident this approach will work? If I am guessing at an API, an error message, a library's behavior, or platform details I have not verified, I am not fully confident.
4. If I am not fully confident: external research is cheaper than more local trial-and-error. Search the official documentation, GitHub issues, existing libraries, or the exact error message before trying again.

Do not search merely to satisfy this reminder. If the task is self-contained and external research would not help, continue normally. If you are deliberately making progress from local evidence and do not want another reminder for a while, use the research_nudge_snooze tool.

Current signals: debt=21/20, tool_calls_since_research=5,
failures=2, repeated_failures=1.
```

Equivalent failures are fingerprinted after normalizing changing numbers and addresses, so `TypeError at line 123` and `TypeError at line 456` count as a repeat. A recognized research tool resets the accumulated state for that agent.

## Install

Prerequisites:

- DeepSeek Harness `0.1.0-rc.7` (the current `next` release line)
- Node.js `^22.19.0` or `>=24.0.0`, matching the current DSH baseline

From GitHub:

```bash
dsh plugin --profile web add github:Leitarkkk/dsh-research-nudge
```

Git installs run this package's `prepare` build. pnpm may reject that build until you explicitly trust it. Follow the exact `allowBuilds` entry printed by DSH/pnpm, review the source first, and pin a tag or commit for reproducible installs:

```bash
dsh plugin --profile web add github:Leitarkkk/dsh-research-nudge#<tag-or-commit>
```

After the package is published to npm, the prebuilt install is:

```bash
dsh plugin --profile web add dsh-research-nudge
```

Verify the composed layer, then restart the profile:

```bash
dsh --profile web --dump-config
dsh web
```

### Local development install

```bash
git clone https://github.com/Leitarkkk/dsh-research-nudge.git
cd dsh-research-nudge
npm install
npm run check
dsh plugin --profile web add .
```

Relative paths are resolved from the directory where `dsh plugin` is invoked.

## Default policy

| Signal | Debt |
| --- | ---: |
| Ordinary tool call | +1 |
| File mutation | +2 |
| Shell/build/test execution | +1 |
| Failed tool result | +4 |
| Repeated equivalent failure | +6 |
| Recognized external research tool | reset to 0 |

A reminder is eligible when any condition is met:

- Research Debt reaches 20;
- 15 tool calls occur without recognized research; or
- 15 minutes pass without recognized research.

After a reminder, the per-agent state continues accumulating but further reminders are suppressed for 10 minutes. Names are normalized before classification and research matching, so `WebSearch`, `web_search`, and `web-search` are treated consistently.

### Agent snooze

An agent that is deliberately making progress from local evidence can call the model-visible `research_nudge_snooze` tool to suppress reminders for a while (defaults to 30 minutes, capped by `maxAgentSnoozeMinutes`):

- Snoozing is **per agent** — other agents keep their own schedules.
- Research Debt keeps accumulating while snoozed: snoozing neither counts as research nor erases debt or failure counters. Once the snooze expires, an already-eligible state nudges on the next tool call.
- A failed snooze call (for example, invalid arguments rejected by schema validation) arms nothing and is recorded as an ordinary failed call. Snooze executions bypass research recognition entirely, so a custom `researchTools` pattern such as `search` (which substring-matches the snooze tool's own name) can never turn a failed snooze into a debt reset.

## Configuration

The bundle inserts a row with the id `research-nudge`. Override that row in the profile's `cordis.patch.yml`:

```yaml
- id: research-nudge
  config:
    enabled: true
    debtThreshold: 20
    maxToolCallsWithoutResearch: 15
    maxMinutesWithoutResearch: 15
    cooldownMinutes: 10
    ordinaryToolDebt: 1
    mutationDebt: 2
    executionDebt: 1
    failureDebt: 4
    repeatedFailureDebt: 6
    maxAgentSnoozeMinutes: 60
    researchTools:
      - web_search
      - web_fetch
      - github_search
      - docs_search
      - fetch_url
    debug: false
```

DSH patch layers replace a row's entire `config` value rather than deep-merging it. Any omitted fields above fall back to this plugin's schema defaults. `reminder` may also be set to a custom string.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Register the lifecycle listener |
| `debtThreshold` | `20` | Debt score that makes a reminder eligible |
| `maxToolCallsWithoutResearch` | `15` | Call-count fallback threshold |
| `maxMinutesWithoutResearch` | `15` | Elapsed-time fallback threshold |
| `cooldownMinutes` | `10` | Minimum time between reminders |
| `ordinaryToolDebt` | `1` | Weight for other local tools |
| `mutationDebt` | `2` | Weight for write/edit/delete-style tools |
| `executionDebt` | `1` | Weight for shell/build/test-style tools |
| `failureDebt` | `4` | Extra weight for a failed result |
| `repeatedFailureDebt` | `6` | Extra weight for an equivalent consecutive failure |
| `maxAgentSnoozeMinutes` | `60` | Upper bound for one agent-requested snooze of reminders |
| `researchTools` | common web/docs/GitHub names | Substring patterns that reset state after normalization |
| `reminder` | built-in advisory text | Model-visible reminder body |
| `debug` | `false` | Log resets and queued reminders to stderr |

## How it integrates with DSH

The plugin listens to the current `tools/post-execute` waterfall. It observes the typed `ToolExecution` and `ToolExecutionResult`, delegates to later listeners with `next()`, then prepends one official `createUserMessage(...)` notice through `PostToolDecision.additionalContexts`. Accept/block decisions and existing contexts are preserved.

The plugin declares `inject: ['tools']` and registers its `research_nudge_snooze` tool through `ctx.tools.register(...)`; no other service is read from `ctx`. State is held in a `WeakMap` keyed by the calling agent and disappears with the agent/runtime.

## Compatibility

The adapter is compiled and tested against the official `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-llm` `0.1.0-rc.7` contracts. DSH is still a Developer Preview and explicitly allows compatibility-breaking changes. If a later DSH release changes the tool waterfall or message contract, update the small adapter in `src/index.ts`; the deterministic policy in `src/policy.ts` is independent.

## Privacy and safety

- No telemetry, network requests, API keys, or extra model calls.
- No tool arguments are stored or copied.
- The in-memory fingerprint uses only failed-result text; it is not persisted.
- The reminder is advisory and never changes a tool result or permission decision.
- Git installs execute a local build script; review and pin third-party code before allowing it.

## Development

```bash
npm ci
npm run check
npm pack --dry-run
```

See [CONTRIBUTING.md](https://github.com/Leitarkkk/dsh-research-nudge/blob/master/CONTRIBUTING.md) for contribution guidelines.

## License

[MIT](./LICENSE)
