// gitproto.ts — git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 upload-pack,
// and v0 receive-pack. No git binary: objects, packs and the wire framing are built here
// from gitobj.ts. Packs are always sent whole (no deltas); incoming packs may carry deltas.

import {
  ZERO_OID,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { store, type Repo } from './store.ts';

// ---------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a pkt-line stream; trailing garbage is ignored, a bad length throws. */
export function decodePktLines(bytes: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const lenText = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
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
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > bytes.length) break;
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return packets;
}

function pktLinesText(packets: PktPacket[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
}

// ---------------------------------------------------------------- ref helpers

const AGENT = 'forge/1.0';

interface RefInfo {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function sortedRefs(repo: Repo): RefInfo[] {
  const out: RefInfo[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const info: RefInfo = { name, oid };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      try {
        info.peeled = parseTag(object.data).object;
      } catch {
        // not a parseable tag; leave unpeeled
      }
    }
    out.push(info);
  }
  const headTip = repo.defaultTip();
  out.unshift({
    name: 'HEAD',
    oid: headTip ?? ZERO_OID,
    symrefTarget: `refs/heads/${repo.defaultBranch}`,
    unborn: headTip === undefined,
  });
  return out;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const refs = sortedRefs(repo);
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const realRefs = refs.filter((ref) => ref.name !== 'HEAD');
  if (realRefs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = refs.find((ref) => ref.name === 'HEAD')!;
    parts.push(pktLine(`${head.oid} HEAD\0${caps}\n`));
    for (const ref of realRefs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
  ];
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    ...lines.map((line) => pktLine(line)),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
}

interface FetchResult {
  /** Objects to send, in a stable order. */
  objects: GitObject[];
  /** New shallow boundary commits (at exactly the requested depth). */
  shallow: string[];
  /** Old boundaries that stopped being shallow. */
  unshallow: string[];
}

/**
 * Which objects a fetch sends. Depth limits commit generations from the wants
 * (depth 1 = the wanted commits only); without a depth the whole reachable closure
 * minus what the haves already hold is sent. A have that is itself a shallow
 * boundary only excuses its own commit and tree — never its parents.
 */
export function planFetch(repo: Repo, plan: FetchPlan): FetchResult {
  const lookup = repo.lookup;
  // Resolve wanted commits (tags resolve to their target commit).
  const wantedCommits = new Set<string>();
  const wantedTags = new Set<string>();
  for (const want of plan.wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      wantedTags.add(want);
      try {
        wantedCommits.add(parseTag(object.data).object);
      } catch {
        // ignore
      }
    } else if (object.type === 'commit') {
      wantedCommits.add(want);
    }
  }

  // Commits to include.
  const includedCommits = new Set<string>();
  const commitDepth = new Map<string, number>();
  if (plan.depth !== null) {
    const queue: Array<{ oid: string; depth: number }> = [...wantedCommits].map((oid) => ({ oid, depth: 1 }));
    while (queue.length > 0) {
      const { oid, depth } = queue.shift()!;
      if (depth > plan.depth) continue;
      if (commitDepth.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      commitDepth.set(oid, depth);
      includedCommits.add(oid);
      if (depth < plan.depth) {
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: depth + 1 });
      }
    }
  } else {
    for (const oid of collectReachable(wantedCommits, lookup, { allowMissing: true })) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'commit') {
        includedCommits.add(oid);
        commitDepth.set(oid, -1);
      }
    }
  }

  // What the client already holds.
  const held = new Set<string>();
  const boundarySet = new Set(plan.shallowBoundaries);
  for (const have of plan.haves) {
    if (boundarySet.has(have)) {
      held.add(have);
      const tree = repo.treeOfCommit(have);
      if (tree !== undefined) {
        for (const oid of collectReachable([tree], lookup, { allowMissing: true })) held.add(oid);
      }
    } else {
      for (const oid of collectReachable([have], lookup, { allowMissing: true })) held.add(oid);
    }
  }

  // Objects to send: wanted tags, included commits and their tree closures, minus held.
  const send = new Set<string>();
  for (const tag of wantedTags) if (!held.has(tag)) send.add(tag);
  for (const commit of includedCommits) {
    if (held.has(commit)) continue;
    send.add(commit);
    const tree = repo.treeOfCommit(commit);
    if (tree === undefined) continue;
    for (const oid of collectReachable([tree], lookup, { allowMissing: true })) {
      if (!held.has(oid)) send.add(oid);
    }
  }
  // A held blob shared with a new tree is fine to skip: the client already has it.
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }

  // Shallow boundaries: included commits at exactly the requested depth.
  const shallow: string[] = [];
  if (plan.depth !== null) {
    for (const [oid, depth] of commitDepth) {
      if (depth === plan.depth) shallow.push(oid);
    }
    shallow.sort();
  }
  // Unshallow: an old boundary that is now included with a parent included too.
  const unshallow: string[] = [];
  for (const boundary of plan.shallowBoundaries) {
    if (!includedCommits.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => includedCommits.has(parent))) unshallow.push(boundary);
  }
  unshallow.sort();
  return { objects, shallow, unshallow };
}

/** Split bytes into sideband band-1 pkt-lines (32 KiB chunks). */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 32768) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 32768));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v2 ls-refs

export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const refs = sortedRefs(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.name === 'HEAD' && ref.unborn === true && !unborn) continue;
    if (ref.unborn === true) {
      parts.push(pktLine(`unborn HEAD${symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === 'HEAD' && symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v2 fetch

export function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) continue;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
  }
  const result = planFetch(repo, { wants, haves, shallowBoundaries, depth });
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM);
  }
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (result.objects.length > 0) {
    const pack = writePack(result.objects);
    parts.push(pktLine('packfile\n'), sidebandPack(pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v0 fetch

export function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
  }
  const result = planFetch(repo, { wants, haves, shallowBoundaries, depth });
  // git's upload-pack answers the negotiation with NAK (or an ACK) before any pack,
  // even when the client sent no haves: fetch-pack expects ACK/NAK first.
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (result.objects.length > 0) {
    const pack = writePack(result.objects);
    parts.push(sidebandPack(pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export interface PushReportEntry {
  ref: string;
  ok: boolean;
  reason: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): { report: PushReportEntry[]; unpackOk: boolean; unpackDetail: string } {
  const packets = decodePktLines(body);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let packStart = body.length;
  let seenFlush = false;
  let offset = 0;
  // Walk the raw stream: command pkt-lines up to the first flush, then the pack.
  while (offset + 4 <= body.length) {
    const lenText = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      offset += 4;
      seenFlush = true;
      break;
    }
    if (len < 4 || offset + len > body.length) break;
    const payload = body.subarray(offset + 4, offset + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const line = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length >= 3 && isObjectId(parts[0]!) && isObjectId(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    offset += len;
  }
  if (seenFlush) packStart = offset;
  void packets;

  const report: PushReportEntry[] = [];
  // Unpack the pack (if any) before judging the refs, as real git does.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, object] of objects) {
        if (hashObject(object.type, object.data) !== oid) throw new Error('object id mismatch in pack');
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  for (const command of commands) {
    if (!unpackOk) {
      report.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        report.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        report.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        report.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined) {
      report.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      continue;
    }
    if (command.oldOid !== current) {
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const newObject = repo.objects.get(command.newOid)!;
    if (newObject.type === 'commit') {
      if (!isAncestor(repo.lookup, command.oldOid, command.newOid)) {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    } else if (command.newOid !== command.oldOid) {
      // A non-commit ref update to a different object is not a fast-forward.
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { report, unpackOk, unpackDetail };
}

export function renderPushReport(result: { report: PushReportEntry[]; unpackOk: boolean; unpackDetail: string }): Buffer {
  const inner: Buffer[] = [];
  inner.push(pktLine(`unpack ${result.unpackOk ? 'ok' : result.unpackDetail}\n`));
  for (const entry of result.report) {
    inner.push(pktLine(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`));
  }
  inner.push(PKT_FLUSH);
  const innerBytes = Buffer.concat(inner);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < innerBytes.length; offset += 32768) {
    const chunk = innerBytes.subarray(offset, Math.min(innerBytes.length, offset + 32768));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- advertisements

export function advertisementFor(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', wantsV2: boolean): Buffer {
  if (service === 'git-upload-pack' && wantsV2) return v2Advertisement();
  return v0Advertisement(repo, service);
}

export { verifyPackChecksum, store };
