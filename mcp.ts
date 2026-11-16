// Model Context Protocol over Streamable HTTP at POST /mcp: JSON-RPC 2.0,
// the modern era (2026-07-28, server/discover, no handshake) with the legacy
// initialize handshake kept for older clients. Plain JSON answers, one per
// request; no sessions. Tools act on the same store as REST and GraphQL.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createIssueInRepo,
  createPullInRepo,
  getIssue,
  getPull,
  issueJson,
  isAuthenticated,
  listIssuesFiltered,
  mergePull,
  pullJson,
  repoJson,
  requestId,
  sendJson,
} from './rest.ts';
import { createRepoRecord, getRepo, repoKey, type Repo, type Store } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS: ReadonlyArray<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(data: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }],
    structuredContent: data,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

/** Resolve owner/repo from the arguments, including a full_name fallback. */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== '' && repo !== '') return { owner, repo };
  const fullName = typeof args.full_name === 'string' ? args.full_name : '';
  const slash = fullName.indexOf('/');
  if (slash > 0) return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
  return null;
}

function missingArg(args: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (value === undefined || value === null || value === '') return name;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const missing = missingArg(args, ['name']);
      if (missing) return toolError(`Missing required argument: ${missing}`);
      const repoName = String(args.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return toolError('Invalid repository name');
      if (store.repos.has(repoKey(store.viewer.login, repoName))) return toolError('Repository already exists');
      const repo = createRepoRecord(
        store,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const missing = missingArg(args, ['owner', 'repo']);
      if (missing) return toolError(`Missing required argument: ${missing}`);
      const target = ownerRepo(args);
      if (!target) return toolError('Missing required argument: owner or repo');
      if (target.owner !== store.viewer.login) return toolError('Repository not found');
      const repo = getRepo(store, target.owner, target.repo);
      if (!repo) return toolError('Repository not found');
      return toolResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const missing = missingArg(args, ['owner', 'repo', 'title']);
      if (missing) return toolError(`Missing required argument: ${missing}`);
      const target = ownerRepo(args);
      if (!target) return toolError('Missing required argument: owner or repo');
      if (target.owner !== store.viewer.login) return toolError('Repository not found');
      const repo = getRepo(store, target.owner, target.repo);
      if (!repo) return toolError('Repository not found');
      const result = createIssueInRepo(store, repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in result) return toolError(result.error);
      return toolResult(issueJson(store, repo, result.issue));
    }
    case 'list_issues': {
      const missing = missingArg(args, ['owner', 'repo']);
      if (missing) return toolError(`Missing required argument: ${missing}`);
      const target = ownerRepo(args);
      if (!target) return toolError('Missing required argument: owner or repo');
      if (target.owner !== store.viewer.login) return toolError('Repository not found');
      const repo = getRepo(store, target.owner, target.repo);
      if (!repo) return toolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const params = new URLSearchParams({ state });
      const items = listIssuesFiltered(repo, params);
      return toolResult(items.map((issue) => issueJson(store, repo, issue)));
    }
    case 'create_pull_request': {
      const missing = missingArg(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing) return toolError(`Missing required argument: ${missing}`);
      const target = ownerRepo(args);
      if (!target) return toolError('Missing required argument: owner or repo');
      if (target.owner !== store.viewer.login) return toolError('Repository not found');
      const repo = getRepo(store, target.owner, target.repo);
      if (!repo) return toolError('Repository not found');
      const result = createPullInRepo(store, repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head),
        base: String(args.base),
      });
      if ('error' in result) return toolError(result.error);
      return toolResult(pullJson(store, repo, result.pull));
    }
    case 'merge_pull_request': {
      const missing = missingArg(args, ['owner', 'repo', 'pull_number']);
      if (missing) return toolError(`Missing required argument: ${missing}`);
      const target = ownerRepo(args);
      if (!target) return toolError('Missing required argument: owner or repo');
      if (target.owner !== store.viewer.login) return toolError('Repository not found');
      const repo = getRepo(store, target.owner, target.repo);
      if (!repo) return toolError('Repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
      const pull = Number.isFinite(number) ? getPull(repo, number) : undefined;
      if (!pull) return toolError('Pull request not found');
      const merged = mergePull(store, repo, pull);
      if (merged.status !== 200) return toolError(String(merged.value.message ?? 'Merge failed'));
      return toolResult({ ...merged.value, number: pull.number });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function handleRequest(store: Store, request: unknown): Record<string, unknown> | null {
  if (!isRecord(request)) return rpcError(null, -32600, 'Invalid Request');
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};
  const isNotification = request.id === undefined;

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : LEGACY_VERSIONS[0];
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method.startsWith('notifications/')) {
    return null; // Notifications get no JSON-RPC response (HTTP 202 below).
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const known = (TOOLS as Array<Record<string, unknown>>).some((tool) => tool.name === toolName);
    if (toolName === '' || !known) {
      return rpcError(id, -32602, `Unknown tool: ${toolName}`);
    }
    return rpcResult(id, callTool(store, toolName, args));
  }
  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    pathname = '/';
  }
  if (pathname !== '/mcp') return false;
  const method = req.method ?? 'GET';
  if (method !== 'POST') {
    sendJson(store, res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!isAuthenticated(req, store)) {
    const text = `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } })}\n`;
    res.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'x-github-request-id': requestId(store),
    });
    res.end(text);
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(store, res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => handleRequest(store, entry)).filter((entry) => entry !== null);
    sendJson(store, res, 200, results);
    return true;
  }
  const result = handleRequest(store, parsed);
  if (result === null) {
    // A notification: 202 Accepted, no body.
    res.writeHead(202, { 'x-github-request-id': requestId(store) });
    res.end();
    return true;
  }
  sendJson(store, res, 200, result);
  return true;
}

export { type Repo };
