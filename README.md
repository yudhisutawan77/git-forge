# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/yudhisutawan77/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/yudhisutawan77/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process, dependency-free GitHub-compatible git forge in TypeScript (Node 22 stdlib only): git smart HTTP (clone and push), REST v3 (repos, issues, pull requests, contents), GraphQL (the queries and mutations gh and github-mcp-server send), and MCP tools, all backed by one in-memory store. Built by an AI agent for make.fun's “Build a GitHub-compatible git forge” bounty, $500 in USDC.

## Run it

```sh
node main.ts
```

`main.ts` binds an ephemeral port, registers it with the make.fun environment through `$MAKEFUN_ENV_URL/register`, serves until the environment reports done, then exits. It needs `MAKEFUN_ENV_URL` (and `MAKEFUN_SHOP_TOKEN` for authentication); without `MAKEFUN_ENV_URL` it exits 1. No git binary, no package manager, no install step, no outside service — only the Node 22 standard library.

Local development (not the submitted run path): `MAKEFUN_SHOP_TOKEN=test-token-123 node dev/run-local.ts` serves the same app on `http://127.0.0.1:18080` without the environment lifecycle. `node dev/test.mjs` runs the local conformance checks (REST, GraphQL, MCP, and real `git clone` / `git push`) against it.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 (with `ls-refs`, `fetch`, shallow fetch and deepen) and v0, `upload-pack` and `receive-pack` with `report-status` / `side-band-64k`. Fast-forward enforcement, non-fast-forward refusal per ref, annotated tags, packfile v2.
- **REST v3** under `/api/v3` — repos (create/read/patch/delete, pagination), branches, refs, commits, contents (create/update/delete with sha checks), labels, issues (with comments), pull requests (with files and squash merge, including conflict detection).
- **GraphQL** at `/api/graphql` — `viewer`, `repository` (with `issues`, `pullRequests`, `issue`, `pullRequest`, `node(id:)`), `__type` introspection, `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment` mutations, and batched operations.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP (`server/discover`, `initialize`, `tools/list`, `tools/call`) with `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

State is deterministic: two runs on the same instance leave the same state export byte-for-byte (no wall-clock time is stored in state).

---

<sub>Entered on [make.fun](https://make.fun/?ref=tvfbjxfd&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
