// Git object model, packfile read/write, pkt-line framing, and the in-memory
// store (repositories, refs, objects, issues, pull requests). Everything lives
// in memory: one process serves the whole trial, and no disk I/O is on any
// request path, which is what the timed workloads need.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { scenarioUsers, type ScenarioUser } from './scenario.ts';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer | Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.from(`${type} ${body.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(body).digest('hex');
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

// ---------------------------------------------------------------------------------------------
// commit / tree parsing and building
// ---------------------------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const out: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: a directory name compares as if it ended with '/'. */
export function compareTreeNames(a: string, aIsDir: boolean, b: string, bIsDir: boolean): number {
  const ka = a + (aIsDir ? '/' : '');
  const kb = b + (bIsDir ? '/' : '');
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((x, y) =>
    compareTreeNames(x.name, x.mode === '40000', y.name, y.mode === '40000'),
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a commit object body. Fixed identity/timestamps keep server-made commits deterministic. */
export const SERVER_IDENT = 'Forge <forge@example.invalid>';
export function buildCommit(tree: string, parents: readonly string[], message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${SERVER_IDENT} 0 +0000`);
  lines.push(`committer ${SERVER_IDENT} 0 +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim';
export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Decode a whole buffer of pkt-lines. Throws on a malformed length prefix. */
export function decodePktLines(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line truncated');
    const lenText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buffer.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return packets;
}

// ---------------------------------------------------------------------------------------------
// packfile read / write (plain objects, no deltas on write)
// ---------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, offset: number): { size: number; first: number; next: number } {
  let byte = buffer[offset] as number;
  let size = byte & 0x0f;
  let shift = 4;
  let next = offset + 1;
  const first = byte;
  while (byte & 0x80) {
    byte = buffer[next] as number;
    next += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, first, next };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA. Verifies the trailer checksum. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset] as number;
        offset += 1;
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack trailing bytes');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObject => {
    const cached = (entry as Raw & { resolved?: GitObject; oid?: string }).resolved;
    if (cached && (entry as Raw & { oid?: string }).oid) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid as string);
      if (!baseEntry) throw new Error('ref-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const obj = { type, data };
    (entry as Raw & { resolved?: GitObject; oid?: string }).resolved = obj;
    (entry as Raw & { oid?: string }).oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return obj;
  };
  for (const entry of raw) {
    const obj = resolve(entry);
    objects.set(hashObject(obj.type, obj.data), obj);
  }
  return objects;
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1 over the preceding bytes. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

/**
 * The objects reachable from `tips`, in traversal order. With `depth`, only commits
 * closer than `depth` generations to a tip are included (depth 1 = the tips only).
 * `exclude` removes objects (and prunes traversal below excluded commits).
 * Returns the objects plus the shallow boundary info: commits included whose
 * parent was not included, and old shallow boundaries that stopped being one.
 */
export function collectReachable(
  lookup: (oid: string) => GitObject | undefined,
  tips: Iterable<string>,
  options: { depth?: number; exclude?: ReadonlySet<string>; oldShallow?: readonly string[]; stopAt?: readonly string[] } = {},
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const objects = new Map<string, GitObject>();
  const exclude = options.exclude ?? new Set<string>();
  const depth = options.depth;
  const includedCommits = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const tip of tips) {
    if (!isOid(tip) || tip === ZERO_OID) continue;
    queue.push({ oid: tip, dist: 0 });
  }
  const seenCommit = new Set<string>();
  const addTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (objects.has(oid) || exclude.has(oid)) continue;
      const obj = lookup(oid);
      if (!obj || obj.type !== 'tree') continue;
      objects.set(oid, obj);
      for (const entry of parseTree(obj.data)) {
        if (exclude.has(entry.oid) || objects.has(entry.oid)) continue;
        if (entry.mode === '40000') stack.push(entry.oid);
        else {
          const blob = lookup(entry.oid);
          if (blob) objects.set(entry.oid, blob);
        }
      }
    }
  };
  while (queue.length) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    if (seenCommit.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      if (!exclude.has(oid)) objects.set(oid, obj);
      const target = parseTagTarget(obj.data);
      if (target) queue.push({ oid: target, dist });
      continue;
    }
    if (obj.type !== 'commit') {
      if (!exclude.has(oid)) objects.set(oid, obj);
      continue;
    }
    if (depth !== undefined && dist >= depth) continue;
    if (exclude.has(oid)) {
      // A held commit is normally skipped with its whole ancestry (the
      // client already has it). But a held SHALLOW boundary is different:
      // the client holds the boundary commit itself, not its parents, so
      // traversal must continue through it — without re-sending it.
      if (!(options.oldShallow ?? []).includes(oid)) continue;
      seenCommit.add(oid);
      for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, dist: dist + 1 });
      continue;
    }
    seenCommit.add(oid);
    includedCommits.add(oid);
    objects.set(oid, obj);
    const parsed = parseCommit(obj.data);
    if (parsed.tree) addTree(parsed.tree);
    // stopAt: a shallow boundary is held with its tree, but its parents are
    // not held — do not traverse below it. (Used when computing what a
    // shallow client already has; without this, the parent of a boundary
    // would wrongly count as held and never be sent.)
    if ((options.stopAt ?? []).includes(oid)) continue;
    for (const parent of parsed.parents) queue.push({ oid: parent, dist: dist + 1 });
  }
  // Shallow boundaries: included commits with a parent that was not included.
  const shallow: string[] = [];
  for (const oid of includedCommits) {
    const obj = objects.get(oid);
    if (!obj) continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.some((parent) => !includedCommits.has(parent))) shallow.push(oid);
  }
  // Unshallow: an old boundary whose parents are all now included or held (not shallow).
  const unshallow: string[] = [];
  const heldNonShallow = new Set<string>();
  for (const oid of exclude) {
    if (!(options.oldShallow ?? []).includes(oid)) heldNonShallow.add(oid);
  }
  for (const old of options.oldShallow ?? []) {
    const obj = lookup(old);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.every((p) => includedCommits.has(p) || heldNonShallow.has(p))) {
      unshallow.push(old);
    }
  }
  return { objects, shallow, unshallow };
}

export function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match ? (match[1] as string) : null;
}

/** Peel an annotated tag to its commit (or return the oid itself when it is one). */
export function peelToCommit(lookup: (oid: string) => GitObject | undefined, oid: string): string | null {
  let current: string | null = oid;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const obj = lookup(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTagTarget(obj.data);
      continue;
    }
    return null;
  }
  return null;
}

/** Is `ancestor` reachable from `tip` (i.e. is tip a descendant of ancestor)? */
export function isAncestor(lookup: (oid: string) => GitObject | undefined, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** The merge-base of two commits: the first common ancestor found walking both histories. */
export function mergeBase(lookup: (oid: string) => GitObject | undefined, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length) {
    const oid = stackA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stackA.push(parent);
  }
  const stackB = [b];
  const seenB = new Set<string>();
  while (stackB.length) {
    const oid = stackB.pop() as string;
    if (ancestorsA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stackB.push(parent);
  }
  return null;
}

/** Flatten a tree (by oid) into path -> {mode, oid}. */
export function flattenTree(lookup: (oid: string) => GitObject | undefined, treeOid: string): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = lookup(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build the tree for a flat path map, creating intermediate trees. Returns the root tree oid. */
export function buildTreeForFiles(
  lookup: (oid: string) => GitObject | undefined,
  store: (obj: GitObject) => string,
  baseTreeOid: string | null,
  files: Map<string, { mode: string; oid: string } | null>,
): string {
  // files: path -> entry (null = delete). Start from the base tree's flattened map.
  const flat = baseTreeOid ? flattenTree(lookup, baseTreeOid) : new Map<string, { mode: string; oid: string }>();
  for (const [path, entry] of files) {
    if (entry === null) flat.delete(path);
    else flat.set(path, entry);
  }
  // Group by directory, build bottom-up. Every ancestor directory gets an entry,
  // even one that holds only subdirectories.
  const byDir = new Map<string, Map<string, { mode: string; oid: string }>>();
  const ensureDir = (dir: string): void => {
    if (!byDir.has(dir)) byDir.set(dir, new Map());
  };
  ensureDir('');
  for (const [path, entry] of flat) {
    const slash = path.lastIndexOf('/');
    const dir = slash < 0 ? '' : path.slice(0, slash);
    const name = slash < 0 ? path : path.slice(slash + 1);
    let ancestor = dir;
    for (;;) {
      ensureDir(ancestor);
      if (ancestor === '') break;
      const cut = ancestor.lastIndexOf('/');
      ancestor = cut < 0 ? '' : ancestor.slice(0, cut);
    }
    (byDir.get(dir) as Map<string, { mode: string; oid: string }>).set(name, entry);
  }
  const depthOf = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
  const dirs = [...byDir.keys()].sort((a, b) => depthOf(b) - depthOf(a) || (a < b ? -1 : 1));
  const dirOid = new Map<string, string>();
  for (const dir of dirs) {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of byDir.get(dir) as Map<string, { mode: string; oid: string }>) {
      entries.push({ mode: entry.mode, name, oid: entry.oid });
    }
    // Child directories of this dir.
    for (const [childDir, childOid] of dirOid) {
      const slash = childDir.lastIndexOf('/');
      const parent = slash < 0 ? '' : childDir.slice(0, slash);
      if (parent === dir) {
        const name = slash < 0 ? childDir : childDir.slice(slash + 1);
        entries.push({ mode: '40000', name, oid: childOid });
      }
    }
    const data = buildTree(entries);
    dirOid.set(dir, store({ type: 'tree', data }));
  }
  return dirOid.get('') as string;
}

// ---------------------------------------------------------------------------------------------
// the store: repositories, issues, pull requests
// ---------------------------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
}
export interface IssueComment {
  id: number;
  body: string;
}
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  seq: number;
}
export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  seq: number;
}
export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  nextCommentId: number;
  seq: number;
  /** Memoised git-protocol replies (fetch results, ls-refs, advertisements).
   * Keys embed the repo's state, so an entry can never outlive the state it
   * was built from; the maps are bounded, oldest entry dropped first. */
  gitReplies: Map<string, Buffer>;
}

export interface Store {
  viewer: ScenarioUser;
  stranger: ScenarioUser;
  repos: Map<string, Repo>;
  nextRepoId: number;
  nextObjectId: number;
  reqCounter: number;
  trialNow: string;
  token: string;
}

export function createStore(): Store {
  const users = scenarioUsers();
  return {
    viewer: users.viewer,
    stranger: users.stranger,
    repos: new Map<string, Repo>(),
    nextRepoId: 1,
    nextObjectId: 1,
    reqCounter: 0,
    trialNow: process.env.MAKEFUN_TRIAL_NOW ?? '1970-01-01T00:00:00Z',
    token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
  };
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

export function createRepoRecord(store: Store, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: store.nextRepoId,
    name,
    owner: store.viewer.login,
    description,
    private: isPrivate,
    defaultBranch: 'main',
    objects: new Map<string, GitObject>(),
    refs: new Map<string, string>(),
    labels: new Map<string, Label>(),
    issues: [],
    pulls: [],
    nextNumber: 1,
    nextCommentId: 1,
    seq: store.nextRepoId,
    gitReplies: new Map<string, Buffer>(),
  };
  store.nextRepoId += 1;
  store.repos.set(repoKey(repo.owner, name), repo);
  return repo;
}

/** Opaque, stable Relay-style global id: base64 of "Kind:..." — never the plain number. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

/** The tip of a ref, or null. Resolves short branch names to refs/heads/<name>. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
  const asHead = `refs/heads/${ref}`;
  if (repo.refs.has(asHead)) return repo.refs.get(asHead) as string;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return null;
}

export function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}
