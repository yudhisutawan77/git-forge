// GitHub GraphQL v4, for the documents gh and github-mcp-server actually send.
// A small hand-rolled parser (no dependency) over the fixed document shapes,
// with a resolver over the same store the REST surface uses. Unknown fields
// are HTTP 200 with an `errors` array naming the field, as GitHub answers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createIssueInRepo,
  createPullInRepo,
  diffFilesForPull,
  getIssue,
  getPull,
  isAuthenticated,
  mergePull,
  pullMergeable,
  sendJson,
} from './rest.ts';
import {
  decodeGlobalId,
  defaultTip,
  globalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { getRepo } from './store.ts';

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

interface Selection {
  alias: string;
  name: string;
  args: Record<string, unknown>;
  selections: Selection[];
  fragment?: boolean;
  typeCondition?: string;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string;
  selections: Selection[];
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if ('{}():[]!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let out = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
          continue;
        }
        out += input[i] as string;
        i += 1;
      }
      i += 1;
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }
  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }
  acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.skipFragmentDefinition();
        continue;
      }
      operations.push(this.parseOperation());
    }
    return operations;
  }
  private skipFragmentDefinition(): void {
    // `fragment Name on Type { ... }` — not used by the suite; skip it.
    this.next(); // fragment
    this.next(); // name
    this.next(); // on
    this.next(); // type
    this.parseSelectionSet();
  }
  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name = '';
    const token = this.peek() as Token;
    if (token.kind === 'punct' && token.value === '{') {
      return { kind, name, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value;
      this.next();
      const maybeName = this.peek();
      if (maybeName && maybeName.kind === 'name') {
        name = maybeName.value;
        this.next();
      }
    }
    // Variable definitions `( $x: Type! = default, ... )` — skipped, names unused.
    if (this.acceptPunct('(')) {
      let depth = 1;
      while (depth > 0 && this.pos < this.tokens.length) {
        const t = this.next();
        if (t.kind === 'punct' && t.value === '(') depth += 1;
        else if (t.kind === 'punct' && t.value === ')') depth -= 1;
      }
    }
    return { kind, name, selections: this.parseSelectionSet() };
  }
  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    for (;;) {
      const token = this.peek();
      if (!token) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }
  private parseSelection(): Selection {
    const token = this.next();
    if (token.kind === 'spread') {
      let typeCondition: string | undefined;
      const next = this.peek();
      if (next && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeToken = this.next();
        if (typeToken.kind === 'name') typeCondition = typeToken.value;
      }
      const selections = this.parseSelectionSet();
      return { alias: '', name: '...', args: {}, selections, fragment: true, typeCondition };
    }
    if (token.kind !== 'name') throw new Error('expected a field name');
    let alias = token.value;
    let name = token.value;
    if (this.acceptPunct(':')) {
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('expected a field name after an alias');
      name = nameToken.value;
    }
    let args: Record<string, unknown> = {};
    if (this.acceptPunct('(')) args = this.parseArguments();
    let selections: Selection[] = [];
    const next = this.peek();
    if (next && next.kind === 'punct' && next.value === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections };
  }
  private parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (;;) {
      const token = this.peek();
      if (!token) throw new Error('unterminated arguments');
      if (token.kind === 'punct' && token.value === ')') {
        this.next();
        return args;
      }
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('expected an argument name');
      this.expectPunct(':');
      args[nameToken.value] = this.parseValue();
    }
  }
  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const nameToken = this.next();
      return { __variable: (nameToken as { value: string }).value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      for (;;) {
        const next = this.peek();
        if (next && next.kind === 'punct' && next.value === ']') {
          this.next();
          return list;
        }
        list.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      for (;;) {
        const next = this.peek();
        if (!next) throw new Error('unterminated object');
        if (next.kind === 'punct' && next.value === '}') {
          this.next();
          return obj;
        }
        const nameToken = this.next();
        if (nameToken.kind !== 'name') throw new Error('expected an object key');
        this.expectPunct(':');
        obj[nameToken.value] = this.parseValue();
      }
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value;
    }
    throw new Error('unexpected value');
  }
}

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.__variable === 'string') return variables[record.__variable] ?? null;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = resolveVariables(entry, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveVariables(entry, variables));
  return value;
}

// ---------------------------------------------------------------------------------------------
// schema (field names, for validation and introspection)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'isPrivate', 'private', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'url', 'createdAt', 'updatedAt',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt',
    'closedAt', 'labels', 'comments', 'url', 'repository',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt',
    'mergedAt', 'mergeCommit', 'repository',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  CommentEdge: ['node', 'cursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changes'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  SearchType: [],
};

const SEARCH_ENUM = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'];

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface GqlObject {
  __type: string;
  value: unknown;
}

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

function connectionOf<T>(items: T[], first: unknown, after: unknown): { nodes: T[]; pageInfo: Record<string, unknown>; totalCount: number } {
  const limit = typeof first === 'number' ? first : items.length;
  const afterIndex = indexOfCursor(typeof after === 'string' ? after : null);
  const start = afterIndex + 1;
  const nodes = items.slice(start, start + limit);
  const endIndex = start + nodes.length - 1;
  return {
    nodes,
    pageInfo: {
      hasNextPage: start + nodes.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? cursorFor(start) : null,
      endCursor: nodes.length > 0 ? cursorFor(endIndex) : null,
    },
    totalCount: items.length,
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function findRepoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function resolveRepositoryField(exec: Executor, repo: Repo, selection: Selection): unknown {
  const store = exec.store;
  switch (selection.name) {
    case 'id':
      return globalId('Repository', repo.id);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return resolveObject(exec, { __type: 'User', value: store.viewer }, selection.selections);
    case 'defaultBranchRef': {
      const tip = defaultTip(repo);
      if (tip === null) return null;
      return resolveObject(exec, { __type: 'Ref', value: { name: repo.defaultBranch } }, selection.selections);
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'description':
      return repo.description;
    case 'isPrivate':
    case 'private':
      return repo.private;
    case 'url':
      return `https://example.invalid/${repo.owner}/${repo.name}`;
    case 'createdAt':
    case 'updatedAt':
      return store.trialNow;
    case 'issue': {
      const number = selection.args.number as number | undefined;
      const issue = typeof number === 'number' ? getIssue(repo, number) : undefined;
      if (!issue) return null;
      return resolveObject(exec, { __type: 'Issue', value: { repo, issue } }, selection.selections);
    }
    case 'issues': {
      const states = selection.args.states as string[] | undefined;
      let items = [...repo.issues];
      const orderBy = selection.args.orderBy as Record<string, unknown> | undefined;
      if (orderBy && orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') {
        items.sort((a, b) => b.seq - a.seq);
      } else {
        items.sort((a, b) => a.seq - b.seq);
      }
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        items = items.filter((issue) => wanted.has(issue.state));
      }
      const conn = connectionOf(items, selection.args.first, selection.args.after);
      return resolveObject(exec, { __type: 'IssueConnection', value: { repo, items: conn.nodes, pageInfo: conn.pageInfo, totalCount: conn.totalCount } }, selection.selections);
    }
    case 'pullRequest': {
      const number = selection.args.number as number | undefined;
      const pull = typeof number === 'number' ? getPull(repo, number) : undefined;
      if (!pull) return null;
      return resolveObject(exec, { __type: 'PullRequest', value: { repo, pull } }, selection.selections);
    }
    case 'pullRequests': {
      const states = selection.args.states as string[] | undefined;
      let items = [...repo.pulls].sort((a, b) => b.seq - a.seq);
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toUpperCase()));
        items = items.filter((pull) => wanted.has(pullState(pull)));
      }
      const conn = connectionOf(items, selection.args.first, selection.args.after);
      return resolveObject(exec, { __type: 'PullRequestConnection', value: { repo, items: conn.nodes, pageInfo: conn.pageInfo, totalCount: conn.totalCount } }, selection.selections);
    }
    default:
      return null;
  }
}

function resolveIssueField(exec: Executor, repo: Repo, issue: Issue, selection: Selection): unknown {
  switch (selection.name) {
    case 'id':
      return globalId('Issue', repo.id, issue.number);
    case 'databaseId':
      return issue.id;
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issueState(issue);
    case 'author':
      return resolveObject(exec, { __type: 'User', value: exec.store.viewer }, selection.selections);
    case 'createdAt':
    case 'updatedAt':
      return exec.store.trialNow;
    case 'closedAt':
      return issue.state === 'closed' ? exec.store.trialNow : null;
    case 'labels':
      return issue.labels.map((label) => ({ name: label.name, color: label.color }));
    case 'comments':
      return issue.comments.map((comment) => ({ id: globalId('IssueComment', repo.id, comment.id), body: comment.body }));
    case 'url':
      return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
    case 'repository':
      return resolveObject(exec, { __type: 'Repository', value: repo }, selection.selections);
    default:
      return null;
  }
}

function resolvePullField(exec: Executor, repo: Repo, pull: Pull, selection: Selection): unknown {
  const store = exec.store;
  switch (selection.name) {
    case 'id':
      return globalId('PullRequest', repo.id, pull.number);
    case 'databaseId':
      return pull.id;
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pullState(pull);
    case 'merged':
      return pull.merged;
    case 'mergeable':
      return pullMergeable(store, repo, pull);
    case 'headRefName':
      return pull.head;
    case 'baseRefName':
      return pull.base;
    case 'headRefOid':
      return pull.headSha;
    case 'baseRefOid':
      return pull.baseSha;
    case 'author':
      return resolveObject(exec, { __type: 'User', value: store.viewer }, selection.selections);
    case 'createdAt':
    case 'updatedAt':
      return store.trialNow;
    case 'mergedAt':
      return pull.mergedAt;
    case 'mergeCommit':
      return pull.mergeSha === null ? null : { oid: pull.mergeSha };
    case 'repository':
      return resolveObject(exec, { __type: 'Repository', value: repo }, selection.selections);
    case 'files': {
      const files = diffFilesForPull(store, repo, pull).map((file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      }));
      const conn = connectionOf(files, selection.args.first, selection.args.after);
      return resolveObject(exec, { __type: 'PullRequestFileConnection', value: { items: conn.nodes, pageInfo: conn.pageInfo, totalCount: conn.totalCount } }, selection.selections);
    }
    default:
      return null;
  }
}

function resolveObject(exec: Executor, obj: GqlObject, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.fragment) {
      if (selection.typeCondition && selection.typeCondition !== obj.__type) continue;
      Object.assign(out, resolveObject(exec, obj, selection.selections));
      continue;
    }
    const allowed = TYPE_FIELDS[obj.__type] ?? [];
    if (!allowed.includes(selection.name) && selection.name !== '__typename') {
      exec.errors.push({ message: `Cannot query field "${selection.name}" on type "${obj.__type}".` });
      out[selection.alias] = null;
      continue;
    }
    if (selection.name === '__typename') {
      out[selection.alias] = obj.__type;
      continue;
    }
    out[selection.alias] = resolveField(exec, obj, selection);
  }
  return out;
}

function resolveField(exec: Executor, obj: GqlObject, selection: Selection): unknown {
  const store = exec.store;
  switch (obj.__type) {
    case 'Query':
      return resolveQueryField(exec, selection);
    case 'Mutation':
      return resolveMutationField(exec, selection);
    case 'User': {
      const user = obj.value as { login: string; id: number; name: string; email: string };
      if (selection.name === 'login') return user.login;
      if (selection.name === 'id') return globalId('User', user.id);
      if (selection.name === 'name') return user.name;
      if (selection.name === 'email') return user.email;
      return null;
    }
    case 'Repository':
      return resolveRepositoryField(exec, obj.value as Repo, selection);
    case 'Issue': {
      const { repo, issue } = obj.value as { repo: Repo; issue: Issue };
      return resolveIssueField(exec, repo, issue, selection);
    }
    case 'PullRequest': {
      const { repo, pull } = obj.value as { repo: Repo; pull: Pull };
      return resolvePullField(exec, repo, pull, selection);
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection': {
      const conn = obj.value as { items: unknown[]; pageInfo: Record<string, unknown>; totalCount: number };
      if (selection.name === 'nodes') {
        const itemType = obj.__type === 'IssueConnection' ? 'Issue' : obj.__type === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestFile';
        return conn.items.map((item) => {
          if (itemType === 'PullRequestFile') {
            const file = item as Record<string, unknown>;
            const fileOut: Record<string, unknown> = {};
            for (const sub of selection.selections) {
              if (sub.fragment) continue;
              fileOut[sub.alias] = file[sub.name] ?? null;
            }
            return fileOut;
          }
          const repo = (obj.value as { repo?: Repo }).repo as Repo;
          const wrapped = itemType === 'Issue'
            ? { __type: 'Issue', value: { repo, issue: item as Issue } }
            : { __type: 'PullRequest', value: { repo, pull: item as Pull } };
          return resolveObject(exec, wrapped, selection.selections);
        });
      }
      if (selection.name === 'edges') return [];
      if (selection.name === 'pageInfo') {
        const pageOut: Record<string, unknown> = {};
        for (const sub of selection.selections) {
          if (sub.fragment) continue;
          pageOut[sub.alias] = conn.pageInfo[sub.name] ?? null;
        }
        return pageOut;
      }
      if (selection.name === 'totalCount') return conn.totalCount;
      return null;
    }
    case 'Ref': {
      const ref = obj.value as { name: string };
      if (selection.name === 'name') return ref.name;
      return null;
    }
    case 'IssueComment': {
      const comment = obj.value as { id: string; body: string };
      if (selection.name === 'id') return comment.id;
      if (selection.name === 'body') return comment.body;
      return null;
    }
    case '__Type': {
      const typeInfo = obj.value as { name: string; fields: string[]; enumValues: string[] };
      if (selection.name === 'name') return typeInfo.name;
      if (selection.name === 'kind') return typeInfo.enumValues.length > 0 ? 'ENUM' : 'OBJECT';
      if (selection.name === 'fields') {
        return typeInfo.fields.map((name) => resolveObject(exec, { __type: '__Field', value: { name } }, selection.selections));
      }
      if (selection.name === 'enumValues') {
        return typeInfo.enumValues.map((name) => resolveObject(exec, { __type: '__EnumValue', value: { name } }, selection.selections));
      }
      if (selection.name === 'description') return null;
      return null;
    }
    case '__Field': {
      const field = obj.value as { name: string };
      if (selection.name === 'name') return field.name;
      if (selection.name === 'description') return null;
      if (selection.name === 'args') return [];
      if (selection.name === 'type') return { name: 'String' };
      return null;
    }
    case '__EnumValue': {
      const value = obj.value as { name: string };
      if (selection.name === 'name') return value.name;
      if (selection.name === 'description') return null;
      return null;
    }
    default:
      return null;
  }
}

function resolveQueryField(exec: Executor, selection: Selection): unknown {
  const store = exec.store;
  if (selection.name === 'viewer') {
    return resolveObject(exec, { __type: 'User', value: store.viewer }, selection.selections);
  }
  if (selection.name === 'repository') {
    const owner = selection.args.owner as string | undefined;
    const name = selection.args.name as string | undefined;
    if (owner !== store.viewer.login) return null;
    const repo = typeof name === 'string' ? getRepo(store, owner, name) : undefined;
    if (!repo) return null;
    return resolveObject(exec, { __type: 'Repository', value: repo }, selection.selections);
  }
  if (selection.name === 'node') {
    const id = selection.args.id as string | undefined;
    const decoded = typeof id === 'string' ? decodeGlobalId(id) : null;
    if (!decoded) return null;
    if (decoded.kind === 'Repository') {
      const repo = findRepoById(store, Number(decoded.parts[0]));
      if (!repo) return null;
      return resolveObject(exec, { __type: 'Repository', value: repo }, selection.selections);
    }
    if (decoded.kind === 'Issue') {
      const repo = findRepoById(store, Number(decoded.parts[0]));
      const issue = repo ? getIssue(repo, Number(decoded.parts[1])) : undefined;
      if (!repo || !issue) return null;
      return resolveObject(exec, { __type: 'Issue', value: { repo, issue } }, selection.selections);
    }
    if (decoded.kind === 'PullRequest') {
      const repo = findRepoById(store, Number(decoded.parts[0]));
      const pull = repo ? getPull(repo, Number(decoded.parts[1])) : undefined;
      if (!repo || !pull) return null;
      return resolveObject(exec, { __type: 'PullRequest', value: { repo, pull } }, selection.selections);
    }
    return null;
  }
  if (selection.name === '__type') {
    const name = selection.args.name as string | undefined;
    const fields = typeof name === 'string' ? TYPE_FIELDS[name] : undefined;
    if (!name || !fields) return null;
    const enumValues = name === 'SearchType' ? SEARCH_ENUM : [];
    return resolveObject(exec, { __type: '__Type', value: { name, fields, enumValues } }, selection.selections);
  }
  return null;
}

function resolveMutationField(exec: Executor, selection: Selection): unknown {
  const store = exec.store;
  const input = (selection.args.input ?? {}) as Record<string, unknown>;
  if (selection.name === 'createIssue') {
    const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const repo = decoded && decoded.kind === 'Repository' ? findRepoById(store, Number(decoded.parts[0])) : undefined;
    if (!repo) {
      exec.errors.push({ message: 'Repository not found.' });
      return null;
    }
    const result = createIssueInRepo(store, repo, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
    });
    if ('error' in result) {
      exec.errors.push({ message: result.error });
      return null;
    }
    const issue = result.issue;
    const out: Record<string, unknown> = {};
    for (const sub of selection.selections) {
      if (sub.name === 'issue') {
        out[sub.alias] = resolveObject(exec, { __type: 'Issue', value: { repo, issue } }, sub.selections);
      }
    }
    return out;
  }
  if (selection.name === 'closeIssue') {
    const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
    const repo = decoded && decoded.kind === 'Issue' ? findRepoById(store, Number(decoded.parts[0])) : undefined;
    const issue = repo && decoded ? getIssue(repo, Number(decoded.parts[1])) : undefined;
    if (!repo || !issue) {
      exec.errors.push({ message: 'Issue not found.' });
      return null;
    }
    issue.state = 'closed';
    const out: Record<string, unknown> = {};
    for (const sub of selection.selections) {
      if (sub.name === 'issue') {
        out[sub.alias] = resolveObject(exec, { __type: 'Issue', value: { repo, issue } }, sub.selections);
      }
    }
    return out;
  }
  if (selection.name === 'createPullRequest') {
    const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const repo = decoded && decoded.kind === 'Repository' ? findRepoById(store, Number(decoded.parts[0])) : undefined;
    if (!repo) {
      exec.errors.push({ message: 'Repository not found.' });
      return null;
    }
    const result = createPullInRepo(store, repo, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? ''),
    });
    if ('error' in result) {
      exec.errors.push({ message: result.error });
      return null;
    }
    const pull = result.pull;
    const out: Record<string, unknown> = {};
    for (const sub of selection.selections) {
      if (sub.name === 'pullRequest') {
        out[sub.alias] = resolveObject(exec, { __type: 'PullRequest', value: { repo, pull } }, sub.selections);
      }
    }
    return out;
  }
  if (selection.name === 'mergePullRequest') {
    const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
    const repo = decoded && decoded.kind === 'PullRequest' ? findRepoById(store, Number(decoded.parts[0])) : undefined;
    const pull = repo && decoded ? getPull(repo, Number(decoded.parts[1])) : undefined;
    if (!repo || !pull) {
      exec.errors.push({ message: 'Pull request not found.' });
      return null;
    }
    const merged = mergePull(store, repo, pull);
    if (merged.status !== 200) {
      exec.errors.push({ message: String(merged.value.message ?? 'Merge failed.') });
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const sub of selection.selections) {
      if (sub.name === 'pullRequest') {
        out[sub.alias] = resolveObject(exec, { __type: 'PullRequest', value: { repo, pull } }, sub.selections);
      }
    }
    return out;
  }
  if (selection.name === 'addComment') {
    const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
    const repo = decoded && decoded.kind === 'Issue' ? findRepoById(store, Number(decoded.parts[0])) : undefined;
    const issue = repo && decoded ? getIssue(repo, Number(decoded.parts[1])) : undefined;
    if (!repo || !issue) {
      exec.errors.push({ message: 'Issue not found.' });
      return null;
    }
    const body = typeof input.body === 'string' ? input.body : '';
    const comment = { id: store.nextObjectId, body };
    store.nextObjectId += 1;
    issue.comments.push(comment);
    const commentId = globalId('IssueComment', repo.id, comment.id);
    const out: Record<string, unknown> = {};
    for (const sub of selection.selections) {
      if (sub.name === 'commentEdge') {
        const edge: Record<string, unknown> = {};
        for (const edgeSub of sub.selections) {
          if (edgeSub.name === 'node') {
            edge[edgeSub.alias] = resolveObject(exec, { __type: 'IssueComment', value: { id: commentId, body } }, edgeSub.selections);
          } else if (edgeSub.name === 'cursor') {
            edge[edgeSub.alias] = cursorFor(issue.comments.length - 1);
          }
        }
        out[sub.alias] = edge;
      }
    }
    return out;
  }
  return null;
}

function executeOperation(store: Store, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const exec: Executor = { store, variables, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const resolveArgs = (selections: Selection[]): Selection[] =>
    selections.map((selection) => ({
      ...selection,
      args: resolveVariables(selection.args, variables) as Record<string, unknown>,
      selections: resolveArgs(selection.selections),
    }));
  const data = resolveObject(exec, { __type: rootType, value: null }, resolveArgs(operation.selections));
  const body: Record<string, unknown> = { data };
  if (exec.errors.length > 0) body.errors = exec.errors;
  return body;
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

export function handleGraphql(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    pathname = '/';
  }
  if (pathname !== '/api/graphql') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(store, res, 405, { errors: [{ message: 'Method not allowed.' }] });
    return true;
  }
  if (!isAuthenticated(req, store)) {
    sendJson(store, res, 401, { message: 'Requires authentication' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(store, res, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
    return true;
  }
  const operations = Array.isArray(parsed) ? parsed : [parsed];
  const results: Array<Record<string, unknown>> = [];
  for (const entry of operations) {
    if (entry === null || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).query !== 'string') {
      results.push({ errors: [{ message: 'A query string is required.' }] });
      continue;
    }
    const record = entry as Record<string, unknown>;
    const query = record.query as string;
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    try {
      const document = new Parser(tokenize(query)).parseDocument();
      const operation = operationName
        ? document.find((op) => op.name === operationName) ?? document[0]
        : document[0];
      if (!operation) {
        results.push({ errors: [{ message: 'No operation in the document.' }] });
        continue;
      }
      results.push(executeOperation(store, operation, variables));
    } catch (err) {
      results.push({ errors: [{ message: err instanceof Error ? err.message : 'Could not parse the query.' }] });
    }
  }
  sendJson(store, res, 200, Array.isArray(parsed) ? results : results[0]);
  return true;
}
