# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bacnd/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bacnd/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node 22 process. One in-memory store serves git smart HTTP (upload-pack v2 with a v0 fallback, receive-pack v0), the REST v3 API, GraphQL v4 and MCP — no dependencies, no git binary, no database.

## What it implements

- **Git smart HTTP**: `info/refs`, `git-upload-pack` (v2 + v0), `git-receive-pack` (v0) — clone, fetch and push against the in-memory store.
- **REST v3**: repositories, branches, commits, contents, issues, comments, labels, pull requests, files and merges.
- **GraphQL v4**: the documents `gh` and `github-mcp-server` send.
- **MCP**: Model Context Protocol over streamable HTTP — initialize, tools/list, tools/call.
- **Deterministic**: no wall-clock or randomness in responses; the harness lifecycle (`register`, `done`, exit 0) is in `main.ts`.

## Run it

```sh
node --experimental-strip-types main.ts
```

Requires Node 22.18 or later. Nothing to install.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
