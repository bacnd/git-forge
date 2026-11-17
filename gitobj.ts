// gitobj.ts — the forge's own git object model: loose objects, trees, commits, tags,
// pkt-lines, and packfiles (read with delta application, write as plain objects).
// Everything here is written from the git wire format itself; no git binary, no library.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The four object kinds git stores. */
export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

/** One object: its kind and its raw content bytes (without the "type len\0" header). */
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** The SHA-1 id of an object with this kind and content. */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Store an object in a map (if absent) and return its id. */
export function putObject(objects: Map<string, GitObject>, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

/** Whether a string is a 40-hex object id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- trees

/** One entry of a tree object. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const nul = data.indexOf(0, space);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(off, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

/** Serialize tree entries (in the order given) to a tree object's bytes. */
export function serializeTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git's tree order: names compared byte-wise, directories as if they ended with '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (entry: TreeEntry): string => (entry.mode === '40000' ? `${entry.name}/` : entry.name);
  return [...entries].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Flatten a tree (recursively) to path -> {oid, mode}. Missing trees read as empty. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [sub, value] of flattenTree(objects, entry.oid, path)) out.set(sub, value);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Build nested trees from a flat path map; returns the root tree's id. */
export function buildTreeFromFlat(objects: Map<string, GitObject>, flat: Map<string, { oid: string; mode: string }>): string {
  // Group paths by their first segment, recursing into subdirectories.
  const build = (paths: Array<{ rest: string[]; oid: string; mode: string }>): string => {
    const files: TreeEntry[] = [];
    const dirs = new Map<string, Array<{ rest: string[]; oid: string; mode: string }>>();
    for (const item of paths) {
      if (item.rest.length === 1) {
        files.push({ mode: item.mode, name: item.rest[0]!, oid: item.oid });
      } else {
        const head = item.rest[0]!;
        const bucket = dirs.get(head) ?? [];
        bucket.push({ rest: item.rest.slice(1), oid: item.oid, mode: item.mode });
        dirs.set(head, bucket);
      }
    }
    const entries: TreeEntry[] = [...files];
    for (const [name, bucket] of dirs) entries.push({ mode: '40000', name, oid: build(bucket) });
    return putObject(objects, 'tree', serializeTree(sortTreeEntries(entries)));
  };
  const items = [...flat.entries()].map(([path, value]) => ({ rest: path.split('/'), oid: value.oid, mode: value.mode }));
  return build(items);
}

// ---------------------------------------------------------------- commits and tags

/** The parsed header of a commit object. */
export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's bytes. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

/** Serialize a commit: one parent list, viewer identity, trial-now timestamp. */
export function buildCommit(tree: string, parents: readonly string[], message: string, epochSec: number, identity: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identity} ${epochSec} +0000`);
  lines.push(`committer ${identity} ${epochSec} +0000`);
  lines.push('');
  lines.push(message.endsWith('\n') ? message : `${message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** The parsed header of an annotated tag object. */
export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse a tag object's bytes. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Follow annotated tags to the object they point at (commit, tree or blob). */
export function peelObject(objects: Map<string, GitObject>, oid: string): string {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const obj = objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line carrying `payload` (a string is UTF-8 text; a Buffer is raw bytes). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** The flush packet (0000). */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet (0001). */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** One decoded packet: flush, delim, response-end, or data with its payload. */
export type Packet = { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' } | { kind: 'data'; payload: Buffer };

/** Decode a whole buffer of pkt-lines. Stops at the first malformed packet. */
export function decodePktLines(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenText = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------- packs

const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Inflate the one deflate stream starting at `off` in `buf`. A streaming Inflate
 * consumes exactly the stream's bytes, so `bytesWritten` is the deflated length —
 * one inflate per object instead of a binary search of repeated inflates. */
function inflateOne(buf: Buffer, off: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const inf = createInflate();
    const chunks: Buffer[] = [];
    inf.on('data', (chunk: Buffer) => chunks.push(chunk));
    inf.on('error', reject);
    inf.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: inf.bytesWritten }));
    inf.end(buf.subarray(off));
  });
}

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos]!;
      if (op & 0x02) offset |= delta[pos]! << 8;
      if (op & 0x04) offset |= delta[pos]! << 16;
      if (op & 0x08) offset |= delta[pos]! << 24;
      if (op & 0x10) size = delta[pos]!;
      if (op & 0x20) size |= delta[pos]! << 8;
      if (op & 0x40) size |= delta[pos]! << 16;
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || outLen !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

/** Read a packfile (version 2) into objects, resolving deltas against the pack and `resolveBase`. */
export async function readPack(buf: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Promise<Map<string, GitObject>> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let off = 12;
  // First pass: read every entry's raw bytes (deltas kept aside with their base reference).
  interface RawEntry {
    offset: number;
    typeNum: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const entries: RawEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = off;
    let byte = buf[off]!;
    off += 1;
    const typeNum = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[off]!;
      off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeNum === 6) {
      // OFS_DELTA: a negative offset varint back to the base entry.
      let b = buf[off]!;
      off += 1;
      let offset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = buf[off]!;
        off += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - offset;
    } else if (typeNum === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const { data, consumed } = await inflateOne(buf, off);
    if (data.length !== size) throw new Error('pack object size mismatch');
    off += consumed;
    entries.push({ offset: start, typeNum, size, data, baseOffset, baseOid });
  }
  // Second pass: resolve entries in order (a delta's base always precedes it, or lives outside).
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.typeNum >= 1 && entry.typeNum <= 4) {
      return { type: PACK_TYPES[entry.typeNum]!, data: entry.data };
    }
    let base: GitObject | undefined;
    if (entry.baseOffset !== undefined) base = byOffset.get(entry.baseOffset);
    else if (entry.baseOid !== undefined) base = objects.get(entry.baseOid) ?? resolveBase?.(entry.baseOid);
    if (base === undefined) throw new Error('delta base not found');
    return { type: base.type, data: applyDelta(base.data, entry.data) };
  };
  for (const entry of entries) {
    const obj = resolve(entry);
    const oid = hashObject(obj.type, obj.data);
    objects.set(oid, obj);
    byOffset.set(entry.offset, obj);
  }
  return objects;
}

/** Write a packfile (version 2) of plain (undeltified) objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    const typeNum = PACK_TYPE_IDS[obj.type];
    const size = obj.data.length;
    // Varint header: type in bits 4-6 of the first byte, size in the low bits.
    const header: number[] = [];
    let remaining = size;
    let first = (typeNum << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    header.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      header.push(byte);
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a packfile's SHA-1 trailer. */
export function verifyPackChecksum(buf: Buffer): boolean {
  if (buf.length < 20) return false;
  const expected = buf.subarray(buf.length - 20).toString('hex');
  const actual = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  return expected === actual;
}
