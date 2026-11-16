// The server: one Node http server for all four surfaces — git smart HTTP,
// REST v3, GraphQL and MCP — plus /healthz. Bodies are read whole (bounded)
// and dispatched by path; every unknown path is a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Store } from './store.ts';
import { handleGraphql } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, requestId, sendJson } from './rest.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store: Store = createStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(store, res, 200, { ok: true });
          return;
        }

        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const body = needsBody ? await readBody(req) : Buffer.alloc(0);

        if (path === '/mcp') {
          handleMcp(store, req, res, body);
          return;
        }
        if (path === '/api/graphql') {
          handleGraphql(store, req, res, body);
          return;
        }
        if (path.startsWith('/api/v3')) {
          handleRest(store, req, res, body);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const name = decodeURIComponent(gitMatch[2] as string);
          const suffix = gitMatch[3] as string;
          if (suffix.startsWith('info/refs')) {
            let service = '';
            try {
              service = new URL(req.url ?? '/', 'http://entry').searchParams.get('service') ?? '';
            } catch {
              service = '';
            }
            if (method !== 'GET') {
              sendJson(store, res, 405, { message: 'Method Not Allowed' });
              return;
            }
            const gitProtocolV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            handleInfoRefs(store, res, owner, name, service, gitProtocolV2);
            return;
          }
          if (suffix === 'git-upload-pack' && method === 'POST') {
            const gitProtocolV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            handleUploadPack(store, res, owner, name, body, gitProtocolV2);
            return;
          }
          if (suffix === 'git-receive-pack' && method === 'POST') {
            handleReceivePack(store, res, owner, name, body);
            return;
          }
          sendJson(store, res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(store, res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never let one request kill the process; answer a JSON 500.
        try {
          if (!res.headersSent) {
            const text = `${JSON.stringify({ message: 'Internal Server Error' })}\n`;
            res.writeHead(500, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(text),
              'x-github-request-id': requestId(store),
            });
            res.end(text);
          } else {
            res.end();
          }
        } catch {
          // The socket is already gone; nothing left to do.
        }
        void err;
      }
    })();
  });
}
