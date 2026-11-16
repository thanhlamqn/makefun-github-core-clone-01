// app.ts — the forge's HTTP server: REST v3, git smart HTTP, GraphQL, MCP.
// Node stdlib only (node:http). One in-memory store shared by every surface.
// Every REST reply is JSON with a non-empty X-GitHub-Request-Id; errors carry a
// JSON body with a string message; unknown routes are 404 JSON, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { decodePktLines } from './gitproto.ts';
import {
  advertisementFor,
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
  renderPushReport,
} from './gitproto.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  DEFAULT_BRANCH,
  SHOP_TOKEN,
  TOKEN_OWNER_ID,
  TOKEN_OWNER_LOGIN,
  TOKEN_OWNER_EMAIL,
  isoOf,
  nextTimestampSec,
  store,
} from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';
import { parseCommit } from './gitobj.ts';

let requestSeq = 0;
const nextRequestId = (): string => {
  requestSeq += 1;
  return `req-${requestSeq}`;
};

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': body.length,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false; message: string } {
  const text = body.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: 'Problems parsing JSON' };
  }
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

function queryParams(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) out[key] = value;
  return out;
}

function pageParams(query: Record<string, string>): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.per_page ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { items: T[]; hasNext: boolean; lastPage: number } {
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage) as T[], hasNext: page < lastPage, lastPage };
}

function linkHeader(req: IncomingMessage, path: string, query: Record<string, string>, page: number, perPage: number, lastPage: number): string {
  const base = `http://${req.headers.host ?? 'localhost'}${path}`;
  const withPage = (target: number): string =>
    `<${base}?${new URLSearchParams({ ...query, page: String(target), per_page: String(perPage) }).toString()}>`;
  const links: string[] = [];
  if (page < lastPage) links.push(`${withPage(page + 1)}; rel="next"`);
  links.push(`${withPage(lastPage)}; rel="last"`);
  if (page > 1) links.push(`${withPage(1)}; rel="first"`);
  if (page > 1) links.push(`${withPage(page - 1)}; rel="prev"`);
  return links.join(', ');
}

// ---------------------------------------------------------------- views

function userView(): Record<string, unknown> {
  return {
    login: TOKEN_OWNER_LOGIN,
    id: TOKEN_OWNER_ID,
    node_id: Buffer.from(`User:${TOKEN_OWNER_ID}`, 'utf8').toString('base64'),
    name: 'ada iversen',
    email: TOKEN_OWNER_EMAIL,
    type: 'User',
    site_admin: false,
  };
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === TOKEN_OWNER_LOGIN ? TOKEN_OWNER_ID : 1002, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    html_url: `https://github.com/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    homepage: null,
    language: null,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({
      name,
      color: repo.labels.get(name)?.color ?? '000000',
      description: repo.labels.get(name)?.description ?? '',
      default: false,
    })),
    user: { login: TOKEN_OWNER_LOGIN, id: TOKEN_OWNER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: (repo.comments.get(issue.number) ?? []).length,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
  };
}

function commentView(repo: Repo, number: number, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.id}:${number}:${comment.id}`, 'utf8').toString('base64'),
    body: comment.body,
    user: { login: TOKEN_OWNER_LOGIN, id: TOKEN_OWNER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.fullName}/issues/${number}#issuecomment-${comment.id}`,
  };
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: TOKEN_OWNER_LOGIN, id: TOKEN_OWNER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
  };
}

function commitView(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const ident = (who: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) \+0000$/.exec(who);
    if (match === null) return { name: who, email: '', date: repo.createdAt };
    return { name: match[1]!, email: match[2]!, date: isoOf(Number(match[3])) };
  };
  const author = ident(commit.author);
  const committer = ident(commit.committer);
  // The stored commit message ends with a newline, as git writes it; the REST API
  // reports it without the trailing newline, matching the message the client sent.
  const message = commit.message.replace(/\n+$/, '');
  return {
    sha,
    commit: {
      message,
      author,
      committer,
      tree: { sha: commit.tree },
    },
    author: { login: TOKEN_OWNER_LOGIN, id: TOKEN_OWNER_ID, type: 'User' },
    committer: { login: TOKEN_OWNER_LOGIN, id: TOKEN_OWNER_ID, type: 'User' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `https://api.github.com/repos/${repo.fullName}/commits/${sha}`,
  };
}

/** A repo the request names, or the 404 the caller should send. */
function findRepo(res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** Is the request's bearer token valid? Sends 401 when it is not. */
function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (isAuthorized(req)) return true;
  sendError(res, 401, 'Requires authentication');
  return false;
}

// ---------------------------------------------------------------- git endpoints

function isValidPktStream(body: Buffer): boolean {
  if (body.length === 0) return false;
  let offset = 0;
  while (offset + 4 <= body.length) {
    const lenText = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) return false;
    const len = parseInt(lenText, 16);
    if (len === 0 || len === 1 || len === 2) {
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > body.length) return false;
    offset += len;
  }
  return offset === body.length;
}

/**
 * Validate only the command section of a receive-pack request: pkt-lines up to and
 * including the first flush. What follows the flush is the pack itself (raw binary,
 * not pkt-lines), so it must not be validated as such.
 */
function hasValidPktPrefix(body: Buffer): boolean {
  if (body.length === 0) return false;
  let offset = 0;
  while (offset + 4 <= body.length) {
    const lenText = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) return false;
    const len = parseInt(lenText, 16);
    if (len === 0 || len === 1 || len === 2) return true;
    if (len < 4 || offset + len > body.length) return false;
    offset += len;
  }
  return false;
}

function handleGitInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, name: string, url: URL): void {
  const repo = findRepo(res, owner, name);
  if (repo === null) return;
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(res, 400, 'service parameter is required');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = advertisementFor(repo, service, wantsV2);
  sendBuffer(res, 200, body, `application/x-${service}-advertisement`);
}

function handleGitUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = findRepo(res, owner, name);
  if (repo === null) return;
  if (!isValidPktStream(body)) {
    sendError(res, 400, 'malformed pkt-line stream');
    return;
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const packets = decodePktLines(body);
  const firstLine = packets.find((packet) => packet.kind === 'data')?.payload.toString('utf8').replace(/\n$/, '') ?? '';
  let out: Buffer;
  if (wantsV2) {
    if (firstLine.startsWith('command=ls-refs')) out = handleLsRefs(repo, body);
    else if (firstLine.startsWith('command=fetch')) out = handleFetchV2(repo, body);
    else {
      sendError(res, 400, 'unknown git protocol v2 command');
      return;
    }
  } else {
    out = handleFetchV0(repo, body);
  }
  sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
}

function handleGitReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = findRepo(res, owner, name);
  if (repo === null) return;
  if (!hasValidPktPrefix(body)) {
    sendError(res, 400, 'malformed pkt-line stream');
    return;
  }
  const outcome = handleReceivePack(repo, body);
  sendBuffer(res, 200, renderPushReport(outcome), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------- REST handlers

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const query = queryParams(url);
  const path = url.pathname;
  const segments = path.split('/').filter((part) => part !== '');

  if (!requireAuth(req, res)) return;

  // GET /api/v3/
  if (method === 'GET' && path === '/api/v3/') {
    sendJson(res, 200, {}, { 'x-oauth-scopes': 'repo', 'x-accepted-oauth-scopes': 'repo' });
    return;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      api: ['https://api.github.com'],
    });
    return;
  }
  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(res, 200, userView());
    return;
  }

  // /api/v3/user/repos
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user') {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pageParams(query);
      const repos = store.listRepos(TOKEN_OWNER_LOGIN);
      const { items, hasNext, lastPage } = paginate(repos, page, perPage);
      const extra: Record<string, string> = {};
      if (hasNext || page > 1) extra.link = linkHeader(req, path, query, page, perPage, lastPage);
      sendJson(res, 200, items.map(repoView), extra);
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message);
        return;
      }
      const input = (parsed.value ?? {}) as Record<string, unknown>;
      const repoName = String(input.name ?? '');
      if (repoName === '') {
        sendError(res, 422, 'name is required');
        return;
      }
      if (store.getRepo(TOKEN_OWNER_LOGIN, repoName) !== undefined) {
        sendError(res, 422, 'name already exists on this account');
        return;
      }
      const repo = store.createRepo(
        TOKEN_OWNER_LOGIN,
        repoName,
        String(input.description ?? ''),
        Boolean(input.private ?? false),
      );
      if (repo === null) {
        sendError(res, 422, 'name already exists on this account');
        return;
      }
      sendJson(res, 201, repoView(repo));
      return;
    }
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = segments[3]!;
    const repoName = segments[4]!;
    const rest = segments.slice(5);

    // GET/PATCH/DELETE /repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = findRepo(res, owner, repoName);
        if (repo === null) return;
        sendJson(res, 200, repoView(repo));
        return;
      }
      if (method === 'PATCH') {
        const repo = findRepo(res, owner, repoName);
        if (repo === null) return;
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, parsed.message);
          return;
        }
        const input = (parsed.value ?? {}) as Record<string, unknown>;
        if (typeof input.description === 'string') repo.description = input.description;
        sendJson(res, 200, repoView(repo));
        return;
      }
      if (method === 'DELETE') {
        if (!store.deleteRepo(owner, repoName)) {
          sendError(res, 404, 'Not Found');
          return;
        }
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
    }

    const repo = findRepo(res, owner, repoName);
    if (repo === null) return;

    // POST /git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message);
        return;
      }
      const input = (parsed.value ?? {}) as Record<string, unknown>;
      const ref = String(input.ref ?? '');
      const sha = String(input.sha ?? '');
      if (!ref.startsWith('refs/') || repo.objects.get(sha) === undefined) {
        sendError(res, 422, 'Invalid request.\n\n"ref" and "sha" are required and "sha" must name an existing object.');
        return;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: '', url: '', object: { sha, type: 'commit' } });
      return;
    }

    // GET /git/refs/heads/{branch}
    if (rest.length === 4 && rest[0] === 'git' && rest[1] === 'refs' && rest[2] === 'heads' && method === 'GET') {
      const branch = decodeURIComponent(rest[3]!);
      const sha = repo.branchTip(branch);
      if (sha === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, node_id: '', url: '', object: { sha, type: 'commit' } });
      return;
    }

    // GET /branches and /branches/{branch}
    if (rest[0] === 'branches' && method === 'GET') {
      if (rest.length === 1) {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: repo.branchTip(branch) }, protected: false }));
        sendJson(res, 200, branches);
        return;
      }
      if (rest.length === 2) {
        const branch = decodeURIComponent(rest[1]!);
        const sha = repo.branchTip(branch);
        if (sha === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
        return;
      }
    }

    // GET /commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const ref = query.sha ?? repo.defaultBranch;
      const tip = repo.resolveRef(ref);
      if (tip === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const { page, perPage } = pageParams(query);
      const history = repo.commitHistory(tip);
      const { items } = paginate(history, page, perPage);
      const views = items.map((sha) => commitView(repo, sha)).filter((view): view is Record<string, unknown> => view !== null);
      sendJson(res, 200, views);
      return;
    }

    // /contents/{path...}
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
      if (method === 'GET') {
        const read = store.readPath(repo, query.ref, contentPath);
        if (read === null) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (read.kind === 'dir') {
          sendJson(
            res,
            200,
            read.entries.map((entry) => ({
              type: entry.mode === '40000' ? 'dir' : 'file',
              size: 0,
              name: entry.name,
              path: contentPath === '' ? entry.name : `${contentPath}/${entry.name}`,
              sha: entry.oid,
              url: '',
            })),
          );
          return;
        }
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: read.data.length,
          name: contentPath.split('/').pop(),
          path: contentPath,
          content: read.data.toString('base64'),
          sha: read.blobOid,
          url: '',
        });
        return;
      }
      if (method === 'PUT') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, parsed.message);
          return;
        }
        const input = (parsed.value ?? {}) as Record<string, unknown>;
        const message = String(input.message ?? 'Update file');
        const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
        const content = typeof input.content === 'string' ? Buffer.from(input.content, 'base64') : null;
        if (content === null) {
          sendError(res, 422, 'content is required');
          return;
        }
        const existing = store.readPath(repo, branch, contentPath);
        const expectedSha = typeof input.sha === 'string' ? input.sha : undefined;
        if (expectedSha !== undefined) {
          if (existing === null || existing.kind !== 'file' || existing.blobOid !== expectedSha) {
            sendError(res, 409, 'sha does not match the current blob');
            return;
          }
        }
        const { commitSha, blobSha } = store.commitFile(repo, branch, contentPath, content, message);
        sendJson(res, existing === null || existing.kind !== 'file' ? 201 : 200, {
          content: {
            name: contentPath.split('/').pop(),
            path: contentPath,
            sha: blobSha,
            size: content.length,
            type: 'file',
            encoding: 'base64',
          },
          commit: { sha: commitSha, message },
        });
        return;
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, parsed.message);
          return;
        }
        const input = (parsed.value ?? {}) as Record<string, unknown>;
        const message = String(input.message ?? 'Delete file');
        const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
        const existing = store.readPath(repo, branch, contentPath);
        if (existing === null || existing.kind !== 'file') {
          sendError(res, 404, 'Not Found');
          return;
        }
        const expectedSha = typeof input.sha === 'string' ? input.sha : undefined;
        if (expectedSha !== undefined && existing.blobOid !== expectedSha) {
          sendError(res, 409, 'sha does not match the current blob');
          return;
        }
        const { commitSha } = store.commitFile(repo, branch, contentPath, null, message);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return;
      }
    }

    // POST /labels
    if (rest.length === 1 && rest[0] === 'labels' && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, parsed.message);
        return;
      }
      const input = (parsed.value ?? {}) as Record<string, unknown>;
      const name = String(input.name ?? '');
      if (name === '') {
        sendError(res, 422, 'name is required');
        return;
      }
      const existing = repo.labels.get(name);
      if (existing !== undefined) {
        sendJson(res, 200, { name: existing.name, color: existing.color, description: existing.description, default: false });
        return;
      }
      const label = {
        name,
        color: typeof input.color === 'string' ? input.color.replace(/^#/, '') : '000000',
        description: typeof input.description === 'string' ? input.description : '',
      };
      repo.labels.set(name, label);
      sendJson(res, 201, { ...label, default: false });
      return;
    }

    // /issues...
    if (rest[0] === 'issues') {
      // GET/POST /issues
      if (rest.length === 1) {
        if (method === 'GET') {
          const { page, perPage } = pageParams(query);
          let issues = [...repo.issues.values()];
          const state = query.state ?? 'open';
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          if (query.sort === 'created') {
            const direction = query.direction === 'asc' ? 1 : -1;
            issues.sort((a, b) => direction * (a.createdSeq - b.createdSeq));
          } else {
            issues.sort((a, b) => b.createdSeq - a.createdSeq);
          }
          const { items, hasNext, lastPage } = paginate(issues, page, perPage);
          const extra: Record<string, string> = {};
          if (hasNext || page > 1) extra.link = linkHeader(req, path, query, page, perPage, lastPage);
          sendJson(res, 200, items.map((issue) => issueView(repo, issue)), extra);
          return;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendError(res, 400, parsed.message);
            return;
          }
          const input = (parsed.value ?? {}) as Record<string, unknown>;
          const title = String(input.title ?? '');
          if (title === '') {
            sendError(res, 422, 'title is required');
            return;
          }
          const labels = Array.isArray(input.labels) ? input.labels.map(String) : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendError(res, 422, `Validation Failed: label "${label}" does not exist`);
              return;
            }
          }
          const issue = store.createIssue(repo, title, String(input.body ?? ''), labels);
          sendJson(res, 201, issueView(repo, issue));
          return;
        }
      }
      // GET/PATCH /issues/{n}
      if (rest.length === 2) {
        const number = Number(rest[1]);
        const issue = repo.issues.get(number);
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueView(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendError(res, 400, parsed.message);
            return;
          }
          const input = (parsed.value ?? {}) as Record<string, unknown>;
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (input.state === 'closed' || input.state === 'open') issue.state = input.state;
          if (Array.isArray(input.labels)) {
            const labels = input.labels.map(String);
            for (const label of labels) {
              if (!repo.labels.has(label)) {
                sendError(res, 422, `Validation Failed: label "${label}" does not exist`);
                return;
              }
            }
            issue.labels = labels;
          }
          issue.updatedAt = isoOf(nextTimestampSec());
          sendJson(res, 200, issueView(repo, issue));
          return;
        }
      }
      // GET/POST /issues/{n}/comments
      if (rest.length === 3 && rest[2] === 'comments') {
        const number = Number(rest[1]);
        const issue = repo.issues.get(number);
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          const comments = repo.comments.get(number) ?? [];
          sendJson(res, 200, comments.map((comment) => commentView(repo, number, comment)));
          return;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendError(res, 400, parsed.message);
            return;
          }
          const input = (parsed.value ?? {}) as Record<string, unknown>;
          const commentBody = String(input.body ?? '');
          if (commentBody === '') {
            sendError(res, 422, 'body is required');
            return;
          }
          const stamp = isoOf(nextTimestampSec());
          const comment = { id: store.newCommentId(), body: commentBody, createdAt: stamp, updatedAt: stamp };
          const list = repo.comments.get(number) ?? [];
          list.push(comment);
          repo.comments.set(number, list);
          sendJson(res, 201, commentView(repo, number, comment));
          return;
        }
      }
    }

    // /pulls...
    if (rest[0] === 'pulls') {
      // GET/POST /pulls
      if (rest.length === 1) {
        if (method === 'GET') {
          const { page, perPage } = pageParams(query);
          let pulls = [...repo.pulls.values()];
          const state = query.state ?? 'open';
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.createdSeq - a.createdSeq);
          const { items, hasNext, lastPage } = paginate(pulls, page, perPage);
          const extra: Record<string, string> = {};
          if (hasNext || page > 1) extra.link = linkHeader(req, path, query, page, perPage, lastPage);
          sendJson(res, 200, items.map((pull) => pullView(repo, pull)), extra);
          return;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendError(res, 400, parsed.message);
            return;
          }
          const input = (parsed.value ?? {}) as Record<string, unknown>;
          const title = String(input.title ?? '');
          const headRaw = String(input.head ?? '');
          const baseRaw = String(input.base ?? '');
          const headRef = headRaw.includes(':') ? headRaw.split(':').slice(1).join(':') : headRaw;
          const baseRef = baseRaw.includes(':') ? baseRaw.split(':').slice(1).join(':') : baseRaw;
          if (title === '' || headRef === '' || baseRef === '') {
            sendError(res, 422, 'title, head, and base are required');
            return;
          }
          const headSha = repo.branchTip(headRef);
          const baseSha = repo.branchTip(baseRef);
          if (headSha === undefined || baseSha === undefined) {
            sendError(res, 422, 'head or base branch not found');
            return;
          }
          const pull = store.createPull(repo, title, String(input.body ?? ''), headRef, headSha, baseRef, baseSha);
          sendJson(res, 201, pullView(repo, pull));
          return;
        }
      }
      // GET /pulls/{n}
      if (rest.length === 2 && method === 'GET') {
        const number = Number(rest[1]);
        const pull = repo.pulls.get(number);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, pullView(repo, pull));
        return;
      }
      // GET /pulls/{n}/files
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const number = Number(rest[1]);
        const pull = repo.pulls.get(number);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const baseTree = repo.treeOfCommit(pull.baseSha);
        const headTree = repo.treeOfCommit(pull.headSha);
        const diff = repo.diffTrees(baseTree, headTree);
        sendJson(
          res,
          200,
          diff.map((entry) => ({
            sha: '',
            filename: entry.filename,
            status: entry.status,
            additions: entry.additions,
            deletions: entry.deletions,
            changes: entry.additions + entry.deletions,
            blob_url: '',
            raw_url: '',
            contents_url: '',
          })),
        );
        return;
      }
      // PUT /pulls/{n}/merge
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const number = Number(rest[1]);
        const pull = repo.pulls.get(number);
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, parsed.message);
          return;
        }
        const input = (parsed.value ?? {}) as Record<string, unknown>;
        if (pull.state !== 'open') {
          sendError(res, 405, 'Pull request is already closed');
          return;
        }
        const message = typeof input.commit_title === 'string' ? input.commit_title : `${pull.title} (#${pull.number})`;
        const sha = store.mergePull(repo, pull, message);
        if (sha === null) {
          sendError(res, 405, 'This branch has conflicts that must be resolved');
          return;
        }
        sendJson(res, 200, { sha, merged: true, message: `Pull request successfully merged and closed.\n\n${message}` });
        return;
      }
    }
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- router

export function createApp(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const method = req.method ?? 'GET';
        const path = url.pathname;

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const suffix = gitMatch[3]!;
          if (method === 'GET' && suffix === 'info/refs') {
            handleGitInfoRefs(req, res, owner, repoName, url);
            return;
          }
          if (method === 'POST' && suffix === 'git-upload-pack') {
            const body = await readBody(req);
            handleGitUploadPack(req, res, owner, repoName, body);
            return;
          }
          if (method === 'POST' && suffix === 'git-receive-pack') {
            const body = await readBody(req);
            handleGitReceivePack(req, res, owner, repoName, body);
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }

        // GraphQL
        if (method === 'POST' && path === '/api/graphql') {
          if (!requireAuth(req, res)) return;
          const body = await readBody(req);
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendError(res, 400, parsed.message);
            return;
          }
          if (Array.isArray(parsed.value)) {
            sendJson(res, 200, parsed.value.map((item) => executeGraphQL(item)));
          } else {
            sendJson(res, 200, executeGraphQL(parsed.value));
          }
          return;
        }

        // MCP
        if (path === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(204, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          if (method === 'POST') {
            if (!requireAuth(req, res)) return;
            const body = await readBody(req);
            const outcome = handleMcp(body.toString('utf8'));
            if (outcome.kind === 'notification') {
              res.writeHead(202, { 'x-github-request-id': nextRequestId() });
              res.end();
              return;
            }
            sendJson(res, outcome.status, outcome.body);
            return;
          }
        }

        // REST v3
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const body = await readBody(req);
          await handleRest(req, res, url, body);
          return;
        }

        sendError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        else res.end();
      }
    })();
  });
  return server;
}

export { DEFAULT_BRANCH };
