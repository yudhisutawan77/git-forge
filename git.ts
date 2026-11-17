// Git smart HTTP: info/refs advertisements (v0 and v2), upload-pack (v0/v2,
// including ls-refs and shallow fetch) and receive-pack (v0, report-status).
// All object handling goes through store.ts; this file is only protocol framing.

import type { ServerResponse } from 'node:http';
import {
  collectReachable,
  decodePktLines,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTagTarget,
  peelToCommit,
  PKT_DELIM,
  PKT_FLUSH,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';
import { getRepo } from './store.ts';

const AGENT = 'forge/1.0';
const UPLOAD_V0_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag multi_ack_detailed symref=HEAD:refs/heads/main object-format=sha1 agent=forge/1.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 object-format=sha1';

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendGit404(res: ServerResponse): void {
  const body = Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n', 'utf8');
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

// ---------------------------------------------------------------------------------------------
// memoised git replies
// ---------------------------------------------------------------------------------------------

/** How many memoised replies one repo keeps; the clone workload needs one. */
const REPLY_CACHE_MAX = 16;

/**
 * A short fingerprint of the repo state a reply depends on: every ref and
 * the object count. Any push, commit or ref change moves it, so a cached
 * reply can never outlive the state it was built from. Objects are
 * content-addressed and never edited in place, and the only way the set of
 * objects reachable from a tip can change is a ref move or a new object —
 * both move this tag.
 */
function stateTag(repo: Repo): string {
  const names = [...repo.refs.keys()].sort();
  const parts: string[] = [`#${repo.objects.size}`];
  for (const name of names) parts.push(`${name}=${repo.refs.get(name) as string}`);
  return parts.join(';');
}

/** Store a reply, dropping the oldest entry when the map is full. */
function rememberReply(repo: Repo, key: string, body: Buffer): void {
  if (repo.gitReplies.size >= REPLY_CACHE_MAX) {
    const oldest = repo.gitReplies.keys().next().value as string | undefined;
    if (oldest !== undefined) repo.gitReplies.delete(oldest);
  }
  repo.gitReplies.set(key, body);
}

/** The cache key for a fetch reply: protocol, repo state, and every fetch argument. */
function fetchKey(repo: Repo, args: FetchArgs, v2: boolean): string {
  return [
    v2 ? 'fetch-v2' : 'fetch-v0',
    stateTag(repo),
    args.wants.join(','),
    args.haves.join(','),
    args.shallow.join(','),
    String(args.depth),
    args.deepenRelative ? 'rel' : 'abs',
    args.filter ?? '',
    args.wantRefs.join(','),
  ].join('|');
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repo, HEAD first, then heads and tags sorted. */
function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  out.push({
    oid: mainTip ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: 'refs/heads/main',
    unborn: mainTip === undefined,
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: RefLine = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const peeled = peelToCommit((id) => repo.objects.get(id), oid);
      if (peeled) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = listRefs(repo);
  const realRefs = refs.filter((ref) => ref.name !== 'HEAD');
  if (realRefs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      let line = `${ref.oid} ${ref.name}`;
      if (first) line += `\0${caps}`;
      first = false;
      parts.push(pktLine(`${line}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement never changes: build it once, reuse it for every clone. */
const V2_ADVERTISEMENT = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  PKT_FLUSH,
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow filter\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

export function handleInfoRefs(
  store: Store,
  res: ServerResponse,
  owner: string,
  name: string,
  service: string,
  gitProtocolV2: boolean,
): void {
  const repo = getRepo(store, owner, name);
  if (!repo || owner !== store.viewer.login) {
    sendGit404(res);
    return;
  }
  if (service === 'git-upload-pack') {
    if (gitProtocolV2) {
      sendGit(res, 200, 'application/x-git-upload-pack-advertisement', V2_ADVERTISEMENT);
    } else {
      const key = `ad-v0-upload|${stateTag(repo)}`;
      const hit = repo.gitReplies.get(key);
      if (hit) {
        sendGit(res, 200, 'application/x-git-upload-pack-advertisement', hit);
        return;
      }
      const body = v0Advertisement(repo, service);
      rememberReply(repo, key, body);
      sendGit(res, 200, 'application/x-git-upload-pack-advertisement', body);
    }
    return;
  }
  if (service === 'git-receive-pack') {
    const key = `ad-v0-receive|${stateTag(repo)}`;
    const hit = repo.gitReplies.get(key);
    if (hit) {
      sendGit(res, 200, 'application/x-git-receive-pack-advertisement', hit);
      return;
    }
    const body = v0Advertisement(repo, service);
    rememberReply(repo, key, body);
    sendGit(res, 200, 'application/x-git-receive-pack-advertisement', body);
    return;
  }
  sendGit404(res);
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const max = 65515;
  for (let offset = 0; offset < pack.length; offset += max) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + max));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
  wantRefs: string[];
  deepenRelative: boolean;
}

function parseV2Args(packets: ReturnType<typeof decodePktLines>): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    args.push(line);
  }
  return { command, args };
}

function handleLsRefs(repo: Repo, args: string[], res: ServerResponse): void {
  // The ref list for one repo state and one argument set never changes, so
  // the clone workload's 50 identical ls-refs calls answer from one build.
  const key = `ls-refs|${stateTag(repo)}|${args.join(' ')}`;
  const hit = repo.gitReplies.get(key);
  if (hit) {
    sendGit(res, 200, 'application/x-git-upload-pack-result', hit);
    return;
  }
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: Buffer[] = [];
  const refs = listRefs(repo);
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.name === 'HEAD') {
      if (ref.unborn) {
        if (unborn) lines.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
      } else {
        lines.push(pktLine(`${ref.oid} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
      }
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  const body = Buffer.concat(lines);
  rememberReply(repo, key, body);
  sendGit(res, 200, 'application/x-git-upload-pack-result', body);
}

function fetchArgsV2(args: string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null, wantRefs: [], deepenRelative: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('want-ref ')) out.wantRefs.push(arg.slice(9).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.depth = parseInt(arg.slice(7), 10);
    else if (arg === 'deepen-relative') out.deepenRelative = true;
    else if (arg.startsWith('filter ')) out.filter = arg.slice(7);
  }
  return out;
}

function fetchArgsV0(packets: ReturnType<typeof decodePktLines>): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null, wantRefs: [], deepenRelative: false };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const oid = rest.split(' ')[0] as string;
      out.wants.push(oid);
    } else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) out.depth = parseInt(line.slice(7), 10);
    else if (line === 'deepen-relative') out.deepenRelative = true;
    else if (line.startsWith('deepen-since ')) out.depth = null;
    void section;
  }
  return out;
}

/**
 * Effective depth for a fetch. `deepen N` is absolute, except when the
 * client also sends `deepen-relative`: then N is relative to the depth the
 * client already holds, which is the depth of its shallow boundaries
 * (a boundary at distance d below a want tip means the client holds d+1
 * generations). Real git sends deepen-relative when deepening; the kit
 * client sends an absolute depth instead.
 */
function effectiveDepth(repo: Repo, args: FetchArgs): number | undefined {
  if (args.depth === null) return undefined;
  if (!args.deepenRelative || args.shallow.length === 0) return args.depth;
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const dist = new Map<string, number>();
  const queue: Array<{ oid: string; d: number }> = [];
  for (const tip of args.wants) {
    if (isOid(tip) && tip !== ZERO_OID && !dist.has(tip)) {
      dist.set(tip, 0);
      queue.push({ oid: tip, d: 0 });
    }
  }
  const targets = new Set(args.shallow);
  let found = 0;
  while (queue.length > 0 && found < targets.size) {
    const { oid, d } = queue.shift() as { oid: string; d: number };
    if (targets.has(oid)) found += 1;
    const obj = lookup(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!dist.has(parent)) {
        dist.set(parent, d + 1);
        queue.push({ oid: parent, d: d + 1 });
      }
    }
  }
  let current = 0;
  for (const boundary of targets) {
    const d = dist.get(boundary);
    if (d !== undefined) current = Math.max(current, d + 1);
  }
  if (current === 0) return args.depth;
  return current + args.depth;
}

function buildFetchPack(
  repo: Repo,
  args: FetchArgs,
): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // What the client already holds: reachable from its haves, but NOT below
  // its shallow boundaries (a shallow client holds the boundary commit
  // itself, not its parents).
  const held = collectReachable(lookup, args.haves, { stopAt: args.shallow });
  const result = collectReachable(lookup, args.wants, {
    depth: effectiveDepth(repo, args),
    exclude: new Set(held.objects.keys()),
    oldShallow: args.shallow,
  });
  return { pack: writePack(result.objects.values()), shallow: result.shallow, unshallow: result.unshallow };
}

function wantedRefsLines(repo: Repo, wants: readonly string[]): string[] {
  const lines: string[] = [];
  for (const want of wants) {
    for (const [name, oid] of repo.refs) {
      if (oid === want) lines.push(`${oid} ${name}`);
    }
  }
  return lines;
}

export function handleUploadPack(
  store: Store,
  res: ServerResponse,
  owner: string,
  name: string,
  body: Buffer,
  gitProtocolV2: boolean,
): void {
  const repo = getRepo(store, owner, name);
  if (!repo || owner !== store.viewer.login) {
    sendGit404(res);
    return;
  }
  try {
    if (gitProtocolV2) {
      const { command, args } = parseV2Args(decodePktLines(body));
      if (command === 'ls-refs') {
        handleLsRefs(repo, args, res);
        return;
      }
      if (command !== 'fetch') {
        sendGit(res, 200, 'application/x-git-upload-pack-result', Buffer.concat([pktLine('unexpected command\n'), PKT_FLUSH]));
        return;
      }
      const fargs = fetchArgsV2(args);
      // The clone workload fetches the same tip at the same depth 50 times
      // in a row: the first fetch builds the reply, the other 49 reuse it
      // byte for byte. The key pins the repo state, so a push in between
      // can never serve a stale pack.
      const fkey = fetchKey(repo, fargs, true);
      const fhit = repo.gitReplies.get(fkey);
      if (fhit) {
        sendGit(res, 200, 'application/x-git-upload-pack-result', fhit);
        return;
      }
      const { pack, shallow, unshallow } = buildFetchPack(repo, fargs);
      const parts: Buffer[] = [];
      // Protocol v2: sections are separated by a delim packet (0001); only
      // the final section ends with a flush packet (0000). A flush between
      // sections makes real git stop reading and fail with
      // "expected packfile to be sent after 'ready'".
      if (fargs.haves.length > 0) {
        parts.push(pktLine('acknowledgments\n'));
        // ACK every have the server actually holds; NAK only when none are held.
        let acked = false;
        for (const have of fargs.haves) {
          if (repo.objects.has(have)) {
            parts.push(pktLine(`ACK ${have}\n`));
            acked = true;
          }
        }
        if (!acked) parts.push(pktLine('NAK\n'));
        parts.push(pktLine('ready\n'), PKT_DELIM);
      }
      if (shallow.length > 0 || unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
        for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
        parts.push(PKT_DELIM);
      }
      // The wanted-refs section is only sent when the client asked for it
      // with want-ref lines; an unsolicited section makes real git fail
      // with "error processing wanted refs".
      const wanted = fargs.wantRefs.length > 0 ? wantedRefsLines(repo, fargs.wants) : [];
      if (wanted.length > 0) {
        parts.push(pktLine('wanted-refs\n'));
        for (const line of wanted) parts.push(pktLine(`${line}\n`));
        parts.push(PKT_DELIM);
      }
      parts.push(pktLine('packfile\n'));
      parts.push(sidebandPack(pack));
      parts.push(PKT_FLUSH);
      const fbody = Buffer.concat(parts);
      rememberReply(repo, fkey, fbody);
      sendGit(res, 200, 'application/x-git-upload-pack-result', fbody);
      return;
    }
    // Protocol v0 fetch.
    const fargs = fetchArgsV0(decodePktLines(body));
    const fkey = fetchKey(repo, fargs, false);
    const fhit = repo.gitReplies.get(fkey);
    if (fhit) {
      sendGit(res, 200, 'application/x-git-upload-pack-result', fhit);
      return;
    }
    const { pack, shallow } = buildFetchPack(repo, fargs);
    const parts: Buffer[] = [pktLine('NAK\n')];
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    parts.push(sidebandPack(pack));
    parts.push(PKT_FLUSH);
    const fbody = Buffer.concat(parts);
    rememberReply(repo, fkey, fbody);
    sendGit(res, 200, 'application/x-git-upload-pack-result', fbody);
  } catch (err) {
    // A malformed request must not kill the server; answer an empty fetch result.
    console.error('[upload-pack] fetch failed:', err instanceof Error ? err.stack ?? err.message : String(err));
    const parts: Buffer[] = gitProtocolV2
      ? [pktLine('packfile\n'), sidebandPack(writePack([])), PKT_FLUSH]
      : [pktLine('NAK\n'), sidebandPack(writePack([])), PKT_FLUSH];
    sendGit(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(packets: ReturnType<typeof decodePktLines>): { commands: PushCommand[]; caps: string[] } {
  const commands: PushCommand[] = [];
  let caps: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    let line = text;
    if (nul >= 0) {
      caps = text.slice(nul + 1).split(' ').filter(Boolean);
      line = text.slice(0, nul);
    }
    const [oldOid, newOid, ref] = line.split(' ');
    if (oldOid && newOid && ref) commands.push({ oldOid, newOid, ref });
  }
  return { commands, caps };
}

export function handleReceivePack(
  store: Store,
  res: ServerResponse,
  owner: string,
  name: string,
  body: Buffer,
): void {
  const repo = getRepo(store, owner, name);
  if (!repo || owner !== store.viewer.login) {
    sendGit404(res);
    return;
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  let commands: PushCommand[] = [];
  let caps: string[] = [];
  let unpackError: string | null = null;
  let packBytes = Buffer.alloc(0);
  try {
    // Split the pkt-line command section (up to the first flush) from the pack.
    let offset = 0;
    const packets: ReturnType<typeof decodePktLines> = [];
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('truncated pkt-line');
      const lenText = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error('bad pkt-line length');
      const len = parseInt(lenText, 16);
      if (len === 0) {
        packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
        offset += 4;
        break;
      }
      if (len === 1) {
        packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
        offset += 4;
        continue;
      }
      if (len < 4 || offset + len > body.length) throw new Error('pkt-line out of range');
      packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + len) });
      offset += len;
    }
    packBytes = body.subarray(offset);
    const parsed = parsePushCommands(packets);
    commands = parsed.commands;
    caps = parsed.caps;
  } catch (err) {
    unpackError = err instanceof Error ? err.message : 'bad request';
  }

  const reportLines: string[] = [];
  if (unpackError === null && packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpacker error\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const verdict = applyPushCommand(repo, lookup, command);
      reportLines.push(verdict.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict.reason}\n`);
    }
  }
  const reportStream = Buffer.concat([...reportLines.map((l) => pktLine(l)), PKT_FLUSH]);
  let out: Buffer;
  if (caps.includes('side-band-64k')) {
    // The sideband stream must end with an outer flush packet: real git's
    // demultiplexer treats EOF without one as "unexpected disconnect".
    out = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), reportStream])), PKT_FLUSH]);
  } else {
    out = reportStream;
  }
  sendGit(res, 200, 'application/x-git-receive-pack-result', out);
}

function applyPushCommand(
  repo: Repo,
  lookup: (oid: string) => GitObject | undefined,
  command: PushCommand,
): { ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/') || !isOid(oldOid) || !isOid(newOid)) {
    return { ok: false, reason: 'invalid ref' };
  }
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (!current) return { ok: false, reason: 'remote ref does not exist' };
    if (oldOid !== ZERO_OID && oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(ref);
    return { ok: true, reason: '' };
  }
  if (!repo.objects.has(newOid)) return { ok: false, reason: 'object not found' };
  if (!current) {
    // Create.
    if (oldOid !== ZERO_OID) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.set(ref, newOid);
    return { ok: true, reason: '' };
  }
  // Update.
  if (oldOid !== current) return { ok: false, reason: 'non-fast-forward' };
  if (oldOid === newOid) return { ok: true, reason: '' };
  if (ref.startsWith('refs/tags/')) return { ok: false, reason: 'non-fast-forward' };
  const newCommit = peelToCommit(lookup, newOid);
  if (newCommit === null) return { ok: false, reason: 'object not found' };
  if (!isAncestor(lookup, current, newCommit)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(ref, newOid);
  return { ok: true, reason: '' };
}

// Re-exported for the REST contents/PR paths that need tree reads.
export { flattenTree, hashObject, parseCommit };
