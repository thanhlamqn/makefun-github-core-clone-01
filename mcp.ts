// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0), same store as REST.
// Modern revision 2026-07-28 via server/discover; legacy initialize handshake is kept
// for older clients. Tools are a frozen constant: two tools/list calls answer byte-for-byte
// the same array.

import { store, TOKEN_OWNER_LOGIN, DEFAULT_BRANCH } from './store.ts';
import type { Repo } from './store.ts';

export const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_SERVER_NAME = 'github-core-clone-forge';
export const MCP_SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'Owner login (defaults to the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'owner/repo, an alternative to owner and repo.' },
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
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'owner/repo, an alternative to owner and repo.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
        labels: { type: 'array', description: 'Labels to attach (must already exist).' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'owner/repo, an alternative to owner and repo.' },
        state: { type: 'string', description: 'open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'owner/repo, an alternative to owner and repo.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'owner/repo, an alternative to owner and repo.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
        number: { type: 'integer', description: 'Pull request number (alias for pull_number).' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];
Object.freeze(TOOLS);

const TOOLS_JSON = JSON.stringify(TOOLS);

export function toolsListJson(): string {
  return TOOLS_JSON;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function serverInfo(): Record<string, unknown> {
  return { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
}

function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueView(repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[] }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    repository: repo.fullName,
  };
}

function pullView(repo: Repo, pull: { id: number; number: number; title: string; body: string; state: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; headRef: string; headSha: string; baseRef: string; baseSha: string }): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    repository: repo.fullName,
  };
}

/** Split owner/repo out of the tool arguments (owner+repo, or full_name). */
function resolveRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const fullName = args.full_name ?? args.fullName;
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const [owner, repo] = fullName.split('/', 2);
    if (owner !== undefined && repo !== undefined && owner !== '' && repo !== '') return { owner, repo };
  }
  const owner = args.owner;
  const repo = args.repo ?? args.repository;
  if (typeof owner === 'string' && typeof repo === 'string' && owner !== '' && repo !== '') return { owner, repo };
  return null;
}

function missingRequired(args: Record<string, unknown>, required: string[]): string | null {
  for (const name of required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

interface ToolOutcome {
  structured: Record<string, unknown>;
  isError?: boolean;
  errorText?: string;
}

function callTool(name: string, args: Record<string, unknown>): ToolOutcome {
  const canonical = name.toLowerCase().replace(/^github__/, '');
  const def = TOOLS.find((tool) => tool.name === canonical);
  if (def === undefined) {
    return { structured: {}, isError: true, errorText: `unknown tool: ${name}` };
  }
  const missing = missingRequired(args, def.inputSchema.required ?? []);
  if (missing !== null) {
    return { structured: {}, isError: true, errorText: `missing required argument: ${missing}` };
  }
  switch (canonical) {
    case 'create_repo': {
      const repoName = String(args.name);
      const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : TOKEN_OWNER_LOGIN;
      if (store.getRepo(owner, repoName) !== undefined) {
        return { structured: {}, isError: true, errorText: `repository ${owner}/${repoName} already exists` };
      }
      const repo = store.createRepo(owner, repoName, String(args.description ?? ''), Boolean(args.private ?? false));
      if (repo === null) return { structured: {}, isError: true, errorText: 'repository already exists' };
      const view = repoView(repo);
      return { structured: view };
    }
    case 'get_repo': {
      const resolved = resolveRepoArgs(args);
      if (resolved === null) return { structured: {}, isError: true, errorText: 'owner and repo are required' };
      const repo = store.getRepo(resolved.owner, resolved.repo);
      if (repo === undefined) return { structured: {}, isError: true, errorText: `repository ${resolved.owner}/${resolved.repo} not found` };
      return { structured: repoView(repo) };
    }
    case 'create_issue': {
      const resolved = resolveRepoArgs(args);
      if (resolved === null) return { structured: {}, isError: true, errorText: 'owner and repo are required' };
      const repo = store.getRepo(resolved.owner, resolved.repo);
      if (repo === undefined) return { structured: {}, isError: true, errorText: `repository ${resolved.owner}/${resolved.repo} not found` };
      const labels = Array.isArray(args.labels) ? args.labels.map(String) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return { structured: {}, isError: true, errorText: `label ${label} does not exist` };
      }
      const issue = store.createIssue(repo, String(args.title), String(args.body ?? ''), labels);
      return { structured: issueView(repo, issue) };
    }
    case 'list_issues': {
      const resolved = resolveRepoArgs(args);
      if (resolved === null) return { structured: {}, isError: true, errorText: 'owner and repo are required' };
      const repo = store.getRepo(resolved.owner, resolved.repo);
      if (repo === undefined) return { structured: {}, isError: true, errorText: `repository ${resolved.owner}/${resolved.repo} not found` };
      const state = String(args.state ?? 'open');
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.createdSeq - a.createdSeq);
      return { structured: { issues: issues.map((issue) => issueView(repo, issue)), total_count: issues.length } };
    }
    case 'create_pull_request': {
      const resolved = resolveRepoArgs(args);
      if (resolved === null) return { structured: {}, isError: true, errorText: 'owner and repo are required' };
      const repo = store.getRepo(resolved.owner, resolved.repo);
      if (repo === undefined) return { structured: {}, isError: true, errorText: `repository ${resolved.owner}/${resolved.repo} not found` };
      const headRef = String(args.head);
      const baseRef = String(args.base);
      const headSha = repo.branchTip(headRef);
      const baseSha = repo.branchTip(baseRef);
      if (headSha === undefined || baseSha === undefined) {
        return { structured: {}, isError: true, errorText: 'head or base branch not found' };
      }
      const pull = store.createPull(repo, String(args.title), String(args.body ?? ''), headRef, headSha, baseRef, baseSha);
      return { structured: pullView(repo, pull) };
    }
    case 'merge_pull_request': {
      const resolved = resolveRepoArgs(args);
      if (resolved === null) return { structured: {}, isError: true, errorText: 'owner and repo are required' };
      const repo = store.getRepo(resolved.owner, resolved.repo);
      if (repo === undefined) return { structured: {}, isError: true, errorText: `repository ${resolved.owner}/${resolved.repo} not found` };
      const number = Number(args.pull_number ?? args.number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { structured: {}, isError: true, errorText: `pull request ${number} not found` };
      if (pull.state !== 'open') return { structured: {}, isError: true, errorText: 'pull request is not open' };
      const sha = store.mergePull(repo, pull);
      if (sha === null) return { structured: {}, isError: true, errorText: 'pull request has conflicts and cannot be merged' };
      return { structured: pullView(repo, pull) };
    }
    default:
      return { structured: {}, isError: true, errorText: `tool ${name} is not implemented` };
  }
}

export type McpOutcome =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'notification'; status: number }
  | { kind: 'parse-error'; status: number; body: unknown };

/**
 * Handle one MCP request body. Returns the JSON-RPC response (or a notification
 * acknowledgement). Auth is checked by the caller before this is invoked.
 */
export function handleMcp(bodyText: string): McpOutcome {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(bodyText) as JsonRpcRequest;
  } catch {
    return {
      kind: 'parse-error',
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (request === null || typeof request !== 'object' || typeof request.method !== 'string') {
    return {
      kind: 'parse-error',
      status: 400,
      body: { jsonrpc: '2.0', id: (request as JsonRpcRequest | null)?.id ?? null, error: { code: -32600, message: 'Invalid Request' } },
    };
  }
  const id = request.id === undefined ? null : request.id;
  const isNotification = request.id === undefined;
  const params = (request.params ?? {}) as Record<string, unknown>;

  switch (request.method) {
    case 'server/discover': {
      const response = result(id, {
        supportedVersions: [...MCP_PROTOCOL_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
      });
      return { kind: 'response', status: 200, body: response };
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSIONS[0]!;
      const version = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0]!;
      const response = result(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
      });
      return { kind: 'response', status: 200, body: response };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
    case 'notifications/roots/list_changed': {
      return { kind: 'notification', status: 202 };
    }
    case 'ping': {
      return { kind: 'response', status: 200, body: result(id, {}) };
    }
    case 'tools/list': {
      // Frozen constant: the same array, byte-for-byte, on every call.
      return {
        kind: 'response',
        status: 200,
        body: result(id, { tools: TOOLS }),
      };
    }
    case 'tools/call': {
      const toolName = params.name;
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
      if (typeof toolName !== 'string' || toolName === '') {
        return { kind: 'response', status: 200, body: error(id, -32602, 'tools/call requires a tool name') };
      }
      const canonical = toolName.toLowerCase().replace(/^github__/, '');
      if (TOOLS.find((tool) => tool.name === canonical) === undefined) {
        return { kind: 'response', status: 200, body: error(id, -32601, `unknown tool: ${toolName}`) };
      }
      const outcome = callTool(toolName, toolArgs);
      const text = outcome.isError === true ? (outcome.errorText ?? 'tool call failed') : JSON.stringify(outcome.structured);
      const response = result(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.structured,
        isError: outcome.isError === true ? true : undefined,
      });
      return { kind: 'response', status: 200, body: response };
    }
    default: {
      if (isNotification) return { kind: 'notification', status: 202 };
      if (request.method.startsWith('notifications/')) return { kind: 'notification', status: 202 };
      return { kind: 'response', status: 200, body: error(id, -32601, `method not found: ${request.method}`) };
    }
  }
}

export { DEFAULT_BRANCH };
