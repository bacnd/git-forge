// gitproto.ts — git smart HTTP: protocol v2 and v0 advertisements, ls-refs, fetch
// (upload-pack) and push (receive-pack). Packs are built and read here; the object
// model lives in gitobj.ts and the shared store in store.ts.

import {
  commitOf,
  isAncestor,
  refTip,
  store,
  VIEWER,
  type Repo,
} from './store.ts';
import {
  decodePktLines,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelObject,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';

const AGENT = 'git-forge/1.0.0';

/** What a handler answers with. */
export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function gitResponse(status: number, contentType: string, body: Buffer): GitResponse {
  return { status, contentType, body };
}

function notFound(message: string): GitResponse {
  return gitResponse(404, 'application/json; charset=utf-8', Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8'));
}

/** The repo a git route names, or null when it is not the viewer's repository. */
function findRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

/** All refs of a repo, in advertisement order: HEAD, branches, tags (peeled after their tag). */
interface AdvertisedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function listRefs(repo: Repo): AdvertisedRef[] {
  const refs: AdvertisedRef[] = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  refs.push({ oid: mainTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: mainTip === ZERO_OID });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: AdvertisedRef = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      entry.peeled = peelObject(repo.objects, oid);
    }
    refs.push(entry);
  }
  return refs;
}

// ---------------------------------------------------------------- advertisements

function v2Advertisement(): Buffer {
  // Protocol v2 opens with the version line itself: git's discovery dies on a
  // '# service=' line here (that line belongs to the v0 advertisement only).
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
  ];
  const parts = lines.map((line) => pktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow object-format=sha1 agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const refs = listRefs(repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  // Capabilities ride on the first emitted ref line (see below).
  let capsEmitted = false;
  if (refs.length === 0 || (refs.length === 1 && refs[0]!.unborn === true && repo.refs.size === 0)) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref) => {
      if (ref.unborn === true) return; // v0 lists no unborn ref except the empty-repo line
      const suffix = capsEmitted ? '' : `\0${caps}`;
      capsEmitted = true;
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(owner: string, repoName: string, service: string, gitProtocol: string | undefined): GitResponse {
  const repo = findRepo(owner, repoName);
  if (repo === null) return notFound('Not Found');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return gitResponse(400, 'application/json; charset=utf-8', Buffer.from(`${JSON.stringify({ message: 'unknown service' })}\n`, 'utf8'));
  }
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    return gitResponse(200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
  }
  return gitResponse(200, `application/x-${service}-advertisement`, v0Advertisement(repo, service));
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  pack: Buffer | null;
  acks: string[];
  shallow: string[];
  unshallow: string[];
}

/** All objects reachable from a set of commits (commits, their trees and blobs, tags peeled).
 * A commit in `stopAt` is held itself, but its parents are not: that is what a shallow
 * boundary means, so the walk takes its tree and blobs and stops at its parents. */
function reachableObjects(repo: Repo, roots: readonly string[], stopAt?: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (found.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    found.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      // Push the tree and let the pop path add it to `found`: eagerly adding it
      // here would mark it visited and skip walking its entries (the bug that
      // made a held commit's blobs look unheld, so an incremental fetch re-sent
      // them).
      stack.push(commit.tree);
      if (stopAt === undefined || !stopAt.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return found;
}

/**
 * Plan a fetch: which objects to send, which haves to ACK, and the shallow boundaries.
 * `wants` are oids, `haves` are oids the client holds, `clientShallow` the boundaries it
 * already has, `deepen` an optional depth limit (1 = tips only).
 */
function planFetch(repo: Repo, wants: string[], haves: string[], clientShallow: string[], deepen: number | null): FetchPlan {
  // What the client already holds: the haves' closure, stopping at its shallow
  // boundaries (a boundary's parents are not held, that is what makes it shallow).
  const boundarySet = new Set(clientShallow);
  const held = reachableObjects(repo, haves, boundarySet);
  const acks: string[] = [];
  for (const have of haves) {
    if (repo.objects.has(have)) acks.push(have);
  }
  // Commit set: breadth-first from the wants, bounded by depth. A held commit is never
  // re-sent, but the walk passes through a held want root or a held shallow boundary
  // while deepening, because that is where the new history lives. The depth limit
  // applies to held commits too: a held root at the limit sends nothing more.
  const commits = new Set<string>();
  const wantRoots = new Set<string>();
  for (const want of wants) wantRoots.add(peelObject(repo.objects, want));
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) {
    const peeled = peelObject(repo.objects, want);
    const obj = repo.objects.get(peeled);
    if (obj !== undefined && obj.type === 'commit') queue.push({ oid: peeled, depth: 1 });
  }
  const shallowSet = new Set<string>();
  const visited = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const commit = commitOf(repo, oid);
    if (commit === null) continue;
    const atLimit = deepen !== null && depth >= deepen;
    if (!held.has(oid)) {
      commits.add(oid);
      if (atLimit) {
        if (commit.parents.length > 0) shallowSet.add(oid);
        continue;
      }
    } else {
      if (atLimit) continue;
      if (!wantRoots.has(oid) && !boundarySet.has(oid)) continue;
    }
    for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  // Shallow boundaries the client already has: unshallow when every parent is now
  // known to it (sent in this pack, or already held); otherwise still shallow.
  const unshallow: string[] = [];
  const shallow: string[] = [...shallowSet];
  for (const boundary of clientShallow) {
    const commit = commitOf(repo, boundary);
    if (commit === null) {
      if (!shallow.includes(boundary)) shallow.push(boundary);
      continue;
    }
    const fullyIncluded = commit.parents.every((p) => commits.has(p) || held.has(p));
    if (fullyIncluded) unshallow.push(boundary);
    else if (!shallow.includes(boundary)) shallow.push(boundary);
  }
  // Objects to send: the wanted commits' trees and blobs, plus wanted tag objects.
  const send = new Set<string>();
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj !== undefined && obj.type === 'tag') send.add(want);
  }
  for (const oid of commits) {
    send.add(oid);
    const commit = commitOf(repo, oid)!;
    for (const found of reachableObjects(repo, [commit.tree])) send.add(found);
  }
  for (const heldOid of held) send.delete(heldOid);
  const packObjects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) packObjects.push(obj);
  }
  return {
    pack: packObjects.length > 0 ? writePack(packObjects) : null,
    acks,
    shallow: [...new Set(shallow)].sort(),
    unshallow: [...new Set(unshallow)].sort(),
  };
}

/** Split pack bytes into sideband-64k band-1 packets (each pkt-line <= 65520 bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const maxChunk = 65520 - 4 - 1;
  for (let off = 0; off < pack.length; off += maxChunk) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + maxChunk));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

// ---------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
}

/** Parse a v2 fetch/ls-refs request body into its command and arguments. */
function parseV2Request(body: Buffer): { command: string; args: string[] } | null {
  const { packets } = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).trim();
    } else {
      args.push(line.replace(/\n$/, ''));
    }
  }
  if (command === '') return null;
  return { command, args };
}

/** The v2 ls-refs answer: one line per matching ref. */
function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const refs = listRefs(repo);
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.unborn === true) {
      if (!unborn) continue;
      const extra = symrefs && ref.symrefTarget !== undefined ? ` symref-target:${ref.symrefTarget}` : '';
      parts.push(pktLine(`unborn ${ref.name}${extra}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v2 fetch answer: acknowledgments (only when the client sent haves), shallow-info
 * (only when there are boundaries to report), then the packfile section. Real git
 * rejects an acknowledgments section on a fetch that sent no haves, so the sections
 * are conditional; the kit client dispatches on the headers either way. */
function fetchV2Response(repo: Repo, args: string[]): Buffer {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) req.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) req.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isInteger(n) && n > 0) req.deepen = n;
    }
  }
  const plan = planFetch(repo, req.wants, req.haves, req.shallow, req.deepen);
  const parts: Buffer[] = [];
  if (req.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (plan.pack !== null) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(plan.pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The v0 fetch answer: NAK/ACK/shallow lines, then the sideband pack. */
function fetchV0Response(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null };
  let pastFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      pastFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastFlush) {
      if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0]!);
      else if (line.startsWith('shallow ')) req.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isInteger(n) && n > 0) req.deepen = n;
      }
    } else {
      if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    }
  }
  const plan = planFetch(repo, req.wants, req.haves, req.shallow, req.deepen);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.pack !== null) parts.push(...sidebandPack(plan.pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(owner: string, repoName: string, body: Buffer, gitProtocol: string | undefined): GitResponse {
  const repo = findRepo(owner, repoName);
  if (repo === null) return notFound('Not Found');
  if (gitProtocol === 'version=2') {
    const parsed = parseV2Request(body);
    if (parsed === null) {
      return gitResponse(400, 'application/json; charset=utf-8', Buffer.from(`${JSON.stringify({ message: 'bad request' })}\n`, 'utf8'));
    }
    if (parsed.command === 'ls-refs') {
      return gitResponse(200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, parsed.args));
    }
    if (parsed.command === 'fetch') {
      return gitResponse(200, 'application/x-git-upload-pack-result', fetchV2Response(repo, parsed.args));
    }
    return gitResponse(400, 'application/json; charset=utf-8', Buffer.from(`${JSON.stringify({ message: 'unknown command' })}\n`, 'utf8'));
  }
  return gitResponse(200, 'application/x-git-upload-pack-result', fetchV0Response(repo, body));
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** The pkt-lined report-status body, wrapped in sideband band-1 packets. */
function pushReport(unpack: string, refs: Array<{ ref: string; ok: boolean; reason: string }>): Buffer {
  const lines: string[] = [`unpack ${unpack}\n`];
  for (const ref of refs) {
    lines.push(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`);
  }
  const report = Buffer.concat(lines.map((line) => pktLine(line)));
  const parts: Buffer[] = [];
  const maxChunk = 65520 - 4 - 1;
  for (let off = 0; off < report.length; off += maxChunk) {
    const chunk = report.subarray(off, Math.min(report.length, off + maxChunk));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export async function handleReceivePack(owner: string, repoName: string, body: Buffer): Promise<GitResponse> {
  const repo = findRepo(owner, repoName);
  if (repo === null) return notFound('Not Found');
  const { packets, rest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const line = nul >= 0 ? text.slice(0, nul) : text;
    const parts = line.split(' ');
    if (parts.length < 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  const contentType = 'application/x-git-receive-pack-result';
  // The pack follows the command flush (absent for a delete-only push).
  if (rest.length > 0) {
    let incoming: Map<string, GitObject>;
    try {
      if (!verifyPackChecksum(rest)) throw new Error('pack checksum mismatch');
      incoming = await readPack(rest, (oid) => repo.objects.get(oid));
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unpack error';
      return gitResponse(200, contentType, pushReport(detail, []));
    }
    for (const [oid, obj] of incoming) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = refTip(repo, command.ref);
    let ok = false;
    let reason = 'non-fast-forward';
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === null) {
        reason = 'non-fast-forward';
      } else if (command.oldOid === ZERO_OID || command.oldOid === current) {
        ok = true;
      }
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (current === null && repo.objects.has(command.newOid)) ok = true;
    } else if (current !== null && command.oldOid === current) {
      // Update: fast-forward only.
      if (command.newOid === current) ok = true;
      else if (repo.objects.has(command.newOid) && isAncestor(repo, current, command.newOid)) ok = true;
    }
    if (ok) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
    }
    results.push({ ref: command.ref, ok, reason });
  }
  return gitResponse(200, contentType, pushReport('ok', results));
}
