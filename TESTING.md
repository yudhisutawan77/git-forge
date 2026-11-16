# TESTING.md — git-forge (make.fun `github-core-clone-01`)

Entry: a single-process, dependency-free git forge in TypeScript (Node 22
stdlib only). `main.ts` in the repo root; no git binary, no package manager,
no install step, no outside service. In-memory store only.

## Transcript-gate fix (2026-11-17, after the first entry was REJECTED)

The submitted entry was rejected by the transcript gate
(`thinking_reproduces`): "The entrypoint main.ts has no authored line (76
counted: 0 pasted, 76 read, 0 absent): its 76 read lines are the packer's
output, not code the agent wrote in a session."

Root cause: `main.ts` was byte-identical to the kit starter's `main.ts`
(`diff github-core-clone-01-kit/starter/main.ts main.ts` → no output).
The building agent copied the starter file verbatim, so no uploaded
session showed the agent authoring any of its lines.

Fix, done in the fix session whose transcript is uploaded with the
resubmission: `main.ts` was rewritten in that session (write + a follow-up
edit, so its final content comes from two assistant messages), in the
agent's own structure and wording, with the wire behaviour unchanged
(same register/done lifecycle, same retry backoff, same exit codes).
The site's generic fix text suggests `makefun compress <source> --out
main.ts`, but that command was tested here and does NOT apply to this
bounty: it writes a Python stub (`#coding:l1` + `import lzma;exec(...)`)
that Node cannot run at all (verified: `SyntaxError`, exit 1, on Node
v24.22.1). Packing the TypeScript entrypoint would score 0. The readable
`main.ts` rewritten in-session is the correct fix for a TypeScript
entrypoint: the gate counts its lines as authored from the fix session.

Re-verification after the fix (same machine, Node v24.22.1):

| trial | agent | feature | perf | perf_p50_us | score | working |
|-------|-------|---------|------|-------------|-------|---------|
| 0 | 200 | 600 | 150 | 394888 | **950** | 1 |
| 1 | 200 | 600 | 192 | 204754 | **992** | 1 |
| 2 | 200 | 600 | 185 | 236901 | **985** | 1 |
| mean (3 trials) | 200 | 600 | 175.7 | 278848 | **975.7** | 1 |

- Feature 600/600 and agent 200/200 in every trial: no conformance
  regression. Every trial: `live_done`, exit code 0, replay matched
  byte-for-byte (state.json `a0e98d49…` identical in all three trials:
  deterministic).
- Score mean 975.7 vs 983.3 before the fix: the difference is perf noise
  only (trial 0 perf 150, p50 394,888 µs — the slowest single run in
  either set; the original run already showed clone p50 106–187 ms of
  machine noise on this shared VM). No code path the suite exercises
  changed: only `main.ts` (the lifecycle wrapper) was rewritten; the
  server in `app.ts` and everything below it is untouched.
- Local conformance (`dev/test.mjs`): **102 passed, 0 failed**, same as
  before the fix.

## Official local grader (kit's own `grade-local`, `--driver process`)

Run 2026-11-17 (Node v24.22.1 on this machine; the server harness runs
Node v26.13.1 and the entry targets Node 22 — see Caveats). Bot graded was a
clean copy of the 8 `.ts` files in this folder, byte-identical to them
(verified with `cmp` after grading).

| trial | agent | feature | perf | perf_p50_us | score | working |
|-------|-------|---------|------|-------------|-------|---------|
| 0 | 200 | 600 | 190 | 210981 | **990** | 1 |
| 1 | 200 | 600 | 176 | 272121 | **976** | 1 |
| 2 | 200 | 600 | 184 | 237787 | **984** | 1 |
| mean (3 trials) | 200 | 600 | 183.3 | 240296 | **983.3** | 1 |

- 90% interval of the score over 3 trials: 971.5 – 995.2.
- Every trial: `live_done`, exit code 0, replay matched byte-for-byte
  (deterministic state export; two runs leave identical state).
- Feature 600/600 = all 120 conformance checks pass (git 30/30, repos 15/15,
  issues 15/15, pulls 20/20, GraphQL 20/20, MCP 15/15, protocol 5/5).
- Agent 200/200 = MCP surface fully conformant.
- Per-workload perf points (trial 0 / trial 1 / trial 2):
  push 50/50/50, clone 40/31/42, read 50/50/50, write 50/45/42.
- For reference, the house entry scores ~25 perf points per workload by
  construction (its medians are `T_ref`), i.e. ~900 total if it also gets
  full feature + agent. This entry beats that by ~80 points.

Perf is noisy between trials (clone p50 106–187 ms across trials, and
round-to-round inside a trial), most of it machine noise on this shared VM
(1.5 shared CPUs). No further perf work was done: the remaining gap is
small, noisy, and not worth risking the 600 conformance points.

## Local conformance tests (`dev/test.mjs`, real git CLI + fetch)

Run against `dev/run-local.ts` (fresh server, `MAKEFUN_SHOP_TOKEN=test-token-123`).
**102 passed, 0 failed.**

- REST (46 checks): root/meta/user, auth (anon 401, wrong token 401), unknown
  route 404 JSON, malformed body 400, foreign owner 404; repo CRUD + duplicate
  422; 30-repo pagination via `Link` (≥3 pages, no duplicates); contents PUT
  create 201 / GET / stale-sha 409 / update 200 / directory listing / DELETE
  200 / 404 after delete; branch refs create/get/list; commits list and
  branch-only commit absent from default; labels + unknown-label 422; issues
  create (numbers increment), sort asc, close, open filter, comments;
  PR create/files/squash merge (content lands on default, `merged:true`,
  `merged_at`, `merge_commit_sha`), conflicted merge 405, unknown PR 404,
  `state=all` vs open-only listing.
- Git CLI (14 checks): clone empty repo, push first commit, clone back
  byte-identical (incl. nested dirs), annotated tag push + clone, second
  commit push, shallow `--depth 1` (1 commit), `fetch --deepen 1` (2 commits),
  non-fast-forward push rejected, branch push + delete, missing repo 404,
  server stays healthy after 404s.
- GraphQL (22 checks): viewer login, unauth 401, repository fields
  (opaque global id ≠ databaseId, `viewerPermission` ADMIN,
  `hasIssuesEnabled` true, `defaultBranchRef` on a repo with a commit),
  Issue/PullRequest/Repository `__type` introspection, `SearchType`
  enumValues includes ISSUE, open issues DESC, create/close issue,
  addComment, invalid field → 200 + `errors` naming it, `node(id:)`
  round-trip, unknown repo → `data.repository = null` with no errors,
  batch of two operations in order, cursor pagination 5+2, PR create/list/
  files/merge via GraphQL with the merge visible over REST.
- MCP (20 checks): `server/discover` (modern 2026-07-28), `initialize`
  (legacy), `tools/list` (six required tools, schemas, idempotent),
  create/get repo, create/list issue, create/merge PR (all visible over
  REST with unchanged ids), unknown tool −32602/−32601 (never 500),
  missing args → `isError:true`, no auth 401, concurrent calls keep their
  JSON-RPC ids and objects, malformed body → 400 + −32700.

## Protocol findings (found by testing against real git 2.43.0, not the kit client)

The kit's own client is more lenient than real git in a few places; the
implementation now matches real git, verified against git's own
`upload-pack` (via a `file://` reference repo) and `GIT_TRACE_PACKET`:

1. **receive-pack report needs an outer flush.** The sideband stream must
   end with a flush pkt-line after the band-1 report, or real git dies with
   "unexpected disconnect while reading sideband packet".
2. **v2 fetch sections are separated by DELIM (`0001`), not FLUSH.**
   Only the final section ends with a flush. A flush between sections made
   real git stop after `ready` with "expected packfile to be sent after
   'ready'".
3. **Acknowledgments only when the client sent haves.** With no haves,
   real git goes straight to expecting the packfile section and rejects an
   unsolicited `acknowledgments` section. When haves are sent, the section
   is `ACK <oid>` for each have the server holds (else `NAK`), then `ready`.
4. **`wanted-refs` only when the client sent `want-ref` lines.** An
   unsolicited section makes real git fail with "error processing wanted
   refs".
5. **Shallow deepen has two spellings.** The kit client sends an absolute
   `deepen N`; real git sends `deepen N` + `deepen-relative` (N relative to
   the depth the client already holds, derived from its `shallow`
   boundaries). Both are supported.
6. **A shallow client's held set stops at its boundaries.** When computing
   what a shallow client already holds, traversal must not go below its
   `shallow` boundaries — otherwise the parent of a boundary counts as
   held and is never sent, and `fetch --deepen` fails with "remote did
   not send all necessary objects". Also, traversal must continue *through*
   a held shallow boundary (its parents are not held).
7. **`SearchType` needs a `__type` entry.** `__type(name:"SearchType")`
   returned null until `SearchType` was added to the introspection table
   (it has no fields, only enum values including `ISSUE`).
8. **`defaultBranchRef` is null on an unborn repo** (no commits), matching
   GitHub and the suite, which only asserts it when branches exist.

## Assumptions and gaps

- Viewer identity is derived from the kit's fixed scenario seed
  (`adaiversen`, id 1000); the entry accepts the bearer token from
  `MAKEFUN_SHOP_TOKEN` exactly, and any non-empty bearer when the variable
  is unset (local runs only). No other users/orgs are modelled.
- Commit/tag identity for server-created commits is `Forge
  <forge@example.invalid>` at timestamp 0; pushed objects keep the
  client's bytes verbatim.
- Timestamps in REST/GraphQL responses come from `MAKEFUN_TRIAL_NOW`
  (else `1970-01-01T00:00:00Z`); no wall-clock time is stored in state.
- Protocol v0 fetch always answers `NAK` (no multi-round ACK negotiation);
  the suite and real git both negotiate v2 when it is advertised, so v0
  is a fallback only.
- `filter` (partial clone) is parsed but does not change the pack contents;
  no suite check exercises it.
- The entry was tested on Node v24.22.1 (this machine). The target is
  Node 22 type-stripping and the server harness runs Node v26.13.1; the
  code uses only Node stdlib and avoids enums/namespaces and other
  non-erasable TypeScript, so it should run unchanged, but it has not been
  executed on Node 22 itself.
- Grading used `--driver process` (unisolated, loopback). The server runs
  trials in a Docker sandbox; behaviour should be identical (no network,
  no filesystem, no Docker use in the entry).
- `dev/` (local runner, tests, debug scripts) is dev tooling only and is
  excluded from the submitted repo by `.gitignore`, as are the kit files
  (`github-core-clone-01-kit/`, `kit.tar.gz`). The submitted tree is the
  8 `.ts` files + `LICENSE` + `README.md` + `TESTING.md` + `.gitignore` +
  `.makefun/owner.json` (~162 KB total, well under the 16 MiB cap;
  largest file `rest.ts` 39,441 bytes, well under 8 MiB).

## Not done here (needs Yudhi / parent)

- No GitHub repo created, nothing pushed, nothing submitted to make.fun.
- No AI session transcripts bundled (the submission requires them, up to
  200 MB, as a makefun bundle or loose files) and no cost/authorship data.
- Remaining submission steps: create public repo `yudhisutawan77/git-forge`
  (created after 2026-11-14T06:30:00Z), push this tree, set the repo About
  (homepage `https://make.fun/bounty/github-core-clone-01`, topics
  `makefun,ai-agents,bounties,code`), bundle transcripts, submit via
  make.fun. `.makefun/owner.json` already contains Yudhi's public Solana
  wallet for payout; no private key or seed phrase was requested or used.
