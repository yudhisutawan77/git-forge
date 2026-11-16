// GitHub REST v3: repos, branches, commits, contents, labels, issues,
// comments and pull requests. All state lives in store.ts; this file is the
// HTTP shape around it. Domain operations are exported for the GraphQL and
// MCP surfaces, which must read and write the same objects.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildCommit,
  buildTreeForFiles,
  createRepoRecord,
  decodeGlobalId,
  defaultTip,
  flattenTree,
  getRepo,
  globalId,
  hashObject,
  isOid,
  mergeBase,
  parseCommit,
  parseTree,
  repoKey,
  resolveRef,
  type GitObject,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------------------------

export function requestId(store: Store): string {
  store.reqCounter += 1;
  return `req-${store.reqCounter}`;
}

export function sendJson(
  store: Store,
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(store),
    ...extra,
  });
  res.end(text);
}

function sendEmpty(store: Store, res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': requestId(store), ...extra });
  res.end();
}

function err(store: Store, res: ServerResponse, status: number, message: string): void {
  sendJson(store, res, status, { message });
}

export function isAuthenticated(req: IncomingMessage, store: Store): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  const token = match[1] as string;
  if (store.token !== '') return token === store.token;
  return token.length > 0;
}

function parseBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function pageParams(query: URLSearchParams, defaultPerPage = 30): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const rawPerPage = parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, rawPerPage)) : defaultPerPage;
  return { page, perPage };
}

function pageLink(req: IncomingMessage, query: URLSearchParams, page: number, perPage: number, rel: string): string {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  void query;
  return `<${url.toString()}>; rel="${rel}"`;
}

function paginate<T>(items: T[], query: URLSearchParams, defaultPerPage = 30): T[] {
  const { page, perPage } = pageParams(query, defaultPerPage);
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

// ---------------------------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------------------------

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.viewer.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    fork: false,
    created_at: store.trialNow,
    updated_at: store.trialNow,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
    user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
    comments: issue.comments.length,
    created_at: store.trialNow,
    updated_at: store.trialNow,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    created_at: store.trialNow,
    updated_at: store.trialNow,
  };
}

// ---------------------------------------------------------------------------------------------
// domain operations (shared with GraphQL and MCP)
// ---------------------------------------------------------------------------------------------

export function createIssueInRepo(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; labels?: unknown },
): { issue: Issue } | { error: string; status: number } {
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') return { error: 'title is required', status: 422 };
  const labels: Label[] = [];
  const rawLabels = Array.isArray(input.labels) ? input.labels : [];
  for (const raw of rawLabels) {
    const name = typeof raw === 'string' ? raw : isRecord(raw) ? String(raw.name ?? '') : '';
    const label = repo.labels.get(name);
    if (!label) return { error: `label ${name} does not exist`, status: 422 };
    labels.push(label);
  }
  const issue: Issue = {
    id: store.nextObjectId,
    number: repo.nextNumber,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels,
    comments: [],
    seq: repo.nextNumber,
  };
  store.nextObjectId += 1;
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return { issue };
}

export function getIssue(repo: Repo, number: number): Issue | undefined {
  return repo.issues.find((issue) => issue.number === number);
}

export function getPull(repo: Repo, number: number): Pull | undefined {
  return repo.pulls.find((pull) => pull.number === number);
}

export function listIssuesFiltered(
  repo: Repo,
  query: URLSearchParams,
): Issue[] {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  if (sort === 'created') {
    items = [...items].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  return items;
}

export function listPullsFiltered(repo: Repo, query: URLSearchParams): Pull[] {
  const state = query.get('state') ?? 'open';
  let items = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
  items = [...items].sort((a, b) => b.seq - a.seq);
  return items;
}

export function createPullInRepo(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): { pull: Pull } | { error: string; status: number } {
  const headSha = resolveRef(repo, input.head);
  const baseSha = resolveRef(repo, input.base);
  if (headSha === null) return { error: `head branch ${input.head} does not exist`, status: 422 };
  if (baseSha === null) return { error: `base branch ${input.base} does not exist`, status: 422 };
  const existing = repo.pulls.find(
    (pull) => pull.state === 'open' && pull.head === input.head && pull.base === input.base,
  );
  if (existing) return { error: 'a pull request is already open for this head and base', status: 422 };
  const pull: Pull = {
    id: store.nextObjectId,
    number: repo.nextNumber,
    title: input.title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    head: input.head,
    base: input.base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeSha: null,
    seq: repo.nextNumber,
  };
  store.nextObjectId += 1;
  repo.nextNumber += 1;
  repo.pulls.push(pull);
  return { pull };
}

/** The line diff between two blobs, counted by lines (LCS over lines). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // Drop a trailing empty line produced by a final newline on both sides.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      (dp[i] as number[])[j] = oldLines[i] === newLines[j]
        ? (dp[i + 1] as number[])[j + 1] + 1
        : Math.max((dp[i + 1] as number[])[j], (dp[i] as number[])[j + 1]);
    }
  }
  const lcs = (dp[0] as number[])[0];
  return { additions: m - lcs, deletions: n - lcs };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export function diffFilesForPull(store: Store, repo: Repo, pull: Pull): FileChange[] {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const baseTip = resolveRef(repo, pull.base) ?? pull.baseSha;
  const base = mergeBase(lookup, pull.headSha, baseTip) ?? pull.baseSha;
  const baseCommit = lookup(base);
  const headCommit = lookup(pull.headSha);
  if (!baseCommit || !headCommit || baseCommit.type !== 'commit' || headCommit.type !== 'commit') return [];
  const baseTree = flattenTree(lookup, parseCommit(baseCommit.data).tree);
  const headTree = flattenTree(lookup, parseCommit(headCommit.data).tree);
  const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const before = baseTree.get(path);
    const after = headTree.get(path);
    if (!before && after) {
      const blob = lookup(after.oid);
      const text = blob ? blob.data.toString('utf8') : '';
      const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (before && !after) {
      const blob = lookup(before.oid);
      const text = blob ? blob.data.toString('utf8') : '';
      const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (before && after && before.oid !== after.oid) {
      const oldBlob = lookup(before.oid);
      const newBlob = lookup(after.oid);
      const { additions, deletions } = lineDiff(
        oldBlob ? oldBlob.data.toString('utf8') : '',
        newBlob ? newBlob.data.toString('utf8') : '',
      );
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Would a squash merge of this pull conflict with the current base tip? */
export function pullConflicts(store: Store, repo: Repo, pull: Pull): boolean {
  void store;
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const baseTip = resolveRef(repo, pull.base) ?? pull.baseSha;
  const base = mergeBase(lookup, pull.headSha, baseTip);
  if (base === null) return true;
  const baseCommit = lookup(base);
  const headCommit = lookup(pull.headSha);
  const tipCommit = lookup(baseTip);
  if (!baseCommit || !headCommit || !tipCommit) return true;
  const baseTree = flattenTree(lookup, parseCommit(baseCommit.data).tree);
  const headTree = flattenTree(lookup, parseCommit(headCommit.data).tree);
  const tipTree = flattenTree(lookup, parseCommit(tipCommit.data).tree);
  const paths = new Set<string>([...baseTree.keys(), ...headTree.keys(), ...tipTree.keys()]);
  for (const path of paths) {
    const b = baseTree.get(path)?.oid;
    const h = headTree.get(path)?.oid;
    const t = tipTree.get(path)?.oid;
    if (h !== b && t !== b && h !== t) return true;
  }
  return false;
}

export function pullMergeable(store: Store, repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
  return pullConflicts(store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

export function mergePull(
  store: Store,
  repo: Repo,
  pull: Pull,
): { status: number; value: Record<string, unknown> } {
  if (pull.merged || pull.state !== 'open') {
    return { status: 405, value: { message: 'Pull request is already merged or closed' } };
  }
  if (pullConflicts(store, repo, pull)) {
    return { status: 405, value: { message: 'Merge conflict' } };
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const baseTip = resolveRef(repo, pull.base) ?? pull.baseSha;
  const headCommit = lookup(pull.headSha);
  if (!headCommit) return { status: 405, value: { message: 'Head commit not found' } };
  const tree = parseCommit(headCommit.data).tree;
  const message = pull.title;
  const commitData = buildCommit(tree, [baseTip], message);
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${pull.base}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.trialNow;
  pull.mergeSha = commitOid;
  return {
    status: 200,
    value: { sha: commitOid, merged: true, message: `Pull request #${pull.number} successfully merged` },
  };
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

export function storeObject(repo: Repo, obj: GitObject): string {
  const oid = hashObject(obj.type, obj.data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
  return oid;
}

function findTreeOid(repo: Repo, rootTreeOid: string, dirPath: string): string | null {
  if (dirPath === '') return rootTreeOid;
  let current = rootTreeOid;
  for (const segment of dirPath.split('/')) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

export function putContentFile(
  store: Store,
  repo: Repo,
  path: string,
  input: Record<string, unknown>,
): { status: number; value: Record<string, unknown> } {
  const message = typeof input.message === 'string' ? input.message : `Update ${path}`;
  const contentB64 = typeof input.content === 'string' ? input.content : '';
  const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
  const sha = typeof input.sha === 'string' ? input.sha : undefined;
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  } catch {
    return { status: 422, value: { message: 'content is not valid base64' } };
  }
  // Resolve the branch, creating it from the default tip when it does not exist yet.
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    tip = defaultTip(repo) ?? undefined;
    if (tip !== undefined) repo.refs.set(`refs/heads/${branch}`, tip);
  }
  const baseTree = tip === undefined ? null : parseCommit((repo.objects.get(tip) as GitObject).data).tree;
  const flat = baseTree === null ? new Map() : flattenTree((oid) => repo.objects.get(oid), baseTree);
  const existing = flat.get(path);
  const blobOid = storeObject(repo, { type: 'blob', data: content });
  if (existing) {
    if (sha === undefined) return { status: 422, value: { message: 'sha is required to update a file' } };
    if (sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { status: 409, value: { message: 'sha does not match the current file' } };
    }
  }
  const files = new Map<string, { mode: string; oid: string } | null>();
  files.set(path, { mode: '100644', oid: blobOid });
  const newTree = buildTreeForFiles(
    (oid) => repo.objects.get(oid),
    (obj) => storeObject(repo, obj),
    baseTree,
    files,
  );
  const parents = tip === undefined ? [] : [tip];
  const commitOid = storeObject(repo, { type: 'commit', data: buildCommit(newTree, parents, message) });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  const status = existing ? 200 : 201;
  return {
    status,
    value: {
      content: {
        name: path.split('/').pop() as string,
        path,
        sha: blobOid,
        size: content.length,
        type: 'file',
        encoding: 'base64',
        content: content.toString('base64'),
      },
      commit: { sha: commitOid, message },
    },
  };
}

export function getContentAt(
  store: Store,
  repo: Repo,
  path: string,
  ref: string | null,
): { status: number; value: unknown } {
  void store;
  const tip = ref !== null ? resolveRef(repo, ref) : defaultTip(repo);
  if (tip === null) return { status: 404, value: { message: 'Not Found' } };
  const tipObj = repo.objects.get(tip);
  if (!tipObj || tipObj.type !== 'commit') return { status: 404, value: { message: 'Not Found' } };
  const rootTree = parseCommit(tipObj.data).tree;
  const flat = flattenTree((oid) => repo.objects.get(oid), rootTree);
  if (path === '') {
    return { status: 200, value: directoryListing(repo, rootTree, '', flat) };
  }
  const file = flat.get(path);
  if (file) {
    const blob = repo.objects.get(file.oid);
    if (!blob) return { status: 404, value: { message: 'Not Found' } };
    return {
      status: 200,
      value: {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop() as string,
        path,
        sha: file.oid,
        content: blob.data.toString('base64'),
      },
    };
  }
  // A directory: any path with this prefix.
  const prefix = `${path}/`;
  const children = new Map<string, { isDir: boolean; oid: string }>();
  for (const [key, entry] of flat) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) children.set(rest, { isDir: false, oid: entry.oid });
    else children.set(rest.slice(0, slash), { isDir: true, oid: '' });
  }
  if (children.size === 0) return { status: 404, value: { message: 'Not Found' } };
  const listing: Array<Record<string, unknown>> = [];
  for (const [name, child] of [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (child.isDir) {
      const treeOid = findTreeOid(repo, rootTree, `${path}/${name}`);
      listing.push({ type: 'dir', name, path: `${path}/${name}`, sha: treeOid ?? '' });
    } else {
      listing.push({ type: 'file', name, path: `${path}/${name}`, sha: child.oid });
    }
  }
  return { status: 200, value: listing };
}

function directoryListing(repo: Repo, rootTree: string, dirPath: string, flat: Map<string, { mode: string; oid: string }>): Array<Record<string, unknown>> {
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const children = new Map<string, { isDir: boolean; oid: string }>();
  for (const [key, entry] of flat) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) children.set(rest, { isDir: false, oid: entry.oid });
    else children.set(rest.slice(0, slash), { isDir: true, oid: '' });
  }
  const listing: Array<Record<string, unknown>> = [];
  for (const [name, child] of [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (child.isDir) {
      const treeOid = findTreeOid(repo, rootTree, dirPath === '' ? name : `${dirPath}/${name}`);
      listing.push({ type: 'dir', name, path: dirPath === '' ? name : `${dirPath}/${name}`, sha: treeOid ?? '' });
    } else {
      listing.push({ type: 'file', name, path: dirPath === '' ? name : `${dirPath}/${name}`, sha: child.oid });
    }
  }
  return listing;
}

export function deleteContentFile(
  store: Store,
  repo: Repo,
  path: string,
  input: Record<string, unknown>,
): { status: number; value: Record<string, unknown> } {
  const message = typeof input.message === 'string' ? input.message : `Delete ${path}`;
  const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
  const sha = typeof input.sha === 'string' ? input.sha : undefined;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return { status: 404, value: { message: 'Not Found' } };
  const tipObj = repo.objects.get(tip);
  if (!tipObj || tipObj.type !== 'commit') return { status: 404, value: { message: 'Not Found' } };
  const baseTree = parseCommit(tipObj.data).tree;
  const flat = flattenTree((oid) => repo.objects.get(oid), baseTree);
  const existing = flat.get(path);
  if (!existing) return { status: 404, value: { message: 'Not Found' } };
  if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
    return { status: 409, value: { message: 'sha does not match the current file' } };
  }
  const files = new Map<string, { mode: string; oid: string } | null>();
  files.set(path, null);
  const newTree = buildTreeForFiles(
    (oid) => repo.objects.get(oid),
    (obj) => storeObject(repo, obj),
    baseTree,
    files,
  );
  const commitOid = storeObject(repo, { type: 'commit', data: buildCommit(newTree, [tip], message) });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return { status: 200, value: { content: null, commit: { sha: commitOid, message } } };
}

// ---------------------------------------------------------------------------------------------
// commits listing
// ---------------------------------------------------------------------------------------------

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: '' };
  const epoch = Number(match[3]);
  return { name: match[1] as string, email: match[2] as string, date: new Date(epoch * 1000).toISOString() };
}

function listCommits(repo: Repo, ref: string | null): Array<Record<string, unknown>> {
  const tip = ref !== null ? resolveRef(repo, ref) : defaultTip(repo);
  if (tip === null) return [];
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    const author = parseIdent(parsed.author);
    const committer = parseIdent(parsed.committer);
    out.push({
      sha: oid,
      commit: {
        message: parsed.message,
        author: { name: author.name, email: author.email, date: author.date },
        committer: { name: committer.name, email: committer.email, date: committer.date },
        tree: { sha: parsed.tree },
      },
      author: { login: storeViewerLogin(repo) },
      parents: parsed.parents.map((parent) => ({ sha: parent })),
    });
    for (let i = parsed.parents.length - 1; i >= 0; i -= 1) stack.push(parsed.parents[i] as string);
  }
  return out;
}

function storeViewerLogin(repo: Repo): string {
  return repo.owner;
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment !== '');
}

export function handleRest(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    pathname = '/';
  }
  if (!pathname.startsWith('/api/v3')) return false;
  const method = req.method ?? 'GET';
  const query = queryOf(req);

  if (!isAuthenticated(req, store)) {
    err(store, res, 401, 'Requires authentication');
    return true;
  }

  const rest = pathname.slice('/api/v3'.length);
  const parts = splitPath(rest);
  const needsJson = method === 'POST' || method === 'PUT' || method === 'PATCH';
  let parsed: { ok: true; value: unknown } | { ok: false } = { ok: true, value: undefined };
  if (needsJson || (method === 'DELETE' && body.length > 0)) {
    parsed = parseBody(body);
    if (!parsed.ok) {
      err(store, res, 400, 'Invalid JSON');
      return true;
    }
  }
  const input = isRecord(parsed.ok ? parsed.value : undefined) ? (parsed.value as Record<string, unknown>) : {};

  // GET /api/v3/ — the API root.
  if ((rest === '' || rest === '/') && method === 'GET') {
    sendJson(store, res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  // GET /api/v3/meta
  if (rest === '/meta' && method === 'GET') {
    sendJson(store, res, 200, { installed_version: '1.0.0' });
    return true;
  }
  // GET /api/v3/user
  if (rest === '/user' && method === 'GET') {
    sendJson(store, res, 200, {
      login: store.viewer.login,
      id: store.viewer.id,
      name: store.viewer.name,
      email: store.viewer.email,
      type: 'User',
    });
    return true;
  }
  // /api/v3/user/repos
  if (rest === '/user/repos') {
    if (method === 'GET') {
      const repos = [...store.repos.values()]
        .filter((repo) => repo.owner === store.viewer.login)
        .sort((a, b) => a.id - b.id);
      const { page, perPage } = pageParams(query);
      const start = (page - 1) * perPage;
      const slice = repos.slice(start, start + perPage);
      const extra: Record<string, string> = {};
      if (start + perPage < repos.length) extra.link = pageLink(req, query, page + 1, perPage, 'next');
      sendJson(store, res, 200, slice.map((repo) => repoJson(store, repo)), extra);
      return true;
    }
    if (method === 'POST') {
      const name = typeof input.name === 'string' ? input.name : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        err(store, res, 422, 'Invalid repository name');
        return true;
      }
      if (store.repos.has(repoKey(store.viewer.login, name))) {
        err(store, res, 422, 'Repository already exists');
        return true;
      }
      const repo = createRepoRecord(
        store,
        name,
        typeof input.description === 'string' ? input.description : '',
        input.private === true,
      );
      sendJson(store, res, 201, repoJson(store, repo));
      return true;
    }
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (parts[0] === 'repos' && parts.length >= 3) {
    const owner = decodeURIComponent(parts[1] as string);
    const name = decodeURIComponent(parts[2] as string);
    if (owner !== store.viewer.login) {
      err(store, res, 404, 'Not Found');
      return true;
    }
    const repo = getRepo(store, owner, name);
    const tail = parts.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') {
        if (!repo) {
          err(store, res, 404, 'Not Found');
          return true;
        }
        sendJson(store, res, 200, repoJson(store, repo));
        return true;
      }
      if (method === 'PATCH') {
        if (!repo) {
          err(store, res, 404, 'Not Found');
          return true;
        }
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        sendJson(store, res, 200, repoJson(store, repo));
        return true;
      }
      if (method === 'DELETE') {
        if (!repo) {
          err(store, res, 404, 'Not Found');
          return true;
        }
        store.repos.delete(repoKey(owner, name));
        sendEmpty(store, res, 204);
        return true;
      }
      err(store, res, 404, 'Not Found');
      return true;
    }

    if (!repo) {
      err(store, res, 404, 'Not Found');
      return true;
    }

    // branches
    if (tail[0] === 'branches' && method === 'GET') {
      if (tail.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) as string }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(store, res, 200, branches);
        return true;
      }
      const branch = tail.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) {
        err(store, res, 404, 'Not Found');
        return true;
      }
      sendJson(store, res, 200, { name: branch, commit: { sha }, protected: false });
      return true;
    }

    // commits
    if (tail[0] === 'commits' && method === 'GET' && tail.length === 1) {
      const commits = listCommits(repo, query.get('sha'));
      const sliced = paginate(commits, query);
      sendJson(store, res, 200, sliced);
      return true;
    }

    // git refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = typeof input.ref === 'string' ? input.ref : '';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
          err(store, res, 422, 'Invalid ref or sha');
          return true;
        }
        if (repo.refs.has(ref)) {
          err(store, res, 422, 'Reference already exists');
          return true;
        }
        repo.refs.set(ref, sha);
        const obj = repo.objects.get(sha) as GitObject;
        sendJson(store, res, 201, { ref, object: { sha, type: obj.type } });
        return true;
      }
      if (method === 'GET') {
        if (tail.length === 2) {
          const refs = [...repo.refs.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([ref, sha]) => ({ ref, object: { sha, type: (repo.objects.get(sha) as GitObject | undefined)?.type ?? 'commit' } }));
          sendJson(store, res, 200, refs);
          return true;
        }
        const ref = `refs/${tail.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (!sha) {
          err(store, res, 404, 'Not Found');
          return true;
        }
        sendJson(store, res, 200, { ref, object: { sha, type: (repo.objects.get(sha) as GitObject | undefined)?.type ?? 'commit' } });
        return true;
      }
      err(store, res, 404, 'Not Found');
      return true;
    }

    // contents
    if (tail[0] === 'contents') {
      const path = tail.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
      if (method === 'PUT') {
        const result = putContentFile(store, repo, path, input);
        sendJson(store, res, result.status, result.value);
        return true;
      }
      if (method === 'GET') {
        const result = getContentAt(store, repo, path, query.get('ref'));
        sendJson(store, res, result.status, result.value);
        return true;
      }
      if (method === 'DELETE') {
        const result = deleteContentFile(store, repo, path, input);
        sendJson(store, res, result.status, result.value);
        return true;
      }
      err(store, res, 404, 'Not Found');
      return true;
    }

    // labels
    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const labelName = typeof input.name === 'string' ? input.name : '';
        const color = typeof input.color === 'string' ? input.color : 'ededed';
        if (labelName === '') {
          err(store, res, 422, 'Label name is required');
          return true;
        }
        if (repo.labels.has(labelName)) {
          err(store, res, 422, 'Label already exists');
          return true;
        }
        const label: Label = { id: store.nextObjectId, name: labelName, color };
        store.nextObjectId += 1;
        repo.labels.set(labelName, label);
        sendJson(store, res, 201, { id: label.id, name: label.name, color: label.color, default: false });
        return true;
      }
      if (method === 'GET' && tail.length === 1) {
        sendJson(store, res, 200, [...repo.labels.values()].map((label) => ({ id: label.id, name: label.name, color: label.color, default: false })));
        return true;
      }
      err(store, res, 404, 'Not Found');
      return true;
    }

    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const items = listIssuesFiltered(repo, query);
          const sliced = paginate(items, query);
          sendJson(store, res, 200, sliced.map((issue) => issueJson(store, repo, issue)));
          return true;
        }
        if (method === 'POST') {
          const result = createIssueInRepo(store, repo, {
            title: typeof input.title === 'string' ? input.title : '',
            body: typeof input.body === 'string' ? input.body : '',
            labels: input.labels,
          });
          if ('error' in result) {
            err(store, res, result.status, result.error);
            return true;
          }
          sendJson(store, res, 201, issueJson(store, repo, result.issue));
          return true;
        }
        err(store, res, 404, 'Not Found');
        return true;
      }
      const number = parseInt(tail[1] as string, 10);
      const issue = Number.isFinite(number) ? getIssue(repo, number) : undefined;
      if (tail.length === 2) {
        if (method === 'GET') {
          if (!issue) {
            err(store, res, 404, 'Not Found');
            return true;
          }
          sendJson(store, res, 200, issueJson(store, repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (!issue) {
            err(store, res, 404, 'Not Found');
            return true;
          }
          if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          sendJson(store, res, 200, issueJson(store, repo, issue));
          return true;
        }
        err(store, res, 404, 'Not Found');
        return true;
      }
      if (tail[2] === 'comments') {
        if (!issue) {
          err(store, res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(store, res, 200, issue.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
            created_at: store.trialNow,
            updated_at: store.trialNow,
          })));
          return true;
        }
        if (method === 'POST') {
          const commentBody = typeof input.body === 'string' ? input.body : '';
          const comment = { id: store.nextObjectId, body: commentBody };
          store.nextObjectId += 1;
          issue.comments.push(comment);
          sendJson(store, res, 201, {
            id: comment.id,
            body: comment.body,
            user: { login: store.viewer.login, id: store.viewer.id, type: 'User' },
            created_at: store.trialNow,
            updated_at: store.trialNow,
          });
          return true;
        }
        err(store, res, 404, 'Not Found');
        return true;
      }
      err(store, res, 404, 'Not Found');
      return true;
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const items = listPullsFiltered(repo, query);
          const sliced = paginate(items, query);
          sendJson(store, res, 200, sliced.map((pull) => pullJson(store, repo, pull)));
          return true;
        }
        if (method === 'POST') {
          const result = createPullInRepo(store, repo, {
            title: typeof input.title === 'string' ? input.title : '',
            body: typeof input.body === 'string' ? input.body : '',
            head: typeof input.head === 'string' ? input.head : '',
            base: typeof input.base === 'string' ? input.base : '',
          });
          if ('error' in result) {
            err(store, res, result.status, result.error);
            return true;
          }
          sendJson(store, res, 201, pullJson(store, repo, result.pull));
          return true;
        }
        err(store, res, 404, 'Not Found');
        return true;
      }
      const number = parseInt(tail[1] as string, 10);
      const pull = Number.isFinite(number) ? getPull(repo, number) : undefined;
      if (tail.length === 2) {
        if (method === 'GET') {
          if (!pull) {
            err(store, res, 404, 'Not Found');
            return true;
          }
          sendJson(store, res, 200, pullJson(store, repo, pull));
          return true;
        }
        err(store, res, 404, 'Not Found');
        return true;
      }
      if (tail[2] === 'files' && method === 'GET') {
        if (!pull) {
          err(store, res, 404, 'Not Found');
          return true;
        }
        sendJson(store, res, 200, diffFilesForPull(store, repo, pull));
        return true;
      }
      if (tail[2] === 'merge' && method === 'PUT') {
        if (!pull) {
          err(store, res, 404, 'Not Found');
          return true;
        }
        const result = mergePull(store, repo, pull);
        sendJson(store, res, result.status, result.value);
        return true;
      }
      err(store, res, 404, 'Not Found');
      return true;
    }

    err(store, res, 404, 'Not Found');
    return true;
  }

  err(store, res, 404, 'Not Found');
  return true;
}

// Re-export for GraphQL's node() resolution.
export { decodeGlobalId };
