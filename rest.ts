// rest.ts — the GitHub REST v3 surface under /api/v3: repositories, branches, commits,
// refs, contents, labels, issues, comments and pull requests. Every reply is JSON with
// an X-GitHub-Request-Id; errors are JSON with a string message.

import {
  blobAtPath,
  branchTip,
  commitOf,
  commitTree,
  dirEntries,
  isoFromUnixSeconds,
  makeCommit,
  store,
  treeWithPath,
  treeWithoutPath,
  VIEWER,
  StoreError,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';
import { parseCommit, putObject } from './gitobj.ts';

/** What a REST handler answers with (the app serializes `json` to a body). */
export interface RestAnswer {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
  noBody?: boolean;
}

function answer(status: number, json: unknown, headers?: Record<string, string>): RestAnswer {
  return { status, json, headers };
}

function error(status: number, message: string): RestAnswer {
  return { status, json: { message } };
}

/** The request a REST handler sees (built by app.ts). */
export interface RestContext {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  host: string;
  authorized: boolean;
}

/** Parse the request's JSON body; 400 on malformed JSON, {} on an empty body. */
function jsonBody(ctx: RestContext): Record<string, unknown> {
  const text = ctx.body.toString('utf8').trim();
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new StoreError(400, 'Problems parsing JSON');
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

// ---------------------------------------------------------------- serializers

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
    updated_at: repo.createdAt,
    fork: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function labelJson(repo: Repo, label: Label, index: number): Record<string, unknown> {
  void repo;
  return { id: index + 1, name: label.name, color: label.color, description: '' };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
  };
}

function commentJson(comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

function branchJson(repo: Repo, name: string): Record<string, unknown> | null {
  const sha = branchTip(repo, name);
  if (sha === null) return null;
  const commit = commitOf(repo, sha);
  return {
    name,
    commit: { sha, commit: { message: commit?.message ?? '' } },
    protected: false,
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const commit = commitOf(repo, sha);
  const parseIdentity = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: line, email: '', date: '' };
    return { name: match[1]!, email: match[2]!, date: isoFromUnixSeconds(Number(match[3]!)) };
  };
  let author = { name: VIEWER.name, email: VIEWER.email, date: '' };
  let committer = author;
  if (commit !== null) {
    const raw = repo.objects.get(sha);
    if (raw !== undefined) {
      const info = parseCommit(raw.data);
      author = parseIdentity(info.author);
      committer = parseIdentity(info.committer);
    }
  }
  // The git object stores the message with a trailing newline; the REST
  // presentation drops it (GitHub's API returns the message without it, and
  // the suite compares it exactly).
  const message = (commit?.message ?? '').replace(/\n$/, '');
  return {
    sha,
    commit: {
      message,
      author,
      committer,
      tree: { sha: commit?.tree ?? '' },
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

/** First-parent walk from a tip, newest first. */
function commitHistory(repo: Repo, tip: string, limit: number): string[] {
  const out: string[] = [];
  let current: string | null = tip;
  const seen = new Set<string>();
  while (current !== null && out.length < limit && !seen.has(current)) {
    seen.add(current);
    const commit = commitOf(repo, current);
    if (commit === null) break;
    out.push(current);
    current = commit.parents[0] ?? null;
  }
  return out;
}

// ---------------------------------------------------------------- pagination

interface Page {
  perPage: number;
  page: number;
}

function pageOf(ctx: RestContext): Page {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], page: Page): { pageItems: T[] } {
  const start = (page.page - 1) * page.perPage;
  const pageItems = items.slice(start, start + page.perPage);
  return { pageItems };
}

/** A Link header for the next/last pages, on this entry's own origin. */
function linkHeader(ctx: RestContext, path: string, page: Page, totalItems: number): string | null {
  const totalPages = Math.max(1, Math.ceil(totalItems / page.perPage));
  if (totalPages <= 1) return null;
  const base = `http://${ctx.host}${path}`;
  const other = new URLSearchParams(ctx.query);
  const build = (p: number): string => {
    other.set('page', String(p));
    other.set('per_page', String(page.perPage));
    return `<${base}?${other.toString()}>`;
  };
  const parts: string[] = [];
  if (page.page < totalPages) parts.push(`${build(page.page + 1)}; rel="next"`);
  parts.push(`${build(totalPages)}; rel="last"`);
  if (page.page > 1) parts.push(`${build(1)}; rel="first"`);
  return parts.join(', ');
}

// ---------------------------------------------------------------- repo lookup

/** The repository a route names, or a 404 answer when it is not the viewer's. */
function repoOf(ctx: RestContext, owner: string, name: string): Repo | RestAnswer {
  if (owner !== VIEWER.login) return error(404, 'Not Found');
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return error(404, 'Not Found');
  return repo;
}

// ---------------------------------------------------------------- contents

function contentsPathOf(segments: string[]): string {
  return segments.map((segment) => decodeURIComponent(segment)).join('/');
}

function contentFileJson(repo: Repo, path: string, blobOid: string): Record<string, unknown> {
  const obj = repo.objects.get(blobOid);
  const size = obj?.data.length ?? 0;
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name,
    path,
    content: obj?.data.toString('base64') ?? '',
    sha: blobOid,
  };
}

/** Write a file on a branch (creating the branch from the default tip when needed). */
function putContent(
  repo: Repo,
  path: string,
  contentBase64: string,
  message: string,
  branch: string | undefined,
  sha: string | undefined,
): { status: number; commitSha: string; blobSha: string; created: boolean } {
  const targetBranch = branch ?? repo.defaultBranch;
  let tip = branchTip(repo, targetBranch);
  if (tip === null && branch !== undefined && branch !== repo.defaultBranch) {
    // A new branch starts at the default branch's tip.
    tip = branchTip(repo, repo.defaultBranch);
    if (tip !== null) repo.refs.set(`refs/heads/${targetBranch}`, tip);
  }
  const tree = tip === null ? null : commitTree(repo, tip);
  const existing = blobAtPath(repo, tree, path);
  if (sha !== undefined && existing !== sha) throw new StoreError(409, 'sha does not match the current file');
  if (existing === null && sha !== undefined) throw new StoreError(409, 'sha does not match the current file');
  const created = existing === null;
  const blobSha = putObject(repo.objects, 'blob', Buffer.from(contentBase64.replace(/[\r\n\t ]+/g, ''), 'base64'));
  const newTree = treeWithPath(repo, tree, path, blobSha);
  const commitSha = makeCommit(repo, newTree, tip === null ? [] : [tip], message);
  repo.refs.set(`refs/heads/${targetBranch}`, commitSha);
  return { status: created ? 201 : 200, commitSha, blobSha, created };
}

// ---------------------------------------------------------------- the router

/** Route one REST request. Returns null when the path is not a REST route. */
export function routeRest(ctx: RestContext): RestAnswer | null {
  const s = ctx.segments;
  const method = ctx.method;

  // GET /api/v3 and /api/v3/ — the API root (served without auth, as the kit ships it).
  if (s.length === 0 && method === 'GET') {
    return answer(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (s.length === 0) return error(404, 'Not Found');
  if (!ctx.authorized) return error(401, 'Requires authentication');

  try {
    return routeRestAuthorized(ctx);
  } catch (err) {
    if (err instanceof StoreError) return error(err.status, err.message);
    throw err;
  }
}

function routeRestAuthorized(ctx: RestContext): RestAnswer | null {
  const s = ctx.segments;
  const method = ctx.method;

  // GET /api/v3/meta
  if (s.length === 1 && s[0] === 'meta' && method === 'GET') {
    return answer(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (s.length === 1 && s[0] === 'user' && method === 'GET') {
    return answer(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }

  // /api/v3/user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER.login);
      const page = pageOf(ctx);
      const { pageItems } = paginate(repos, page);
      const link = linkHeader(ctx, '/api/v3/user/repos', page, repos.length);
      return answer(200, pageItems.map(repoJson), link === null ? undefined : { link });
    }
    if (method === 'POST') {
      const body = jsonBody(ctx);
      const name = asString(body.name);
      if (name === undefined || name === '' || name.includes('/')) throw new StoreError(422, 'Repository name is required');
      const repo = store.createRepo(VIEWER.login, name, asBoolean(body.private) ?? false, asString(body.description) ?? '');
      return answer(201, repoJson(repo));
    }
    return error(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = s[1]!;
    const name = s[2]!;
    const repoOrError = repoOf(ctx, owner, name);
    if ('status' in repoOrError) return repoOrError;
    const repo = repoOrError;
    const rest = s.slice(3);

    // GET/PATCH/DELETE /api/v3/repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return answer(200, repoJson(repo));
      if (method === 'PATCH') {
        const body = jsonBody(ctx);
        const description = asString(body.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = asBoolean(body.private);
        if (isPrivate !== undefined) repo.isPrivate = isPrivate;
        return answer(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, json: null, noBody: true };
      }
      return error(404, 'Not Found');
    }

    // GET /branches, GET /branches/{branch}
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length)).sort();
        return answer(200, names.map((branch) => branchJson(repo, branch)).filter((b) => b !== null));
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = branchJson(repo, decodeURIComponent(rest[1]!));
        if (branch === null) return error(404, 'Not Found');
        return answer(200, branch);
      }
      return error(404, 'Not Found');
    }

    // GET /commits[?sha=]
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = ctx.query.get('sha');
      const tip = shaParam === null ? branchTip(repo, repo.defaultBranch) : branchTip(repo, shaParam) ?? (isOidLike(shaParam) ? shaParam : null);
      if (tip === null) return answer(200, []);
      const page = pageOf(ctx);
      const history = commitHistory(repo, tip, page.perPage * page.page);
      const { pageItems } = paginate(history, page);
      return answer(200, pageItems.map((sha) => commitJson(repo, sha)));
    }

    // /git/refs...
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'GET' && rest.length === 2) {
        const refs = [...repo.refs.keys()].sort().map((ref) => {
          const oid = repo.refs.get(ref)!;
          const obj = repo.objects.get(oid);
          return { ref, object: { sha: oid, type: obj?.type ?? 'commit' } };
        });
        return answer(200, refs);
      }
      if (method === 'GET' && rest.length > 2) {
        const refName = `refs/${rest.slice(2).map((segment) => decodeURIComponent(segment)).join('/')}`;
        const oid = repo.refs.get(refName);
        if (oid === undefined) return error(404, 'Not Found');
        const obj = repo.objects.get(oid);
        return answer(200, { ref: refName, object: { sha: oid, type: obj?.type ?? 'commit' } });
      }
      if (method === 'POST' && rest.length === 2) {
        const body = jsonBody(ctx);
        const ref = asString(body.ref);
        const sha = asString(body.sha);
        if (ref === undefined || !ref.startsWith('refs/')) throw new StoreError(422, 'ref must start with refs/');
        if (sha === undefined || !repo.objects.has(sha)) throw new StoreError(422, 'sha does not exist');
        if (repo.refs.has(ref)) throw new StoreError(422, `Reference ${ref} already exists`);
        repo.refs.set(ref, sha);
        const obj = repo.objects.get(sha);
        return answer(201, { ref, object: { sha, type: obj?.type ?? 'commit' } });
      }
      return error(404, 'Not Found');
    }

    // /contents/{path...}
    if (rest[0] === 'contents') {
      const path = contentsPathOf(rest.slice(1));
      const branch = ctx.query.get('ref') ?? undefined;
      if (method === 'GET') {
        const tip = branch === undefined ? branchTip(repo, repo.defaultBranch) : branchTip(repo, branch);
        const tree = tip === null ? null : commitTree(repo, tip);
        if (path === '') {
          if (tree === null) return answer(200, []);
          const entries = dirEntries(repo, tree, '') ?? [];
          return answer(200, entries.map((entry) => dirEntryJson(repo, entry, '')));
        }
        const blob = blobAtPath(repo, tree, path);
        if (blob !== null) return answer(200, contentFileJson(repo, path, blob));
        const entries = tree === null ? null : dirEntries(repo, tree, path);
        if (entries === null) return error(404, 'Not Found');
        return answer(200, entries.map((entry) => dirEntryJson(repo, entry, path)));
      }
      if (method === 'PUT') {
        const body = jsonBody(ctx);
        const message = asString(body.message) ?? 'Update file';
        const content = asString(body.content);
        if (content === undefined) throw new StoreError(422, 'content is required');
        const branchBody = asString(body.branch);
        const sha = asString(body.sha);
        const result = putContent(repo, path, content, message, branchBody, sha);
        return answer(result.status, {
          content: { ...contentFileJson(repo, path, result.blobSha), name: path.split('/').pop() ?? path },
          commit: { sha: result.commitSha, message },
        });
      }
      if (method === 'DELETE') {
        const body = jsonBody(ctx);
        const message = asString(body.message) ?? 'Delete file';
        const branchBody = asString(body.branch);
        const sha = asString(body.sha);
        const targetBranch = branchBody ?? repo.defaultBranch;
        const tip = branchTip(repo, targetBranch);
        if (tip === null) return error(404, 'Not Found');
        const tree = commitTree(repo, tip);
        const existing = blobAtPath(repo, tree, path);
        if (existing === null) return error(404, 'Not Found');
        if (sha !== undefined && sha !== existing) throw new StoreError(409, 'sha does not match the current file');
        const newTree = treeWithoutPath(repo, tree, path);
        const commitSha = makeCommit(repo, newTree, [tip], message);
        repo.refs.set(`refs/heads/${targetBranch}`, commitSha);
        return answer(200, { commit: { sha: commitSha, message } });
      }
      return error(404, 'Not Found');
    }

    // /labels
    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        const labels = [...repo.labels.values()];
        return answer(200, labels.map((label, index) => labelJson(repo, label, index)));
      }
      if (rest.length === 1 && method === 'POST') {
        const body = jsonBody(ctx);
        const name = asString(body.name);
        if (name === undefined || name === '') throw new StoreError(422, 'Label name is required');
        const color = asString(body.color) ?? 'ededed';
        const label = store.createLabel(repo, name, color);
        return answer(201, labelJson(repo, label, repo.labels.size - 1));
      }
      return error(404, 'Not Found');
    }

    // /issues...
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const direction = ctx.query.get('direction') ?? 'desc';
          let issues = [...repo.issues];
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const page = pageOf(ctx);
          const { pageItems } = paginate(issues, page);
          const link = linkHeader(ctx, `/api/v3/repos/${owner}/${name}/issues`, page, issues.length);
          return answer(200, pageItems.map((issue) => issueJson(repo, issue)), link === null ? undefined : { link });
        }
        if (method === 'POST') {
          const body = jsonBody(ctx);
          const title = asString(body.title);
          if (title === undefined || title === '') throw new StoreError(422, 'Title is required');
          const labels = asStringArray(body.labels);
          const issue = store.createIssue(repo, title, asString(body.body) ?? '', labels);
          return answer(201, issueJson(repo, issue));
        }
        return error(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return error(404, 'Not Found');
      const issue = store.issueByNumber(repo, number);
      if (rest.length === 2) {
        if (issue === undefined) return error(404, 'Not Found');
        if (method === 'GET') return answer(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          const body = jsonBody(ctx);
          const state = asString(body.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = asString(body.title);
          if (title !== undefined) issue.title = title;
          const bodyText = asString(body.body);
          if (bodyText !== undefined) issue.body = bodyText;
          return answer(200, issueJson(repo, issue));
        }
        return error(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) return error(404, 'Not Found');
        if (method === 'GET') {
          const page = pageOf(ctx);
          const { pageItems } = paginate(issue.comments, page);
          return answer(200, pageItems.map(commentJson));
        }
        if (method === 'POST') {
          const body = jsonBody(ctx);
          const text = asString(body.body);
          if (text === undefined || text === '') throw new StoreError(422, 'Comment body is required');
          const comment = store.addComment(issue, text);
          return answer(201, commentJson(comment));
        }
        return error(404, 'Not Found');
      }
      return error(404, 'Not Found');
    }

    // /pulls...
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let pulls = [...repo.pulls];
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.seq - a.seq);
          const page = pageOf(ctx);
          const { pageItems } = paginate(pulls, page);
          const link = linkHeader(ctx, `/api/v3/repos/${owner}/${name}/pulls`, page, pulls.length);
          return answer(200, pageItems.map((pull) => pullJson(repo, pull)), link === null ? undefined : { link });
        }
        if (method === 'POST') {
          const body = jsonBody(ctx);
          const title = asString(body.title);
          const head = asString(body.head);
          const base = asString(body.base);
          if (title === undefined || title === '') throw new StoreError(422, 'Title is required');
          if (head === undefined || base === undefined) throw new StoreError(422, 'head and base are required');
          const pull = store.createPull(repo, title, asString(body.body) ?? '', head, base);
          return answer(201, pullJson(repo, pull));
        }
        return error(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return error(404, 'Not Found');
      const pull = store.pullByNumber(repo, number);
      if (rest.length === 2) {
        if (pull === undefined) return error(404, 'Not Found');
        if (method === 'GET') return answer(200, pullJson(repo, pull));
        return error(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pull === undefined) return error(404, 'Not Found');
        const files = store.pullFiles(repo, pull).map((change) => ({
          filename: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.additions + change.deletions,
          sha: change.newOid ?? change.oldOid ?? '',
        }));
        return answer(200, files);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) return error(404, 'Not Found');
        const sha = store.mergePull(repo, pull);
        return answer(200, { merged: true, sha, message: `${pull.title}\n` });
      }
      return error(404, 'Not Found');
    }

    return error(404, 'Not Found');
  }

  return error(404, 'Not Found');
}

function dirEntryJson(repo: Repo, entry: { mode: string; name: string; oid: string }, parent: string): Record<string, unknown> {
  const path = parent === '' ? entry.name : `${parent}/${entry.name}`;
  const out: Record<string, unknown> = {
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
  };
  if (entry.mode !== '40000') {
    const obj = repo.objects.get(entry.oid);
    out.size = obj?.data.length ?? 0;
  }
  return out;
}

function isOidLike(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}
