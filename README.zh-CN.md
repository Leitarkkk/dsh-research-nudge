# dsh-research-nudge

[![CI](https://github.com/Leitarkkk/dsh-research-nudge/actions/workflows/ci.yml/badge.svg)](https://github.com/Leitarkkk/dsh-research-nudge/actions/workflows/ci.yml)
[![version](https://img.shields.io/github/package-json/v/Leitarkkk/dsh-research-nudge)](https://github.com/Leitarkkk/dsh-research-nudge/releases)
[![license](https://img.shields.io/github/license/Leitarkkk/dsh-research-nudge)](./LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek_Harness-0.1.0--rc.7-blue)](https://github.com/deepseek-ai/deepseek-harness)

[English](./README.md) | 简体中文

这是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**检索债务（Research Debt）提醒插件**。当 Agent 长时间只在本地读取、修改、执行，并反复遇到失败，却没有查阅外部证据时，插件会给下一步模型上下文加入一条简短提醒。

它不会额外调用 LLM，不会自行搜索，不会阻止工具，也不会强迫 Agent 上网。提醒会明确说明：如果任务是自包含的、搜索没有收益，可以正常继续。

## 它解决什么问题

Agent 有时会陷入本地试错循环：

```text
读取 → 猜测陌生 API → 修改 → 运行 → 失败 → 再修改 → 再运行 → 同样失败
```

这时，查看官方文档、搜索完整报错或已有 GitHub Issue，可能比继续试错更快。本插件把本地循环不断增加的成本表示为一个确定性的 **Research Debt** 分数。

## 一个按默认权重计算的假设示例

下面不是生产遥测或用户统计，而是严格按照默认权重计算的假设过程，用来展示分数如何越过阈值：

| 步骤 | 信号 | 新增债务 | 总债务 |
| --- | --- | ---: | ---: |
| 读取本地代码 | 普通工具 | +1 | 1 |
| 修改文件 | 变更工具 | +2 | 3 |
| 运行并失败 | 执行 + 失败 | +1 +4 | 8 |
| 再次修改 | 变更工具 | +2 | 10 |
| 再次运行并遇到等价错误 | 执行 + 失败 + 重复失败 | +1 +4 +6 | **21** |

默认阈值是 20，因此最后一次结果会携带一条额外的模型可见上下文：

```text
[Research Nudge]

你在没有查阅外部信息的情况下，通过本地工具操作积累了较高的检索债务。
请考虑：搜索官方文档、GitHub、成熟库或完整报错，是否能更快解决当前不确定性。
不要为了满足提醒而搜索；如果外部检索没有帮助，请正常继续。

Current signals: debt=21/20, tool_calls_since_research=5,
failures=2, repeated_failures=1.
```

失败指纹会忽略变化的数字和地址，因此 `TypeError at line 123` 与 `TypeError at line 456` 会被视为重复错误。检测到已配置的检索工具后，该 Agent 的累计状态会清零。

## 安装

前置要求：

- DeepSeek Harness `0.1.0-rc.7`（当前 `next` 发布线）
- Node.js `^22.19.0` 或 `>=24.0.0`，与当前 DSH 基线一致

从 GitHub 安装：

```bash
dsh plugin --profile web add github:Leitarkkk/dsh-research-nudge
```

Git 安装会执行本包的 `prepare` 构建。pnpm 可能会先拒绝执行，直到你显式信任该构建。请先检查源码，再按 DSH/pnpm 输出的准确提示设置 `allowBuilds`。建议固定 tag 或 commit，保证安装可复现：

```bash
dsh plugin --profile web add github:Leitarkkk/dsh-research-nudge#<tag-or-commit>
```

发布到 npm 后，可直接安装预构建包：

```bash
dsh plugin --profile web add dsh-research-nudge
```

检查最终配置层，然后重启 profile：

```bash
dsh --profile web --dump-config
dsh web
```

### 本地开发安装

```bash
git clone https://github.com/Leitarkkk/dsh-research-nudge.git
cd dsh-research-nudge
npm install
npm run check
dsh plugin --profile web add .
```

相对路径以执行 `dsh plugin` 时所在的目录为基准。

## 默认策略

| 信号 | 债务 |
| --- | ---: |
| 普通工具调用 | +1 |
| 文件修改 | +2 |
| shell/build/test 执行 | +1 |
| 工具失败 | +4 |
| 等价错误重复出现 | +6 |
| 检测到外部检索工具 | 清零 |

满足任一条件即可提醒：

- Research Debt 达到 20；
- 连续 15 次工具调用没有检索；
- 15 分钟没有检索。

提醒后进入 10 分钟冷却期。工具名会先归一化，因此 `WebSearch`、`web_search` 和 `web-search` 能被一致识别。

## 配置

bundle 会插入 id 为 `research-nudge` 的配置行。在 profile 的 `cordis.patch.yml` 中按该 id 覆盖：

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
    researchTools:
      - web_search
      - web_fetch
      - github_search
      - docs_search
      - fetch_url
    debug: false
```

DSH patch 会替换目标行的整个 `config`，而不是深度合并。上例中省略的字段会回到本插件 schema 的默认值。还可以通过 `reminder` 设置自定义提醒文本。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 是否注册 lifecycle listener |
| `debtThreshold` | `20` | Research Debt 触发阈值 |
| `maxToolCallsWithoutResearch` | `15` | 无检索工具调用次数阈值 |
| `maxMinutesWithoutResearch` | `15` | 无检索时间阈值（分钟） |
| `cooldownMinutes` | `10` | 两次提醒之间的最短时间 |
| `ordinaryToolDebt` | `1` | 普通本地工具权重 |
| `mutationDebt` | `2` | 写入、修改、删除类工具权重 |
| `executionDebt` | `1` | shell、构建、测试类工具权重 |
| `failureDebt` | `4` | 失败结果附加权重 |
| `repeatedFailureDebt` | `6` | 等价错误重复出现的附加权重 |
| `researchTools` | 常见 web/docs/GitHub 工具名 | 归一化后做子串匹配，命中则清零 |
| `reminder` | 内置提醒文本 | 注入模型上下文的正文 |
| `debug` | `false` | 向 stderr 记录清零和提醒事件 |

## 与 DSH 的集成方式

插件监听当前的 `tools/post-execute` waterfall，读取官方类型 `ToolExecution` 与 `ToolExecutionResult`，通过 `next()` 委托后续 listener，再用官方 `createUserMessage(...)` 创建 notice，并通过 `PostToolDecision.additionalContexts` 前置加入。原有 accept/block 决策和其他上下文都会保留。

插件不通过 `ctx` 读取任何 Service，因此不需要声明 Cordis service injection。状态保存在按 Agent 区分的 `WeakMap` 中，随 Agent/runtime 一起消失。

## 兼容性

适配层以官方 `@deepseek-ai/dsh-tools` 和 `@deepseek-ai/dsh-llm` `0.1.0-rc.7` 契约编译并测试。DSH 仍处于 Developer Preview，官方明确说明会出现破坏性变更。如果后续版本修改工具 waterfall 或消息契约，只需调整 `src/index.ts` 的小型适配层；`src/policy.ts` 中的确定性策略与 DSH 解耦。

## 隐私与安全

- 无遥测、无网络请求、无 API Key、无额外模型调用。
- 不保存或复制工具参数。
- 内存中的失败指纹只使用失败结果文本，不会持久化。
- 提醒仅供参考，不修改工具结果或权限决策。
- Git 安装会执行本地构建脚本；允许前请审查并固定第三方代码版本。

## 开发

```bash
npm ci
npm run check
npm pack --dry-run
```

贡献说明见 [CONTRIBUTING.md](https://github.com/Leitarkkk/dsh-research-nudge/blob/master/CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE)
