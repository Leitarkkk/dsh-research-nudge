# Contributing

Thanks for helping improve `dsh-research-nudge`.

## Before opening a change

- Use an issue for behavior changes or new policy signals so the trade-off can be discussed first.
- Keep the reminder advisory: it must not force research, block tools, or add model calls.
- Treat DeepSeek Harness as an unstable Developer Preview dependency. Confirm lifecycle and message contracts against the current official source instead of guessing from old examples.

## Development setup

This project follows the Node.js versions supported by the current DSH release (`^22.19.0 || >=24.0.0`).

```bash
git clone https://github.com/Leitarkkk/dsh-research-nudge.git
cd dsh-research-nudge
npm ci
npm run check
npm pack --dry-run
```

## Pull requests

- Make one focused change per pull request.
- Add or update deterministic policy tests for scoring changes.
- Add or update adapter tests for lifecycle, context ordering, or DSH API changes.
- Update both `README.md` and `README.zh-CN.md` when user-facing behavior changes.
- Do not commit `node_modules`, `lib`, tarballs, credentials, or local DSH profile files.
- Describe the DSH version/API used for verification and include the commands you ran.

The maintainer will only release after CI passes and the packed file list has been reviewed.
