// app.ts — the entry's HTTP server: one in-memory forge serving git smart HTTP,
// REST v3, GraphQL v4 and MCP on a single Node http server with keep-alive.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { routeRest, type RestAnswer, type RestContext } from './rest.ts';
import { SHOP_TOKEN, store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The path segments of a request URL (decoded, empty segments dropped). */
function segmentsOf(req: IncomingMessage): string[] {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return url.pathname.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));
  } catch {
    return [];
  }
}

/** Whether this request carries the trial's bearer token. */
function isAuthorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true; // dev mode: no token configured, accept any
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${SHOP_TOKEN}`;
}

/** Read the request body whole (up to MAX_BODY_BYTES). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Answer with a JSON body. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Answer with raw bytes and an explicit content type. */
function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** One REST answer, serialized with its request id. */
function sendRest(res: ServerResponse, answer: RestAnswer): void {
  const headers: Record<string, string> = { 'x-github-request-id': store.nextRequestId() };
  if (answer.headers !== undefined) Object.assign(headers, answer.headers);
  if (answer.noBody === true) {
    res.writeHead(answer.status, headers);
    res.end();
    return;
  }
  sendJson(res, answer.status, answer.json, headers);
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const segments = segmentsOf(req);
      const authorized = isAuthorized(req);

      // The env's boot check: 200 {"ok":true}.
      if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // REST v3 under /api/v3.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const ctx: RestContext = {
          method,
          segments: segments.slice(2),
          query: new URL(req.url ?? '/', 'http://entry').searchParams,
          body,
          host: req.headers.host ?? '127.0.0.1',
          authorized,
        };
        const answer = routeRest(ctx);
        if (answer !== null) {
          sendRest(res, answer);
          return;
        }
        sendRest(res, { status: 404, json: { message: 'Not Found' } });
        return;
      }

      // GraphQL v4 at /api/graphql.
      if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (!authorized) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const body = await readBody(req);
        const result = handleGraphQL(body.toString('utf8'));
        sendJson(res, result.status, result.json);
        return;
      }

      // MCP at /mcp.
      if (segments.length === 1 && segments[0] === 'mcp') {
        if (method === 'DELETE') {
          res.writeHead(200);
          res.end();
          return;
        }
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        const body = await readBody(req);
        const result = handleMcp(body.toString('utf8'), authorized);
        if (result.noBody === true) {
          res.writeHead(result.status);
          res.end();
          return;
        }
        sendJson(res, result.status, result.json);
        return;
      }

      // Git smart HTTP at /{owner}/{repo}.git/...
      if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
        const owner = segments[0]!;
        const repoName = segments[1]!.slice(0, -'.git'.length);
        const tail = segments.slice(2);
        if (!authorized) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
          const query = new URL(req.url ?? '/', 'http://entry').searchParams;
          const service = query.get('service') ?? '';
          const gitProtocol = req.headers['git-protocol'];
          const result = handleInfoRefs(owner, repoName, service, typeof gitProtocol === 'string' ? gitProtocol : undefined);
          sendBytes(res, result.status, result.contentType, result.body);
          return;
        }
        if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
          const body = await readBody(req);
          const gitProtocol = req.headers['git-protocol'];
          const result = handleUploadPack(owner, repoName, body, typeof gitProtocol === 'string' ? gitProtocol : undefined);
          sendBytes(res, result.status, result.contentType, result.body);
          return;
        }
        if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
          const body = await readBody(req);
          const result = await handleReceivePack(owner, repoName, body);
          sendBytes(res, result.status, result.contentType, result.body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // Everything else: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      if (!res.writableEnded) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    });
  });
}
