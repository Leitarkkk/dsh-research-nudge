# dsh-research-nudge

DeepSeek Harness 的“检索债务”插件。

它监控 Agent 在**没有外部检索**的情况下进行了多少次本地工具调用、文件修改、命令执行以及重复失败。当“继续本地试错”的成本已经明显升高时，向 Agent 上下文注入一条 Research Nudge，提醒它考虑：

- 查官方文档；
- 搜 GitHub Issue / 已有实现；
- 检查是否已经存在成熟库；
- 对重复报错搜索完整错误信息。

插件**不会强制搜索**。提醒中明确告诉 Agent：如果当前任务是自包含的、搜索没有收益，可以直接忽略。

## 安装

> 当前状态：包尚未发布到 npm，GitHub 仓库也尚未创建——目前只有下面的**本地开发**方式是可用。

npm 发布后：

```bash
dsh plugin --profile web add dsh-research-nudge
```

GitHub：

```bash
dsh plugin --profile web add github:Leitarkkk/dsh-research-nudge
```

从 GitHub 安装会现场构建（`prepare`）。pnpm 10 默认拦截构建脚本：如果 `dsh plugin` 提示构建被拦，把提示中给出的包名加到 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 下再重试。

本地：

```bash
npm install
npm run check
dsh plugin --profile web add /absolute/path/to/dsh-research-nudge
```

> Windows 上如果绝对路径含空格（例如项目在 `New project` 目录下），`dsh plugin add` 会把参数在空格处拆开，pnpm 报 "not a directory"。先建一个无空格的 junction 再加它：
>
> ```bash
> cmd /c mklink /J C:\dsh-research-nudge "D:\含空格的路径\dsh-research-nudge"
> dsh plugin --profile web add C:\dsh-research-nudge
> ```

## 默认规则

普通工具调用 +1；修改文件 +2；执行 shell/build/test +1；失败 +4；相同错误重复失败额外 +6。

满足任一条件就可以提醒：

- Research Debt >= 20
- 连续 15 次工具调用没有外部检索
- 连续 15 分钟没有外部检索

提醒后冷却 10 分钟。检测到 `web_search`、`web_fetch`、`github_search`、`docs_search`、`fetch_url` 等外部研究工具后清零。

## 特点

- 不额外调用 LLM，正常情况下 0 token 开销；
- 不联网、不上传遥测；
- 不强制 Agent 搜索；
- Research Debt 算法与 DSH 适配层分离，方便 Harness API 变化后快速适配；
- 对工具名做归一化，因此 `WebSearch` / `web_search` / `web-search` 都能识别。

## 开发

```bash
npm install
npm run check
```

如果 DSH developer preview 更新了工具生命周期事件名，可在配置中先打开 `debug: true`，然后只需要调整 `src/index.ts` 的事件适配层。

MIT License.
