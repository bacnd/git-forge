// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable
// HTTP, modern revision 2026-07-28 (server/discover) with the legacy initialize
// handshake as a fallback. Tools act on the same store as REST and GraphQL.

import { branchTip, store, VIEWER, StoreError, type Issue, type PullRequest, type Repo } from './store.ts';

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

/** One tool, as tools/list answers it (a fixed table: byte-identical every call). */
interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
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
    description: 'Read one repository by owner and name.',
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
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
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
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

// ---------------------------------------------------------------- shared shapes (the REST shapes, reused)

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    created_at: issue.createdAt,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: branchTip(repo, pull.headRef) ?? pull.headSha },
    base: { ref: pull.baseRef, sha: branchTip(repo, pull.baseRef) ?? pull.baseSha },
    created_at: pull.createdAt,
  };
}

// ---------------------------------------------------------------- tool execution

/** The result of one tool call: a value object, or an error message for isError. */
type ToolOutcome = { value: unknown } | { error: string };

function requireRepo(args: Record<string, unknown>): Repo {
  const owner = args.owner;
  const repoName = args.repo;
  if (typeof owner !== 'string' || typeof repoName !== 'string') throw new StoreError(400, 'owner and repo are required');
  if (owner !== VIEWER.login) throw new StoreError(404, 'Not Found');
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) throw new StoreError(404, 'Not Found');
  return repo;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function runTool(name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { error: `unknown tool ${name}` };
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { error: `Missing required argument: ${required}` };
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = args.name as string;
        const repo = store.createRepo(VIEWER.login, repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
        return { value: repoJson(repo) };
      }
      case 'get_repo': {
        return { value: repoJson(requireRepo(args)) };
      }
      case 'create_issue': {
        const repo = requireRepo(args);
        const issue = store.createIssue(repo, args.title as string, typeof args.body === 'string' ? args.body : '', []);
        return { value: issueJson(repo, issue) };
      }
      case 'list_issues': {
        const repo = requireRepo(args);
        const state = typeof args.state === 'string' ? args.state : 'open';
        const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
        return { value: { issues: issues.map((issue) => issueJson(repo, issue)) } };
      }
      case 'create_pull_request': {
        const repo = requireRepo(args);
        const pull = store.createPull(repo, args.title as string, typeof args.body === 'string' ? args.body : '', args.head as string, args.base as string);
        return { value: pullJson(repo, pull) };
      }
      case 'merge_pull_request': {
        const repo = requireRepo(args);
        const number = asNumber(args.pull_number);
        if (number === null) return { error: 'pull_number must be an integer' };
        const pull = store.pullByNumber(repo, number);
        if (pull === undefined) return { error: `Pull request #${number} does not exist` };
        const sha = store.mergePull(repo, pull);
        return { value: { merged: true, number, state: 'closed', sha } };
      }
      case 'get_issue': {
        const repo = requireRepo(args);
        const number = asNumber(args.issue_number);
        if (number === null) return { error: 'issue_number must be an integer' };
        const issue = store.issueByNumber(repo, number);
        if (issue === undefined) return { error: `Issue #${number} does not exist` };
        return { value: issueJson(repo, issue) };
      }
      case 'list_pull_requests': {
        const repo = requireRepo(args);
        const state = typeof args.state === 'string' ? args.state : 'open';
        const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
        return { value: { pull_requests: pulls.map((pull) => pullJson(repo, pull)) } };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  } catch (err) {
    if (err instanceof StoreError) return { error: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------- JSON-RPC

interface RpcResponse {
  status: number;
  json: unknown;
  noBody?: boolean;
}

function rpcResult(id: unknown, result: unknown): RpcResponse {
  return { status: 200, json: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcResponse {
  return { status, json: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** Extract a request id from a body that failed to parse (for the -32700 answer). */
function sniffId(text: string): unknown {
  const match = /"id"\s*:\s*("[^"]*"|-?\d+)/.exec(text);
  if (match === null) return null;
  const raw = match[1]!;
  if (raw.startsWith('"')) return raw.slice(1, -1);
  return Number(raw);
}

/** Handle one POST /mcp body. `authorized` is false when the Bearer token is missing/wrong. */
export function handleMcp(bodyText: string, authorized: boolean): RpcResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return rpcError(sniffId(bodyText), -32700, 'Parse error', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const record = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = record.id ?? null;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = record.params !== null && typeof record.params === 'object' && !Array.isArray(record.params) ? (record.params as Record<string, unknown>) : {};
  const isNotification = record.id === undefined;

  // Notifications (no id) are answered with 202 and no body.
  if (isNotification) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return { status: 202, json: null, noBody: true };
    }
    return { status: 202, json: null, noBody: true };
  }

  if (!authorized) return rpcError(id, -32001, 'Unauthorized', 401);

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        resultType: 'discover',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and git smart HTTP.',
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list': {
      // The table is a module constant: the answer is byte-identical every call.
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) return rpcError(id, -32601, `Method not found: ${name}`);
      const outcome = runTool(name, args);
      if ('error' in outcome) {
        return rpcResult(id, {
          content: [{ type: 'text', text: outcome.error }],
          isError: true,
        });
      }
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
        structuredContent: outcome.value,
      });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
