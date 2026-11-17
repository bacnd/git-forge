// store.ts — the forge's one in-memory store: repositories, git objects and refs,
// issues, labels, comments and pull requests. REST, GraphQL, MCP and the git wire
// all read and write these same objects, so every surface agrees by construction.

import {
  buildCommit,
  buildTreeFromFlat,
  flattenTree,
  parseCommit,
  parseTree,
  peelObject,
  putObject,
  sortTreeEntries,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';

/** Civil-date arithmetic (Howard Hinnant's algorithm): days since 1970-01-01. */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [mp < 10 ? y : y + 1, m, d];
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const pad4 = (n: number): string => String(n).padStart(4, '0');

/** Format unix epoch seconds as ISO 8601 UTC (no Date object anywhere). */
export function isoFromUnixSeconds(sec: number): string {
  const days = Math.floor(sec / 86400);
  const tod = sec - days * 86400;
  const [y, m, d] = civilFromDays(days);
  return `${pad4(y)}-${pad2(m)}-${pad2(d)}T${pad2(Math.floor(tod / 3600))}:${pad2(Math.floor((tod % 3600) / 60))}:${pad2(tod % 60)}Z`;
}

/** The trial's fixed now: MAKEFUN_TRIAL_NOW (RFC 3339, or epoch milliseconds). */
function trialNowMs(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw === '') return daysFromCivil(2026, 1, 1) * 86400000;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(raw);
  if (match === null) return daysFromCivil(2026, 1, 1) * 86400000;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const hh = Number(match[4]);
  const mi = Number(match[5]);
  const ss = Number(match[6]);
  const frac = match[7] ?? '';
  const ms = frac === '' ? 0 : Number((frac + '000').slice(0, 3));
  let offsetMin = 0;
  const zone = match[8] ?? 'Z';
  if (zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  return (daysFromCivil(y, mo, d) * 86400 + hh * 3600 + mi * 60 + ss - offsetMin * 60) * 1000 + ms;
}

const TRIAL_NOW_MS = trialNowMs();
const TRIAL_NOW_ISO = isoFromUnixSeconds(Math.floor(TRIAL_NOW_MS / 1000));
const TRIAL_NOW_SEC = Math.floor(TRIAL_NOW_MS / 1000);

/** The fixed instant every created/updated timestamp in a trial carries. */
export function trialNowIso(): string {
  return TRIAL_NOW_ISO;
}

/** The trial now as epoch seconds, for git author/committer lines. */
export function trialNowSec(): number {
  return TRIAL_NOW_SEC;
}

/** The viewer: the token's login, fixed by the trial scenario. */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** The identity string git commits by this forge carry. */
export const COMMIT_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

/** The token the trial hands the entry (MAKEFUN_SHOP_TOKEN); '' means accept any in dev. */
export const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';

// ---------------------------------------------------------------- domain types

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  repoId: number;
}

export interface Issue {
  id: number;
  repoId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  seq: number;
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  repoId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  seq: number;
  comments: IssueComment[];
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextIssue: number;
  nextPull: number;
  createdAt: string;
  seq: number;
}

/** A domain refusal: carries the HTTP status the surface should answer with. */
export class StoreError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- git helpers on a repo

/** The tip a ref points at, or null when the ref does not exist. */
export function refTip(repo: Repo, ref: string): string | null {
  return repo.refs.get(ref) ?? null;
}

/** The tip of a branch, or null. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** The commit object at an oid, or null when it is missing or not a commit. */
export function commitOf(repo: Repo, oid: string): { tree: string; parents: string[]; message: string } | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

/** All ancestors of a commit (itself included), newest-first breadth order. */
export function ancestors(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return seen;
}

/** The merge base of two commits: the first common ancestor walking from `a`. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const bAncestors = ancestors(repo, b);
  const queue = [a];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (bAncestors.has(oid)) return oid;
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return null;
}

/** Whether `ancestor` is reachable from `tip` (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return ancestors(repo, tip).has(ancestor);
}

/** One changed path between two trees. */
export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** Line counts between two blobs (multiset diff of lines). */
export function lineStats(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
  const linesOf = (oid: string | null): string[] => {
    if (oid === null) return [];
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'blob') return [];
    const text = obj.data.toString('utf8');
    if (text === '') return [];
    return text.split('\n');
  };
  const oldLines = linesOf(oldOid);
  const newLines = linesOf(newOid);
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCount.get(line) ?? 0;
    if (left > 0) oldCount.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCount.values()) deletions += left;
  return { additions, deletions };
}

/** The changed paths between two trees (base -> head). */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = flattenTree(repo.objects, baseTree);
  const head = flattenTree(repo.objects, headTree);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const from = base.get(path);
    const to = head.get(path);
    if (from === undefined && to !== undefined) {
      const stats = lineStats(repo, null, to.oid);
      changes.push({ path, status: 'added', oldOid: null, newOid: to.oid, additions: stats.additions, deletions: 0 });
    } else if (from !== undefined && to === undefined) {
      const stats = lineStats(repo, from.oid, null);
      changes.push({ path, status: 'removed', oldOid: from.oid, newOid: null, additions: 0, deletions: stats.deletions });
    } else if (from !== undefined && to !== undefined && from.oid !== to.oid) {
      const stats = lineStats(repo, from.oid, to.oid);
      changes.push({ path, status: 'modified', oldOid: from.oid, newOid: to.oid, additions: stats.additions, deletions: stats.deletions });
    }
  }
  return changes;
}

/**
 * Three-way merge of trees: base is the merge base, `ours` the base branch, `theirs` the head.
 * Returns the merged tree's id, or the conflicting paths when both sides changed one differently.
 */
export function mergeTrees(
  repo: Repo,
  baseTree: string,
  oursTree: string,
  theirsTree: string,
): { tree: string } | { conflicts: string[] } {
  const base = flattenTree(repo.objects, baseTree);
  const ours = flattenTree(repo.objects, oursTree);
  const theirs = flattenTree(repo.objects, theirsTree);
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const result = new Map<string, { oid: string; mode: string }>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const oChanged = (o?.oid ?? null) !== (b?.oid ?? null);
    const tChanged = (t?.oid ?? null) !== (b?.oid ?? null);
    if (!oChanged && !tChanged) {
      if (b !== undefined) result.set(path, b);
    } else if (oChanged && !tChanged) {
      if (o !== undefined) result.set(path, o);
    } else if (!oChanged && tChanged) {
      if (t !== undefined) result.set(path, t);
    } else if ((o?.oid ?? null) === (t?.oid ?? null)) {
      if (o !== undefined) result.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { conflicts };
  return { tree: buildTreeFromFlat(repo.objects, result) };
}

/** Create a commit object in a repo and return its id. */
export function makeCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
  return putObject(repo.objects, 'commit', buildCommit(tree, parents, message, trialNowSec(), COMMIT_IDENTITY));
}

/** The tree of a commit, or '' when the commit is missing. */
export function commitTree(repo: Repo, oid: string): string {
  return commitOf(repo, oid)?.tree ?? '';
}

/** Replace one path in a tree with a new blob (creating parent trees as needed). */
export function treeWithPath(repo: Repo, rootTree: string | null, path: string, blobOid: string): string {
  const flat = rootTree === null ? new Map() : flattenTree(repo.objects, rootTree);
  flat.set(path, { oid: blobOid, mode: '100644' });
  return buildTreeFromFlat(repo.objects, flat);
}

/** Remove one path from a tree. */
export function treeWithoutPath(repo: Repo, rootTree: string, path: string): string {
  const flat = flattenTree(repo.objects, rootTree);
  flat.delete(path);
  return buildTreeFromFlat(repo.objects, flat);
}

/** Read a file's blob id from a tree path, or null. */
export function blobAtPath(repo: Repo, rootTree: string | null, path: string): string | null {
  if (rootTree === null) return null;
  return flattenTree(repo.objects, rootTree).get(path)?.oid ?? null;
}

/** List a directory's entries at a tree path ('' is the root). */
export function dirEntries(repo: Repo, rootTree: string | null, path: string): TreeEntry[] | null {
  if (rootTree === null) return null;
  let current = rootTree;
  if (path !== '') {
    // Walk down through intermediate trees.
    const segments = path.split('/');
    for (const segment of segments) {
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === segment);
      if (entry === undefined || entry.mode !== '40000') return null;
      current = entry.oid;
    }
  }
  const obj = repo.objects.get(current);
  if (obj === undefined || obj.type !== 'tree') return null;
  return sortTreeEntries(parseTree(obj.data));
}

// ---------------------------------------------------------------- the store

/** Opaque global ids (base64 of a kind-prefixed key); never the plain database id. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

/** Decode a global id into [kind, key], or null when it is not one of ours. */
export function parseGlobalId(id: string): [string, string] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return [text.slice(0, colon), text.slice(colon + 1)];
  } catch {
    return null;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPullId = 1;
  nextSeq = 1;
  requestSeq = 1;

  /** A deterministic per-request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    const id = this.requestSeq;
    this.requestSeq += 1;
    return `req-${id}`;
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** Create a repository under the viewer; throws 422 when the name already exists. */
  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    if (this.repos.has(this.key(owner, name))) {
      throw new StoreError(422, `Repository ${owner}/${name} already exists`);
    }
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      createdAt: trialNowIso(),
      seq: this.nextSeq,
    };
    this.nextRepoId += 1;
    this.nextSeq += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Create a label; throws 422 when it already exists. */
  createLabel(repo: Repo, name: string, color: string): Label {
    if (repo.labels.has(name)) throw new StoreError(422, `Label ${name} already exists`);
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  /** Create an issue; throws 422 when a named label does not exist. */
  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue {
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new StoreError(422, `Label ${name} does not exist`);
    }
    const issue: Issue = {
      id: this.nextIssueId,
      repoId: repo.id,
      number: repo.nextIssue,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: trialNowIso(),
      seq: this.nextSeq,
      comments: [],
    };
    this.nextIssueId += 1;
    this.nextSeq += 1;
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return issue;
  }

  issueByNumber(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  pullByNumber(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** Create a pull request; throws 422 for a missing branch or a duplicate open head+base. */
  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest {
    const headSha = branchTip(repo, headRef);
    const baseSha = branchTip(repo, baseRef);
    if (headSha === null) throw new StoreError(422, `Head branch ${headRef} does not exist`);
    if (baseSha === null) throw new StoreError(422, `Base branch ${baseRef} does not exist`);
    for (const pull of repo.pulls) {
      if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) {
        throw new StoreError(422, `A pull request is already open for ${headRef} into ${baseRef}`);
      }
    }
    const pull: PullRequest = {
      id: this.nextPullId,
      repoId: repo.id,
      number: repo.nextPull,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      createdAt: trialNowIso(),
      seq: this.nextSeq,
      comments: [],
    };
    this.nextPullId += 1;
    this.nextSeq += 1;
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** Whether a pull request merges cleanly, and why not. */
  mergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const head = commitOf(repo, headSha);
    const base = commitOf(repo, baseSha);
    if (head === null || base === null) return 'UNKNOWN';
    const baseOid = mergeBase(repo, headSha, baseSha);
    if (baseOid === null) return 'UNKNOWN';
    const merged = mergeTrees(repo, commitTree(repo, baseOid), base.tree, head.tree);
    return 'conflicts' in merged ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Squash-merge a pull request onto its base branch. Throws 405 when it is already
   * merged/closed or the merge conflicts; returns the new commit's id.
   */
  mergePull(repo: Repo, pull: PullRequest): string {
    if (pull.state !== 'open') throw new StoreError(405, 'Pull request is already closed');
    const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const head = commitOf(repo, headSha);
    const base = commitOf(repo, baseSha);
    if (head === null || base === null) throw new StoreError(405, 'Pull request branches are missing');
    const baseOid = mergeBase(repo, headSha, baseSha);
    if (baseOid === null) throw new StoreError(405, 'Pull request has no merge base');
    const merged = mergeTrees(repo, commitTree(repo, baseOid), base.tree, head.tree);
    if ('conflicts' in merged) {
      throw new StoreError(405, `Merge conflict in ${merged.conflicts.join(', ')}`);
    }
    const message = `${pull.title}\n`;
    const sha = makeCommit(repo, merged.tree, [baseSha], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = trialNowIso();
    pull.mergeCommitSha = sha;
    return sha;
  }

  /** The files a pull request changes (merge base -> head), with line counts. */
  pullFiles(repo: Repo, pull: PullRequest): FileChange[] {
    const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const baseOid = mergeBase(repo, headSha, baseSha);
    const head = commitOf(repo, headSha);
    if (head === null) return [];
    const baseTree = baseOid === null ? '' : commitTree(repo, baseOid);
    return diffTrees(repo, baseTree, head.tree);
  }

  /** Add a comment to an issue or a pull request. */
  addComment(target: Issue | PullRequest, body: string): IssueComment {
    const comment: IssueComment = { id: this.nextCommentId, body, createdAt: trialNowIso(), repoId: target.repoId };
    this.nextCommentId += 1;
    target.comments.push(comment);
    return comment;
  }
}

/** The one store for the process. */
export const store = new Store();

/** The object id of a ref, peeling annotated tags. */
export function peeledTip(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  return peelObject(repo.objects, oid);
}
