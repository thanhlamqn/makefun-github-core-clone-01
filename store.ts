// store.ts — the forge's whole state: one in-memory store, no disk, no outside service.
// Every surface (REST, GraphQL, MCP, git smart HTTP) reads and writes these same objects,
// so a repository created over MCP reads back over REST with the same ids.
//
// Identity: the suite's bearer token names one login. That login is fixed by the sealed
// kit's scenario (program/env/src/wire.ts: SCENARIO_SEED is a constant, so buildScenario()
// always yields viewer login "adaiversen"); the entry derives nothing from the clock or
// from randomness — timestamps come from a monotonic counter, so two runs behave identically.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

/** The login the trial's bearer token names (kit wire.ts, fixed scenario seed). */
export const TOKEN_OWNER_LOGIN = 'adaiversen';
export const TOKEN_OWNER_ID = 1000;
export const TOKEN_OWNER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

/** The bearer token the entry accepts; read from the trial environment. */
export const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Deterministic timestamps: a fixed base plus a monotonic counter (never the clock). */
const TIME_BASE_SEC = 1_700_000_000;
let timeSeq = 0;
export function nextTimestampSec(): number {
  timeSeq += 1;
  return TIME_BASE_SEC + timeSeq;
}
export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  /** The base tip at creation: the merge-base for conflict detection. */
  mergeBaseSha: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export class Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string = DEFAULT_BRANCH;
  readonly createdAt: string;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly comments = new Map<number, Comment[]>();
  readonly pulls = new Map<number, Pull>();
  /** One shared counter for issues and pull requests, as GitHub numbers them. */
  nextNumber = 1;
  nextCommentId = 1;
  /** Creation order, for stable list ordering. */
  readonly createdSeq: number;

  constructor(id: number, name: string, owner: string, description: string, isPrivate: boolean, createdSeq: number) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdSeq = createdSeq;
    this.createdAt = isoOf(TIME_BASE_SEC + createdSeq);
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  defaultTip(): string | undefined {
    return this.branchTip(this.defaultBranch);
  }

  /** Resolve a branch name, a full ref, or a commit sha to a commit oid. */
  resolveRef(ref: string): string | undefined {
    if (isObjectId(ref)) return this.objects.has(ref) ? ref : undefined;
    if (ref.startsWith('refs/')) return this.refs.get(ref);
    return this.branchTip(ref);
  }

  /** Walk a tip's first-parent chain (newest first), with a cap. */
  commitHistory(tip: string, cap = 1000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = [{ oid: tip, depth: 0 }];
    // Breadth-first by generation keeps newest-first order for linear histories.
    const byDepth = new Map<number, string[]>();
    while (queue.length > 0) {
      const { oid, depth } = queue.shift()!;
      if (seen.has(oid) || out.length + seen.size > cap) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      if (!byDepth.has(depth)) byDepth.set(depth, []);
      byDepth.get(depth)!.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: depth + 1 });
    }
    const depths = [...byDepth.keys()].sort((a, b) => a - b);
    for (const depth of depths) out.push(...byDepth.get(depth)!);
    return out.slice(0, cap);
  }

  /** Flatten a commit's tree to path -> {oid, mode}. */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  treeOfCommit(commitOid: string): string | undefined {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return undefined;
    return parseCommit(object.data).tree;
  }

  /** Diff two trees: added / removed / modified paths with line counts. */
  diffTrees(
    baseTree: string | undefined,
    headTree: string | undefined,
  ): Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }> {
    const base = baseTree === undefined ? new Map() : this.flattenTree(baseTree);
    const head = headTree === undefined ? new Map() : this.flattenTree(headTree);
    const out: Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }> = [];
    const lineCount = (oid: string): number => {
      const object = this.objects.get(oid);
      if (!object) return 0;
      const text = object.data.toString('utf8');
      if (text === '') return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    for (const [path, entry] of head) {
      const old = base.get(path);
      if (old === undefined) {
        out.push({ filename: path, status: 'added', additions: lineCount(entry.oid), deletions: 0 });
      } else if (old.oid !== entry.oid) {
        out.push({ filename: path, status: 'modified', additions: lineCount(entry.oid), deletions: lineCount(old.oid) });
      }
    }
    for (const [path, entry] of base) {
      if (!head.has(path)) out.push({ filename: path, status: 'removed', additions: 0, deletions: lineCount(entry.oid) });
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return out;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextIssueId = 100000;
  private nextCommentGlobalId = 200000;
  private nextPullId = 300000;
  private seq = 0;

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo = new Repo(this.nextRepoId, name, owner, description, isPrivate, this.nextSeq());
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  newIssueId(): number {
    this.nextIssueId += 1;
    return this.nextIssueId;
  }

  newCommentId(): number {
    this.nextCommentGlobalId += 1;
    return this.nextCommentGlobalId;
  }

  newPullId(): number {
    this.nextPullId += 1;
    return this.nextPullId;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const now = isoOf(nextTimestampSec());
    const issue: Issue = {
      id: this.newIssueId(),
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): Pull {
    const now = isoOf(nextTimestampSec());
    const pull: Pull = {
      id: this.newPullId(),
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      mergeBaseSha: baseSha,
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** Is `pull` mergeable? A conflict is a file changed differently on both sides of its merge-base. */
  pullMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    const baseTip = repo.branchTip(pull.baseRef);
    const headTip = repo.branchTip(pull.headRef);
    if (baseTip === undefined || headTip === undefined) return false;
    const baseTree = repo.treeOfCommit(baseTip);
    const headTree = repo.treeOfCommit(headTip);
    const mergeBaseTree = repo.treeOfCommit(pull.mergeBaseSha);
    if (baseTree === undefined || headTree === undefined || mergeBaseTree === undefined) return false;
    const baseSide = new Map(repo.diffTrees(mergeBaseTree, baseTree).map((d) => [d.filename, d]));
    const headSide = repo.diffTrees(mergeBaseTree, headTree);
    const baseFlat = repo.flattenTree(baseTree);
    const headFlat = repo.flattenTree(headTree);
    for (const change of headSide) {
      if (!baseSide.has(change.filename)) continue;
      const baseEntry = baseFlat.get(change.filename);
      const headEntry = headFlat.get(change.filename);
      if (baseEntry === undefined || headEntry === undefined) return false;
      if (baseEntry.oid !== headEntry.oid) return false;
    }
    return true;
  }

  /** Squash-merge an open pull request onto its base branch. Returns the merge commit sha, or null. */
  mergePull(repo: Repo, pull: Pull, message?: string): string | null {
    if (pull.state !== 'open') return null;
    if (!this.pullMergeable(repo, pull)) return null;
    const baseTip = repo.branchTip(pull.baseRef);
    const headTip = repo.branchTip(pull.headRef);
    if (baseTip === undefined || headTip === undefined) return null;
    const headTree = repo.treeOfCommit(headTip);
    if (headTree === undefined) return null;
    const stamp = nextTimestampSec();
    const who = `${TOKEN_OWNER_LOGIN} <${TOKEN_OWNER_EMAIL}>`;
    const commitData = buildCommit({
      tree: headTree,
      parents: [baseTip],
      message: message ?? `${pull.title} (#${pull.number})\n`,
      author: who,
      committer: who,
      timestamp: stamp,
    });
    const sha = repo.putObject('commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoOf(stamp);
    pull.mergeCommitSha = sha;
    pull.updatedAt = isoOf(stamp);
    return sha;
  }

  // ------------------------------------------------------------ contents commits

  /** Replace one path (or delete it with null) inside a tree, rebuilding parents. */
  private updateTree(repo: Repo, treeOid: string | undefined, segments: string[], blobOid: string | null): string {
    if (segments.length === 0) throw new Error('empty path');
    const name = segments[0]!;
    if (segments.length === 1) {
      const entries: TreeEntry[] = treeOid === undefined ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
      const kept = entries.filter((entry) => entry.name !== name);
      if (blobOid !== null) kept.push({ mode: '100644', name, oid: blobOid });
      return repo.putObject('tree', buildTree(kept));
    }
    const entries: TreeEntry[] = treeOid === undefined ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
    const child = entries.find((entry) => entry.name === name && entry.mode === '40000');
    const childTree = this.updateTree(repo, child?.oid, segments.slice(1), blobOid);
    const kept = entries.filter((entry) => entry.name !== name);
    // Drop an emptied directory, as git does for a removed last file.
    if (parseTree(repo.objects.get(childTree)?.data ?? Buffer.alloc(0)).length > 0) {
      kept.push({ mode: '40000', name, oid: childTree });
    }
    return repo.putObject('tree', buildTree(kept));
  }

  /**
   * Commit one file change on `branch` (creating the branch from the default tip when it
   * does not exist yet). Returns the commit sha and the new blob sha.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitSha: string; blobSha: string | null } {
    let tip = repo.branchTip(branch);
    if (tip === undefined && branch !== repo.defaultBranch) {
      tip = repo.defaultTip();
      if (tip !== undefined) repo.refs.set(`refs/heads/${branch}`, tip);
    }
    const parentTree = tip === undefined ? undefined : repo.treeOfCommit(tip);
    const segments = path.split('/').filter((part) => part !== '');
    let blobSha: string | null = null;
    if (content !== null) blobSha = repo.putObject('blob', content);
    const newTree = this.updateTree(repo, parentTree, segments, blobSha);
    const stamp = nextTimestampSec();
    const who = `${TOKEN_OWNER_LOGIN} <${TOKEN_OWNER_EMAIL}>`;
    const commitData = buildCommit({
      tree: newTree,
      parents: tip === undefined ? [] : [tip],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: who,
      committer: who,
      timestamp: stamp,
    });
    const commitSha = repo.putObject('commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }

  /** Read a file (or directory) at a ref. Returns null when the path does not exist. */
  readPath(
    repo: Repo,
    ref: string | undefined,
    path: string,
  ): { kind: 'file'; blobOid: string; data: Buffer } | { kind: 'dir'; entries: TreeEntry[] } | null {
    const tip = ref === undefined ? repo.defaultTip() : repo.resolveRef(ref);
    if (tip === undefined) return null;
    const treeOid = repo.treeOfCommit(tip);
    if (treeOid === undefined) return null;
    if (path === '' || path === '/') {
      return { kind: 'dir', entries: parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)) };
    }
    const segments = path.split('/').filter((part) => part !== '');
    let currentTree = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const entries = parseTree(repo.objects.get(currentTree)?.data ?? Buffer.alloc(0));
      const entry = entries.find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      const isLast = index === segments.length - 1;
      if (entry.mode === '40000') {
        if (isLast) return { kind: 'dir', entries: parseTree(repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0)) };
        currentTree = entry.oid;
      } else {
        if (!isLast) return null;
        const object = repo.objects.get(entry.oid);
        if (!object) return null;
        return { kind: 'file', blobOid: entry.oid, data: object.data };
      }
    }
    return null;
  }
}

export const store = new Store();

/** Opaque Relay-style global ids: base64 over a typed payload, never the bare number. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export { ZERO_OID, collectReachable, isAncestor };
