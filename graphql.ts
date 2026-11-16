// graphql.ts — a small, general GraphQL parser and schema-driven executor over the store.
// Supports operations, aliases, variables, inline literals, input objects, lists, inline
// fragments, batch arrays, and __type/__schema introspection. Unknown fields are reported
// as GraphQL errors (HTTP 200) naming the field, as the suite expects.

import { store, globalId, decodeGlobalId, TOKEN_OWNER_LOGIN, TOKEN_OWNER_ID, DEFAULT_BRANCH, nextTimestampSec, isoOf } from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------- tokenizer

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'var' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!@=&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'var', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface Selection {
  kind: 'field' | 'fragment';
  name?: string;
  alias?: string;
  arguments?: Array<{ name: string; value: ValueNode }>;
  directives?: Array<{ name: string; ifValue: ValueNode }>;
  selections?: Selection[];
  typeCondition?: string;
}

interface Operation {
  operation: 'query' | 'mutation';
  name?: string;
  variables: Array<{ name: string; defaultValue?: ValueNode }>;
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}" but got ${token.value}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name but got ${token.value}`);
    return token.value;
  }

  private consumePunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
        continue;
      }
      let operation: 'query' | 'mutation' = 'query';
      let name: string | undefined;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', variables: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operation = token.value;
        this.next();
        const nextToken = this.peek();
        if (nextToken?.kind === 'name') name = this.next().value;
      }
      const variables = this.parseVariableDefinitions();
      const selections = this.parseSelectionSet();
      operations.push({ operation, name, variables, selections });
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue?: ValueNode }> {
    const variables: Array<{ name: string; defaultValue?: ValueNode }> = [];
    if (!this.consumePunct('(')) return variables;
    while (this.peek()?.kind !== 'punct' || this.peek()?.value !== ')') {
      const varToken = this.next();
      if (varToken.kind !== 'var') throw new Error('expected a variable in variable definitions');
      this.expectPunct(':');
      // Skip the type (names, brackets, !) — the executor does not type-check.
      let depth = 0;
      for (;;) {
        const token = this.next();
        if (token.kind === 'punct' && token.value === '[') depth += 1;
        else if (token.kind === 'punct' && token.value === ']') depth -= 1;
        else if (token.kind === 'punct' && token.value === '=' && depth === 0) {
          variables.push({ name: varToken.value, defaultValue: this.parseValue() });
          break;
        } else if (
          (token.kind === 'punct' && (token.value === ',' || token.value === ')')) ||
          (token.kind === 'var' && depth === 0)
        ) {
          this.pos -= 1;
          variables.push({ name: varToken.value });
          break;
        }
        if (depth < 0) throw new Error('unbalanced variable type');
      }
      if (this.peek()?.kind === 'punct' && this.peek()?.value === ')') break;
    }
    this.expectPunct(')');
    return variables;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek()!;
    if (token.kind === 'spread') {
      this.next();
      const nextToken = this.peek()!;
      if (nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        return { kind: 'fragment', typeCondition, selections };
      }
      if (nextToken.kind === 'name') {
        const name = this.next().value;
        return { kind: 'fragment', name };
      }
      throw new Error('expected a fragment name or "on" after ...');
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    const directives: Array<{ name: string; ifValue: ValueNode }> = [];
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      const directiveName = this.expectName();
      let ifValue: ValueNode = { kind: 'boolean', value: true };
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          const value = this.parseValue();
          if (argName === 'if') ifValue = value;
        }
        this.expectPunct(')');
      }
      directives.push({ name: directiveName, ifValue });
    }
    const selections = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : undefined;
    return { kind: 'field', name, alias, arguments: args, directives, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'var':
        return { kind: 'variable', name: token.value };
      case 'int':
        return { kind: 'int', value: Number.parseInt(token.value, 10) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(token.value) };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'punct':
        if (token.value === '[') {
          const values: ValueNode[] = [];
          while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
          this.expectPunct(']');
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected punctuation ${token.value} in a value`);
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      default:
        throw new Error(`unexpected token ${token.value} in a value`);
    }
  }
}

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema

type Resolver = (parent: unknown, args: Record<string, unknown>) => unknown;

interface FieldDef {
  args?: Record<string, unknown>;
  resolve: Resolver;
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
  description?: string;
}

function connectionOf<T>(nodes: T[], first: number | undefined, after: string | undefined): {
  nodes: T[];
  edges: Array<{ node: T; cursor: string }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: number;
} {
  let start = 0;
  if (after !== undefined && after !== null) {
    try {
      const decoded = Buffer.from(String(after), 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) start = Number.parseInt(match[1]!, 10) + 1;
    } catch {
      start = 0;
    }
  }
  const sliced = first === undefined ? nodes.slice(start) : nodes.slice(start, start + first);
  const hasNextPage = first !== undefined && start + sliced.length < nodes.length;
  const endCursor =
    sliced.length === 0 ? null : Buffer.from(`cursor:${start + sliced.length - 1}`, 'utf8').toString('base64');
  return {
    nodes: sliced,
    edges: sliced.map((node, index) => ({
      node,
      cursor: Buffer.from(`cursor:${start + index}`, 'utf8').toString('base64'),
    })),
    pageInfo: { hasNextPage, endCursor },
    totalCount: nodes.length,
  };
}

function findRepoById(databaseId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === databaseId) return repo;
  return undefined;
}

function repoObject(repo: Repo): Record<string, unknown> {
  return { __type: 'Repository', __repo: repo };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __type: 'Issue', __repo: repo, __issue: issue };
}

function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  return { __type: 'PullRequest', __repo: repo, __pull: pull };
}

function userObject(): Record<string, unknown> {
  return { __type: 'User', login: TOKEN_OWNER_LOGIN, id: TOKEN_OWNER_ID, name: 'ada iversen' };
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { resolve: () => userObject() },
      repository: {
        resolve: (_parent, args) => {
          const repo = store.getRepo(String(args.owner), String(args.name));
          return repo === undefined ? null : repoObject(repo);
        },
      },
      node: {
        resolve: (_parent, args) => {
          const decoded = decodeGlobalId(String(args.id ?? ''));
          if (decoded === null) return null;
          if (decoded.kind === 'Repository') {
            const repo = findRepoById(Number(decoded.parts[0]));
            return repo === undefined ? null : repoObject(repo);
          }
          if (decoded.kind === 'Issue') {
            const repo = findRepoById(Number(decoded.parts[0]));
            const issue = repo?.issues.get(Number(decoded.parts[1]));
            return repo === undefined || issue === undefined ? null : issueObject(repo, issue);
          }
          if (decoded.kind === 'PullRequest') {
            const repo = findRepoById(Number(decoded.parts[0]));
            const pull = repo?.pulls.get(Number(decoded.parts[1]));
            return repo === undefined || pull === undefined ? null : pullObject(repo, pull);
          }
          if (decoded.kind === 'IssueComment') {
            const repo = findRepoById(Number(decoded.parts[0]));
            const comments = repo?.comments.get(Number(decoded.parts[1])) ?? [];
            const comment = comments.find((candidate) => candidate.id === Number(decoded.parts[2]));
            return repo === undefined || comment === undefined
              ? null
              : { __type: 'IssueComment', __repo: repo, __comment: comment };
          }
          return null;
        },
      },
      __type: {
        resolve: (_parent, args) => {
          const name = String(args.name ?? '');
          const def = SCHEMA[name];
          if (def === undefined) return null;
          return { __type: '__Type', __typeName: name, __def: def };
        },
      },
      __schema: {
        resolve: () => ({ __type: '__Schema' }),
      },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: {
        resolve: (_parent, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
          if (decoded === null || decoded.kind !== 'Repository') throw new Error('repositoryId is not a repository');
          const repo = findRepoById(Number(decoded.parts[0]));
          if (repo === undefined) throw new Error('repository not found');
          const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
          return { __type: 'CreateIssuePayload', __repo: repo, __issue: issue, clientMutationId: input.clientMutationId ?? null };
        },
      },
      closeIssue: {
        resolve: (_parent, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = decodeGlobalId(String(input.issueId ?? ''));
          if (decoded === null || decoded.kind !== 'Issue') throw new Error('issueId is not an issue');
          const repo = findRepoById(Number(decoded.parts[0]));
          const issue = repo?.issues.get(Number(decoded.parts[1]));
          if (repo === undefined || issue === undefined) throw new Error('issue not found');
          issue.state = 'closed';
          return { __type: 'CloseIssuePayload', __repo: repo, __issue: issue, clientMutationId: input.clientMutationId ?? null };
        },
      },
      createPullRequest: {
        resolve: (_parent, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
          if (decoded === null || decoded.kind !== 'Repository') throw new Error('repositoryId is not a repository');
          const repo = findRepoById(Number(decoded.parts[0]));
          if (repo === undefined) throw new Error('repository not found');
          const headRef = String(input.headRefName ?? '');
          const baseRef = String(input.baseRefName ?? '');
          const headSha = repo.branchTip(headRef);
          const baseSha = repo.branchTip(baseRef);
          if (headSha === undefined || baseSha === undefined) throw new Error('head or base branch not found');
          const pull = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, headSha, baseRef, baseSha);
          return { __type: 'CreatePullRequestPayload', __repo: repo, __pull: pull, clientMutationId: input.clientMutationId ?? null };
        },
      },
      mergePullRequest: {
        resolve: (_parent, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
          if (decoded === null || decoded.kind !== 'PullRequest') throw new Error('pullRequestId is not a pull request');
          const repo = findRepoById(Number(decoded.parts[0]));
          const pull = repo?.pulls.get(Number(decoded.parts[1]));
          if (repo === undefined || pull === undefined) throw new Error('pull request not found');
          const merged = store.mergePull(repo, pull);
          if (merged === null) throw new Error('pull request cannot be merged');
          return { __type: 'MergePullRequestPayload', __repo: repo, __pull: pull, clientMutationId: input.clientMutationId ?? null };
        },
      },
      addComment: {
        resolve: (_parent, args) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const decoded = decodeGlobalId(String(input.subjectId ?? ''));
          if (decoded === null || (decoded.kind !== 'Issue' && decoded.kind !== 'PullRequest')) {
            throw new Error('subjectId is not an issue or pull request');
          }
          const repo = findRepoById(Number(decoded.parts[0]));
          if (repo === undefined) throw new Error('repository not found');
          const number = Number(decoded.parts[1]);
          const stamp = isoOf(nextTimestampSec());
          const comment = {
            id: store.newCommentId(),
            body: String(input.body ?? ''),
            createdAt: stamp,
            updatedAt: stamp,
          };
          const list = repo.comments.get(number) ?? [];
          list.push(comment);
          repo.comments.set(number, list);
          return {
            __type: 'AddCommentPayload',
            __repo: repo,
            __comment: comment,
            __number: number,
            clientMutationId: input.clientMutationId ?? null,
          };
        },
      },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      login: { resolve: (parent) => (parent as Record<string, unknown>).login },
      id: { resolve: (parent) => (parent as Record<string, unknown>).id },
      name: { resolve: (parent) => (parent as Record<string, unknown>).name },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { resolve: (parent) => globalId('Repository', (parent as Record<string, unknown>).__repo as Repo ? ((parent as Record<string, unknown>).__repo as Repo).id : 0) },
      databaseId: { resolve: (parent) => ((parent as Record<string, unknown>).__repo as Repo).id },
      name: { resolve: (parent) => ((parent as Record<string, unknown>).__repo as Repo).name },
      nameWithOwner: { resolve: (parent) => ((parent as Record<string, unknown>).__repo as Repo).fullName },
      owner: { resolve: () => userObject() },
      defaultBranchRef: {
        resolve: (parent) => {
          const repo = (parent as Record<string, unknown>).__repo as Repo;
          return repo.defaultTip() === undefined ? null : { __type: 'Ref', name: repo.defaultBranch, __repo: repo };
        },
      },
      viewerPermission: { resolve: () => 'ADMIN' },
      hasIssuesEnabled: { resolve: () => true },
      description: { resolve: (parent) => ((parent as Record<string, unknown>).__repo as Repo).description },
      issue: {
        resolve: (parent, args) => {
          const repo = (parent as Record<string, unknown>).__repo as Repo;
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueObject(repo, issue);
        },
      },
      issues: {
        resolve: (parent, args) => {
          const repo = (parent as Record<string, unknown>).__repo as Repo;
          let issues = [...repo.issues.values()];
          const states = args.states as string[] | undefined;
          if (states !== undefined && states !== null) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
          const direction = String(orderBy.direction ?? 'DESC');
          issues.sort((a, b) =>
            direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq,
          );
          const first = args.first === undefined || args.first === null ? undefined : Number(args.first);
          const after = args.after === undefined || args.after === null ? undefined : String(args.after);
          const connection = connectionOf(issues, first, after);
          return {
            __type: 'IssueConnection',
            nodes: connection.nodes.map((issue) => issueObject(repo, issue)),
            edges: connection.edges.map((edge) => ({
              __type: 'IssueEdge',
              node: issueObject(repo, edge.node),
              cursor: edge.cursor,
            })),
            pageInfo: connection.pageInfo,
            totalCount: connection.totalCount,
          };
        },
      },
      pullRequests: {
        resolve: (parent, args) => {
          const repo = (parent as Record<string, unknown>).__repo as Repo;
          const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
          const first = args.first === undefined || args.first === null ? undefined : Number(args.first);
          const after = args.after === undefined || args.after === null ? undefined : String(args.after);
          const connection = connectionOf(pulls, first, after);
          return {
            __type: 'PullRequestConnection',
            nodes: connection.nodes.map((pull) => pullObject(repo, pull)),
            edges: connection.edges.map((edge) => ({
              __type: 'PullRequestEdge',
              node: pullObject(repo, edge.node),
              cursor: edge.cursor,
            })),
            pageInfo: connection.pageInfo,
            totalCount: connection.totalCount,
          };
        },
      },
      pullRequest: {
        resolve: (parent, args) => {
          const repo = (parent as Record<string, unknown>).__repo as Repo;
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullObject(repo, pull);
        },
      },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: { resolve: (parent) => (parent as Record<string, unknown>).name },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: {
        resolve: (parent) => {
          const record = parent as Record<string, unknown>;
          const repo = record.__repo as Repo;
          const issue = record.__issue as Issue;
          return globalId('Issue', repo.id, issue.number);
        },
      },
      number: { resolve: (parent) => (parent as Record<string, unknown>).__issue as Issue ? ((parent as Record<string, unknown>).__issue as Issue).number : 0 },
      title: { resolve: (parent) => ((parent as Record<string, unknown>).__issue as Issue).title },
      state: { resolve: (parent) => ((parent as Record<string, unknown>).__issue as Issue).state.toUpperCase() },
      body: { resolve: (parent) => ((parent as Record<string, unknown>).__issue as Issue).body },
      createdAt: { resolve: (parent) => ((parent as Record<string, unknown>).__issue as Issue).createdAt },
      updatedAt: { resolve: (parent) => ((parent as Record<string, unknown>).__issue as Issue).updatedAt },
      labels: {
        resolve: (parent) => {
          const record = parent as Record<string, unknown>;
          const repo = record.__repo as Repo;
          const issue = record.__issue as Issue;
          return issue.labels.map((name) => ({ __type: 'Label', name, color: repo.labels.get(name)?.color ?? '000000' }));
        },
      },
    },
  },
  Label: {
    kind: 'OBJECT',
    fields: {
      name: { resolve: (parent) => (parent as Record<string, unknown>).name },
      color: { resolve: (parent) => (parent as Record<string, unknown>).color },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { resolve: (parent) => (parent as Record<string, unknown>).nodes },
      edges: { resolve: (parent) => (parent as Record<string, unknown>).edges },
      pageInfo: { resolve: (parent) => (parent as Record<string, unknown>).pageInfo },
      totalCount: { resolve: (parent) => (parent as Record<string, unknown>).totalCount },
    },
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: {
      node: { resolve: (parent) => (parent as Record<string, unknown>).node },
      cursor: { resolve: (parent) => (parent as Record<string, unknown>).cursor },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { resolve: (parent) => (parent as Record<string, unknown>).hasNextPage },
      hasPreviousPage: { resolve: () => false },
      endCursor: { resolve: (parent) => (parent as Record<string, unknown>).endCursor },
      startCursor: { resolve: () => null },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: {
        resolve: (parent) => {
          const record = parent as Record<string, unknown>;
          const repo = record.__repo as Repo;
          const pull = record.__pull as Pull;
          return globalId('PullRequest', repo.id, pull.number);
        },
      },
      number: { resolve: (parent) => ((parent as Record<string, unknown>).__pull as Pull).number },
      title: { resolve: (parent) => ((parent as Record<string, unknown>).__pull as Pull).title },
      state: {
        resolve: (parent) => {
          const pull = (parent as Record<string, unknown>).__pull as Pull;
          if (pull.merged) return 'MERGED';
          return pull.state.toUpperCase();
        },
      },
      merged: { resolve: (parent) => ((parent as Record<string, unknown>).__pull as Pull).merged },
      mergeable: {
        resolve: (parent) => {
          const record = parent as Record<string, unknown>;
          const repo = record.__repo as Repo;
          const pull = record.__pull as Pull;
          if (pull.state !== 'open') return 'UNKNOWN';
          return store.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        },
      },
      headRefName: { resolve: (parent) => ((parent as Record<string, unknown>).__pull as Pull).headRef },
      baseRefName: { resolve: (parent) => ((parent as Record<string, unknown>).__pull as Pull).baseRef },
      files: {
        resolve: (parent, args) => {
          const record = parent as Record<string, unknown>;
          const repo = record.__repo as Repo;
          const pull = record.__pull as Pull;
          const baseTree = repo.treeOfCommit(pull.baseSha);
          const headTree = repo.treeOfCommit(pull.headSha);
          const diff = repo.diffTrees(baseTree, headTree);
          const first = args.first === undefined || args.first === null ? undefined : Number(args.first);
          const connection = connectionOf(diff, first, undefined);
          return {
            __type: 'PullRequestFileConnection',
            nodes: connection.nodes.map((file) => ({ __type: 'PullRequestFile', path: file.filename, additions: file.additions, deletions: file.deletions })),
            edges: connection.edges.map((edge) => ({
              __type: 'PullRequestFileEdge',
              node: { __type: 'PullRequestFile', path: edge.node.filename, additions: edge.node.additions, deletions: edge.node.deletions },
              cursor: edge.cursor,
            })),
            pageInfo: connection.pageInfo,
            totalCount: connection.totalCount,
          };
        },
      },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { resolve: (parent) => (parent as Record<string, unknown>).nodes },
      edges: { resolve: (parent) => (parent as Record<string, unknown>).edges },
      pageInfo: { resolve: (parent) => (parent as Record<string, unknown>).pageInfo },
      totalCount: { resolve: (parent) => (parent as Record<string, unknown>).totalCount },
    },
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    fields: {
      node: { resolve: (parent) => (parent as Record<string, unknown>).node },
      cursor: { resolve: (parent) => (parent as Record<string, unknown>).cursor },
    },
  },
  PullRequestFile: {
    kind: 'OBJECT',
    fields: {
      path: { resolve: (parent) => (parent as Record<string, unknown>).path },
      additions: { resolve: (parent) => (parent as Record<string, unknown>).additions },
      deletions: { resolve: (parent) => (parent as Record<string, unknown>).deletions },
    },
  },
  PullRequestFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { resolve: (parent) => (parent as Record<string, unknown>).nodes },
      edges: { resolve: (parent) => (parent as Record<string, unknown>).edges },
      pageInfo: { resolve: (parent) => (parent as Record<string, unknown>).pageInfo },
      totalCount: { resolve: (parent) => (parent as Record<string, unknown>).totalCount },
    },
  },
  PullRequestFileEdge: {
    kind: 'OBJECT',
    fields: {
      node: { resolve: (parent) => (parent as Record<string, unknown>).node },
      cursor: { resolve: (parent) => (parent as Record<string, unknown>).cursor },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: {
        resolve: (parent) => {
          const record = parent as Record<string, unknown>;
          const repo = record.__repo as Repo;
          const comment = record.__comment as { id: number };
          return globalId('IssueComment', repo.id, 0, comment.id);
        },
      },
      body: { resolve: (parent) => ((parent as Record<string, unknown>).__comment as { body: string }).body },
    },
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: {
        resolve: (parent) => {
          const record = parent as Record<string, unknown>;
          return issueObject(record.__repo as Repo, record.__issue as Issue);
        },
      },
      clientMutationId: { resolve: (parent) => (parent as Record<string, unknown>).clientMutationId ?? null },
    },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: {
        resolve: (parent) => {
          const record = parent as Record<string, unknown>;
          return issueObject(record.__repo as Repo, record.__issue as Issue);
        },
      },
      clientMutationId: { resolve: (parent) => (parent as Record<string, unknown>).clientMutationId ?? null },
    },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: {
        resolve: (parent) => {
          const record = parent as Record<string, unknown>;
          return pullObject(record.__repo as Repo, record.__pull as Pull);
        },
      },
      clientMutationId: { resolve: (parent) => (parent as Record<string, unknown>).clientMutationId ?? null },
    },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: {
        resolve: (parent) => {
          const record = parent as Record<string, unknown>;
          return pullObject(record.__repo as Repo, record.__pull as Pull);
        },
      },
      clientMutationId: { resolve: (parent) => (parent as Record<string, unknown>).clientMutationId ?? null },
    },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: {
      commentEdge: {
        resolve: (parent) => {
          const record = parent as Record<string, unknown>;
          return {
            __type: 'IssueCommentEdge',
            node: { __type: 'IssueComment', __repo: record.__repo as Repo, __comment: record.__comment },
            cursor: '',
          };
        },
      },
      clientMutationId: { resolve: (parent) => (parent as Record<string, unknown>).clientMutationId ?? null },
    },
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: {
      node: { resolve: (parent) => (parent as Record<string, unknown>).node },
      cursor: { resolve: (parent) => (parent as Record<string, unknown>).cursor },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: { resolve: (parent) => (parent as Record<string, unknown>).__typeName },
      kind: {
        resolve: (parent) => {
          const def = (parent as Record<string, unknown>).__def as TypeDef;
          return def.kind;
        },
      },
      description: { resolve: () => null },
      fields: {
        resolve: (parent) => {
          const def = (parent as Record<string, unknown>).__def as TypeDef;
          if (def.fields === undefined) return null;
          return Object.keys(def.fields).map((name) => ({ __type: '__Field', name }));
        },
      },
      enumValues: {
        resolve: (parent) => {
          const def = (parent as Record<string, unknown>).__def as TypeDef;
          if (def.enumValues === undefined) return null;
          return def.enumValues.map((name) => ({ __type: '__EnumValue', name }));
        },
      },
      inputFields: { resolve: () => null },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { resolve: (parent) => (parent as Record<string, unknown>).name },
      description: { resolve: () => null },
      args: { resolve: () => [] },
      type: { resolve: () => ({ __type: '__Type', __typeName: 'String', __def: { kind: 'SCALAR' } }) },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { resolve: (parent) => (parent as Record<string, unknown>).name },
      description: { resolve: () => null },
    },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      queryType: { resolve: () => ({ __type: '__Type', __typeName: 'Query', __def: SCHEMA.Query! }) },
      mutationType: { resolve: () => ({ __type: '__Type', __typeName: 'Mutation', __def: SCHEMA.Mutation! }) },
      types: {
        resolve: () =>
          Object.keys(SCHEMA).map((name) => ({ __type: '__Type', __typeName: name, __def: SCHEMA[name]! })),
      },
    },
  },
  SearchType: {
    kind: 'ENUM',
    enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION', 'CODE'],
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
};

// ---------------------------------------------------------------- executor

interface ExecContext {
  variables: Variables;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string }>;
}

function typeNameOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>).__type as string;
  }
  return null;
}

function directiveApplies(selection: Selection, variables: Variables): boolean {
  for (const directive of selection.directives ?? []) {
    const flag = resolveValue(directive.ifValue, variables);
    if (directive.name === 'skip' && flag === true) return false;
    if (directive.name === 'include' && flag !== true) return false;
  }
  return true;
}

function executeSelections(
  parent: unknown,
  typeName: string,
  selections: Selection[],
  context: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const def = SCHEMA[typeName];
  for (const selection of selections) {
    if (!directiveApplies(selection, context.variables)) continue;
    if (selection.kind === 'fragment') {
      if (selection.name !== undefined) {
        const fragment = context.fragments.get(selection.name);
        if (fragment === undefined) {
          context.errors.push({ message: `Unknown fragment "${selection.name}".` });
          continue;
        }
        if (fragment.typeCondition !== typeName && fragment.typeCondition !== typeName) {
          // Fragment on another type: only apply when it matches the runtime type.
          continue;
        }
        Object.assign(out, executeSelections(parent, typeName, fragment.selections, context));
        continue;
      }
      if (selection.typeCondition !== undefined && selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelections(parent, typeName, selection.selections ?? [], context));
      continue;
    }
    const fieldName = selection.name!;
    const responseKey = selection.alias ?? fieldName;
    if (fieldName === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    if (def === undefined || def.fields === undefined || def.fields[fieldName] === undefined) {
      context.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
      continue;
    }
    const fieldDef = def.fields[fieldName]!;
    const args: Record<string, unknown> = {};
    for (const arg of selection.arguments ?? []) args[arg.name] = resolveValue(arg.value, context.variables);
    let value: unknown;
    try {
      value = fieldDef.resolve(parent, args);
    } catch (err) {
      context.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    if (selection.selections === undefined || selection.selections.length === 0) {
      out[responseKey] = value;
      continue;
    }
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item) => {
        const childType = typeNameOf(item);
        if (childType === null) return item;
        return executeSelections(item, childType, selection.selections!, context);
      });
      continue;
    }
    const childType = typeNameOf(value);
    if (childType === null) {
      // Scalar with a sub-selection: invalid, but do not crash.
      out[responseKey] = value;
      continue;
    }
    out[responseKey] = executeSelections(value, childType, selection.selections, context);
  }
  return out;
}

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(body: unknown): GraphQLResult {
  const payload = body as { query?: string; variables?: Variables; operationName?: string };
  const query = payload.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'GraphQL request must include a query string.' }] };
  }
  const variables: Variables = (payload.variables ?? {}) as Variables;
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation = document.operations[0];
  if (payload.operationName !== undefined) {
    operation = document.operations.find((candidate) => candidate.name === payload.operationName) ?? operation;
  }
  if (operation === undefined) {
    return { errors: [{ message: 'No operation found in the GraphQL document.' }] };
  }
  const mergedVariables: Variables = { ...variables };
  for (const variable of operation.variables) {
    if (mergedVariables[variable.name] === undefined && variable.defaultValue !== undefined) {
      mergedVariables[variable.name] = resolveValue(variable.defaultValue, mergedVariables);
    }
  }
  const context: ExecContext = { variables: mergedVariables, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections({}, rootType, operation.selections, context);
  const result: GraphQLResult = { data };
  if (context.errors.length > 0) result.errors = context.errors;
  return result;
}
