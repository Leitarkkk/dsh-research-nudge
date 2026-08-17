# dsh-research-nudge

[简体中文](./README.zh-CN.md)

A small DeepSeek Harness plugin that detects **research debt**: long stretches of local tool use, edits, executions, and repeated failures without external research.

It does **not** force a search. When the threshold is reached it injects a short model-visible nudge telling the agent to consider official docs, GitHub, existing libraries, or exact-error search — and explicitly allows the agent to ignore the reminder for self-contained work.

## Why

Coding agents can get stuck in a local loop:

`read → guess API → edit → run → fail → edit → run → fail`

when one documentation/GitHub/web lookup would be cheaper.

This plugin turns that failure mode into a deterministic harness policy with **zero extra LLM calls**.

## Install

> Current status: the package is not published to npm yet and the GitHub
> repository does not exist yet — only the **Local development** path below
> works today.

From npm after publication:

```bash
dsh plugin --profile web add dsh-research-nudge
```

From GitHub:

```bash
dsh plugin --profile web add github:Leitarkkk/dsh-research-nudge
```

GitHub installs build the package on the fly (`prepare`). pnpm 10 blocks build
scripts by default: if `dsh plugin` reports a blocked build, add the exact key
it prints to `allowBuilds` in the profile's `pnpm-workspace.yaml` and re-run.

Local development:

```bash
npm install
npm run check
dsh plugin --profile web add /absolute/path/to/dsh-research-nudge
```

> On Windows, if the absolute path contains spaces (e.g. the project sits
> under `New project`), `dsh plugin add` splits the argument on the space and
> pnpm fails with "not a directory". Create a space-free junction and add that
> path instead:
>
> ```bash
> cmd /c mklink /J C:\dsh-research-nudge "D:\path with spaces\dsh-research-nudge"
> dsh plugin --profile web add C:\dsh-research-nudge
> ```

Restart the DSH profile after installation.

## Default policy

| Signal | Debt |
|---|---:|
| ordinary tool call | +1 |
| file mutation | +2 |
| shell/build/test execution | +1 |
| failed tool | +4 |
| repeated equivalent failure | +6 |
| external research | reset |

A nudge is eligible when any of these becomes true:

- debt >= 20
- 15 tool calls since external research
- 15 minutes since external research

After a nudge there is a 10-minute cooldown.

Research tools are recognized by normalized names such as `web_search`, `web_fetch`, `github_search`, `docs_search`, and `fetch_url`.

## Configuration

Edit the plugin entry in the profile's Cordis configuration:

```yaml
dsh-research-nudge:
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
  researchTools:
    - web_search
    - web_fetch
    - github_search
    - docs_search
```

## Compatibility note

DeepSeek Harness is currently moving quickly. The plugin is intentionally isolated from the agent loop and registers several common Cordis tool-lifecycle event aliases. The research policy itself is fully deterministic and tested. If a future DSH build renames the lifecycle event or context-injection service, only the small adapter in `src/index.ts` needs updating; `src/policy.ts` is independent.

Use `debug: true` while validating a new DSH build.

## Privacy

No telemetry. No network calls. No API keys. The plugin only observes tool lifecycle metadata already present inside the local harness.

## License

MIT
