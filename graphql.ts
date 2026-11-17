// graphql.ts — a small GraphQL v4 engine for the documents gh and github-mcp-server
// send: a hand-written lexer/parser for queries, mutations, variables, fragments and
// introspection, executed against the same store REST and MCP use. Unknown fields are
// GraphQL errors (HTTP 200 with an `errors` array), never HTTP errors.

import {
  branchTip,
  commitOf,
  commitTree,
  globalId,
  mergeBase,
  parseGlobalId,
  store,
  trialNowIso,
  VIEWER,
  StoreError,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { peelObject } from './gitobj.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) j += 1;
      const text = input.slice(i, j);
      tokens.push(/[eE.]/.test(text) ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.kind} ${'value' in token ? token.value : ''}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        doc.operations.push({ operation: 'query', name: null, variables: [], selections: this.parseSelections() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        doc.operations.push(this.parseOperation());
      } else if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.parseFragment();
        doc.fragments.set(fragment.name, fragment);
      } else {
        throw new Error(`unexpected token ${token.kind} in GraphQL document`);
      }
    }
    return doc;
  }

  private parseOperation(): OperationNode {
    const operation = this.next().value as 'query' | 'mutation';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    const variables: OperationNode['variables'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelections();
    return { operation, name, variables, selections };
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseFragment(): FragmentNode {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    const selections = this.parseSelections();
    return { name, typeCondition, selections };
  }

  private parseSelections(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const next = this.peek();
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelections() });
        } else if (next.kind === 'name') {
          selections.push({ kind: 'spread', name: this.next().value });
        } else {
          selections.push({ kind: 'inline', typeCondition: null, selections: this.parseSelections() });
        }
      } else {
        selections.push(this.parseField());
      }
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    const first = this.expectName();
    let name = first;
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (@...) are ignored: skip them.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
          if (token.kind === 'eof') break;
        }
      }
    }
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelections() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: Number(token.value) };
      case 'float':
        return { kind: 'float', value: Number(token.value) };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName() };
        if (token.value === '[') {
          const values: ValueNode[] = [];
          while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
          this.expectPunct(']');
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected punctuation ${token.value} as a value`);
      default:
        throw new Error('unexpected token as a value');
    }
  }
}

// ---------------------------------------------------------------- values

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueOf(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema (for __type and field validation)

interface TypeDef {
  kind: 'OBJECT' | 'ENUM';
  fields?: string[];
  enumValues?: string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url'],
  },
  BranchRef: { kind: 'OBJECT', fields: ['name'] },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'url'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'url'],
  },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  FileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  FileEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  ChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'createdAt'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'fields', 'enumValues'] },
  __Field: { kind: 'OBJECT', fields: ['name'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name'] },
};

// ---------------------------------------------------------------- execution

interface ExecContext {
  doc: DocumentNode;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

interface TypedValue {
  typeName: string;
  value: unknown;
}

function fieldError(ctx: ExecContext, typeName: string, field: string): null {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
  return null;
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx.variables);
  return out;
}

function executeSelections(ctx: ExecContext, typeName: string, value: unknown, selections: SelectionNode[]): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.doc.fragments.get(selection.name);
      if (fragment !== undefined) {
        const sub = executeSelections(ctx, typeName, value, fragment.selections);
        if (sub !== null) Object.assign(out, sub);
      }
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        const sub = executeSelections(ctx, typeName, value, selection.selections);
        if (sub !== null) Object.assign(out, sub);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = executeField(ctx, typeName, value, selection);
  }
  return out;
}

function executeField(ctx: ExecContext, typeName: string, value: unknown, field: FieldNode): unknown {
  const def = SCHEMA[typeName];
  if (def === undefined || def.kind !== 'OBJECT') return fieldError(ctx, typeName, field.name);
  if (field.name === '__typename') return typeName;
  // __type introspection is served from the schema table, not the Query field list.
  if (typeName === 'Query' && field.name === '__type') {
    const args = argsOf(field, ctx);
    const name = args.name as string | undefined;
    if (typeof name !== 'string') return null;
    const resolved = introspectType(name);
    if (resolved === null) return null;
    return executeSelections(ctx, resolved.typeName, resolved.value, field.selections);
  }
  if (!def.fields!.includes(field.name)) return fieldError(ctx, typeName, field.name);
  const args = argsOf(field, ctx);
  const resolved = resolveField(ctx, typeName, value, field.name, args);
  if (resolved === null || resolved === undefined) return null;
  if (typeof resolved === 'object' && resolved !== null && 'typeName' in resolved) {
    const typed = resolved as TypedValue;
    return executeSelections(ctx, typed.typeName, typed.value, field.selections);
  }
  if (Array.isArray(resolved)) {
    // A list of typed values (connection nodes/edges, introspection fields): run each
    // through its own sub-selections; plain values pass through unchanged.
    return resolved.map((item) => {
      if (item !== null && typeof item === 'object' && 'typeName' in item) {
        const typed = item as TypedValue;
        return executeSelections(ctx, typed.typeName, typed.value, field.selections);
      }
      return item;
    });
  }
  return resolved;
}

/** Resolve one field to a scalar, a typed object, or a pre-built connection object. */
function resolveField(ctx: ExecContext, typeName: string, value: unknown, field: string, args: Record<string, unknown>): unknown {
  switch (typeName) {
    case 'Query':
      return resolveQuery(ctx, field, args);
    case 'Mutation':
      return resolveMutation(ctx, field, args);
    case 'User':
      return resolveUser(value, field);
    case 'Repository':
      return resolveRepository(ctx, value as Repo, field, args);
    case 'BranchRef':
      return (value as { name: string }).name;
    case 'Issue':
      return resolveIssue(value as Issue, field);
    case 'PullRequest':
      return resolvePull(ctx, value as PullRequest, field, args);
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'FileConnection':
      return resolveConnection(value, field);
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'FileEdge':
    case 'IssueCommentEdge':
      return resolveEdge(ctx, value, field);
    case 'ChangedFile':
      return (value as Record<string, unknown>)[field] ?? null;
    case 'IssueComment':
      return resolveComment(value, field);
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return resolveIssuePayload(ctx, value, field);
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return resolvePullPayload(ctx, value, field);
    case 'AddCommentPayload':
      return resolveCommentPayload(ctx, value, field);
    case '__Type':
      return resolveTypeField(value, field);
    case '__Field':
    case '__EnumValue':
      return (value as Record<string, unknown>)[field] ?? null;
    default:
      return null;
  }
}

function resolveQuery(ctx: ExecContext, field: string, args: Record<string, unknown>): unknown {
  if (field === 'viewer') {
    return { typeName: 'User', value: VIEWER };
  }
  if (field === 'repository') {
    const owner = args.owner as string | undefined;
    const name = args.name as string | undefined;
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    if (owner !== VIEWER.login) return null;
    const repo = store.getRepo(owner, name);
    if (repo === undefined) return null;
    return { typeName: 'Repository', value: repo };
  }
  if (field === 'node') {
    const id = args.id as string | undefined;
    if (typeof id !== 'string') return null;
    const parsed = parseGlobalId(id);
    if (parsed === null) return null;
    const [kind, key] = parsed;
    if (kind === 'Repository') {
      const repoId = Number(key);
      for (const repo of store.repos.values()) {
        if (repo.id === repoId) return { typeName: 'Repository', value: repo };
      }
    }
    return null;
  }
  return null;
}

function resolveUser(value: unknown, field: string): unknown {
  const user = value as typeof VIEWER;
  switch (field) {
    case 'id':
      return globalId('User', String(user.id));
    case 'login':
      return user.login;
    case 'name':
      return user.name;
    case 'email':
      return user.email;
    default:
      return null;
  }
}

function resolveRepository(ctx: ExecContext, repo: Repo, field: string, args: Record<string, unknown>): unknown {
  switch (field) {
    case 'id':
      return globalId('Repository', String(repo.id));
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner':
      return { typeName: 'User', value: VIEWER };
    case 'defaultBranchRef': {
      const tip = branchTip(repo, repo.defaultBranch);
      if (tip === null) return null;
      return { typeName: 'BranchRef', value: { name: repo.defaultBranch } };
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'url':
      return `/api/v3/repos/${repo.owner}/${repo.name}`;
    case 'issue': {
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const issue = store.issueByNumber(repo, number);
      if (issue === undefined) return null;
      return { typeName: 'Issue', value: issue };
    }
    case 'issues':
      return { typeName: 'IssueConnection', value: issuesConnection(repo, args) };
    case 'pullRequest': {
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const pull = store.pullByNumber(repo, number);
      if (pull === undefined) return null;
      return { typeName: 'PullRequest', value: pull };
    }
    case 'pullRequests':
      return { typeName: 'PullRequestConnection', value: pullsConnection(repo, args) };
    default:
      return null;
  }
}

/** A cursor over an ordered list: base64 of the item's sequence number. */
function cursorOf(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function seqOfCursor(cursor: string | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

interface ConnectionItem {
  seq: number;
  node: unknown;
  typeName: string;
}

/**
 * Page an ordered list: `direction` -1 means the list runs by seq descending (the
 * cursor keeps items after it in that order), +1 ascending. `first` caps the page.
 */
function buildConnection(items: ConnectionItem[], args: Record<string, unknown>, direction: -1 | 1 = -1): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : null;
  const afterSeq = seqOfCursor(args.after as string | undefined);
  let filtered = items;
  if (afterSeq !== null) filtered = filtered.filter((item) => (direction === -1 ? item.seq < afterSeq : item.seq > afterSeq));
  const totalCount = items.length;
  const page = first === null ? filtered : filtered.slice(0, first);
  const hasNextPage = first !== null && filtered.length > first;
  const nodes = page.map((item) => ({ typeName: item.typeName, value: item.node }));
  return {
    nodes,
    edges: page.map((item) => ({ typeName: item.typeName === 'Issue' ? 'IssueEdge' : item.typeName === 'PullRequest' ? 'PullRequestEdge' : 'FileEdge', value: { node: { typeName: item.typeName, value: item.node }, cursor: cursorOf(item.seq) } })),
    pageInfo: {
      hasNextPage,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorOf(page[0]!.seq) : null,
      endCursor: page.length > 0 ? cursorOf(page[page.length - 1]!.seq) : null,
    },
    totalCount,
  };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let issues = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  issues.sort((a, b) => (a.seq - b.seq) * direction || (a.number - b.number) * direction);
  return buildConnection(
    issues.map((issue) => ({ seq: issue.seq, node: issue, typeName: 'Issue' })),
    args,
    direction === 1 ? 1 : -1,
  );
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let pulls = [...repo.pulls];
  if (states !== null) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    pulls = pulls.filter((pull) => wanted.has(pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED'));
  } else {
    pulls = pulls.filter((pull) => pull.state === 'open');
  }
  pulls.sort((a, b) => b.seq - a.seq);
  return buildConnection(
    pulls.map((pull) => ({ seq: pull.seq, node: pull, typeName: 'PullRequest' })),
    args,
  );
}

function resolveIssue(issue: Issue, field: string): unknown {
  switch (field) {
    case 'id':
      return globalId('Issue', `${issue.repoId}:${issue.number}`);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issue.state.toUpperCase();
    case 'createdAt':
      return issue.createdAt;
    case 'url':
      return `/issues/${issue.number}`;
    default:
      return null;
  }
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolvePull(ctx: ExecContext, pull: PullRequest, field: string, args: Record<string, unknown>): unknown {
  void ctx;
  switch (field) {
    case 'id':
      return globalId('PullRequest', `${pull.repoId}:${pull.number}`);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pullState(pull);
    case 'merged':
      return pull.merged;
    case 'mergeable': {
      // Find the repo this pull belongs to.
      for (const repo of store.repos.values()) {
        if (repo.pulls.includes(pull)) return store.mergeable(repo, pull);
      }
      return 'UNKNOWN';
    }
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'headRefOid': {
      for (const repo of store.repos.values()) {
        if (repo.pulls.includes(pull)) return branchTip(repo, pull.headRef) ?? pull.headSha;
      }
      return pull.headSha;
    }
    case 'baseRefOid': {
      for (const repo of store.repos.values()) {
        if (repo.pulls.includes(pull)) return branchTip(repo, pull.baseRef) ?? pull.baseSha;
      }
      return pull.baseSha;
    }
    case 'files': {
      for (const repo of store.repos.values()) {
        if (!repo.pulls.includes(pull)) continue;
        const files = store.pullFiles(repo, pull).map((change, index) => ({
          seq: index + 1,
          node: {
            path: change.path,
            additions: change.additions,
            deletions: change.deletions,
            changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
          },
          typeName: 'ChangedFile',
        }));
        return { typeName: 'FileConnection', value: buildConnection(files, args, 1) };
      }
      return { typeName: 'FileConnection', value: buildConnection([], args, 1) };
    }
    case 'createdAt':
      return pull.createdAt;
    case 'url':
      return `/pulls/${pull.number}`;
    default:
      return null;
  }
}

function resolveConnection(value: unknown, field: string): unknown {
  const conn = value as Record<string, unknown>;
  if (field === 'nodes') {
    const nodes = conn.nodes as Array<{ typeName: string; value: unknown }>;
    return nodes;
  }
  if (field === 'edges') return conn.edges;
  if (field === 'pageInfo') return conn.pageInfo;
  if (field === 'totalCount') return conn.totalCount;
  return null;
}

function resolveEdge(ctx: ExecContext, value: unknown, field: string): unknown {
  const edge = value as { node: TypedValue; cursor: string };
  if (field === 'node') return edge.node;
  if (field === 'cursor') return edge.cursor;
  void ctx;
  return null;
}

function resolveComment(value: unknown, field: string): unknown {
  const comment = value as { id: number; body: string; createdAt: string; repoId: number };
  switch (field) {
    case 'id':
      return globalId('IssueComment', `${comment.repoId}:${comment.id}`);
    case 'body':
      return comment.body;
    case 'createdAt':
      return comment.createdAt;
    default:
      return null;
  }
}

function resolveIssuePayload(ctx: ExecContext, value: unknown, field: string): unknown {
  const payload = value as { issue?: Issue };
  if (field === 'issue') {
    if (payload.issue === undefined) return null;
    return { typeName: 'Issue', value: payload.issue };
  }
  void ctx;
  return null;
}

function resolvePullPayload(ctx: ExecContext, value: unknown, field: string): unknown {
  const payload = value as { pullRequest?: PullRequest };
  if (field === 'pullRequest') {
    if (payload.pullRequest === undefined) return null;
    return { typeName: 'PullRequest', value: payload.pullRequest };
  }
  void ctx;
  return null;
}

function resolveCommentPayload(ctx: ExecContext, value: unknown, field: string): unknown {
  const payload = value as { comment?: { id: number; body: string; createdAt: string } };
  if (field === 'commentEdge') {
    if (payload.comment === undefined) return null;
    return {
      typeName: 'IssueCommentEdge',
      value: { node: { typeName: 'IssueComment', value: payload.comment }, cursor: cursorOf(payload.comment.id) },
    };
  }
  void ctx;
  return null;
}

function resolveTypeField(value: unknown, field: string): unknown {
  const type = value as { name: string | null; kind: string; fields?: string[]; enumValues?: string[] };
  switch (field) {
    case 'name':
      return type.name;
    case 'kind':
      return type.kind;
    case 'fields':
      return (type.fields ?? []).map((name) => ({ typeName: '__Field', value: { name } }));
    case 'enumValues':
      return (type.enumValues ?? []).map((name) => ({ typeName: '__EnumValue', value: { name } }));
    default:
      return null;
  }
}

// ---------------------------------------------------------------- mutations

function findRepoByGlobalId(repositoryId: string): Repo | null {
  const parsed = parseGlobalId(repositoryId);
  if (parsed === null || parsed[0] !== 'Repository') return null;
  const repoId = Number(parsed[1]);
  for (const repo of store.repos.values()) if (repo.id === repoId) return repo;
  return null;
}

function findIssueByGlobalId(issueId: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(issueId);
  if (parsed === null || parsed[0] !== 'Issue') return null;
  const [repoIdText, numberText] = parsed[1].split(':');
  const repoId = Number(repoIdText);
  const number = Number(numberText);
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = store.issueByNumber(repo, number);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(pullId: string): { repo: Repo; pull: PullRequest } | null {
  const parsed = parseGlobalId(pullId);
  if (parsed === null || parsed[0] !== 'PullRequest') return null;
  const [repoIdText, numberText] = parsed[1].split(':');
  const repoId = Number(repoIdText);
  const number = Number(numberText);
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const pull = store.pullByNumber(repo, number);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

function resolveMutation(ctx: ExecContext, field: string, args: Record<string, unknown>): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  try {
    switch (field) {
      case 'createIssue': {
        const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
        if (repo === null) throw new Error('Could not resolve to a Repository with the id provided');
        const title = String(input.title ?? '');
        const body = typeof input.body === 'string' ? input.body : '';
        const issue = store.createIssue(repo, title, body, []);
        return { typeName: 'CreateIssuePayload', value: { issue } };
      }
      case 'closeIssue': {
        const found = findIssueByGlobalId(String(input.issueId ?? ''));
        if (found === null) throw new Error('Could not resolve to an Issue with the id provided');
        found.issue.state = 'closed';
        return { typeName: 'CloseIssuePayload', value: { issue: found.issue } };
      }
      case 'createPullRequest': {
        const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
        if (repo === null) throw new Error('Could not resolve to a Repository with the id provided');
        const pull = store.createPull(
          repo,
          String(input.title ?? ''),
          typeof input.body === 'string' ? input.body : '',
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        return { typeName: 'CreatePullRequestPayload', value: { pullRequest: pull } };
      }
      case 'mergePullRequest': {
        const found = findPullByGlobalId(String(input.pullRequestId ?? ''));
        if (found === null) throw new Error('Could not resolve to a PullRequest with the id provided');
        store.mergePull(found.repo, found.pull);
        return { typeName: 'MergePullRequestPayload', value: { pullRequest: found.pull } };
      }
      case 'addComment': {
        const subjectId = String(input.subjectId ?? '');
        const body = typeof input.body === 'string' ? input.body : '';
        const issueFound = findIssueByGlobalId(subjectId);
        if (issueFound !== null) {
          const comment = store.addComment(issueFound.issue, body);
          return { typeName: 'AddCommentPayload', value: { comment } };
        }
        const pullFound = findPullByGlobalId(subjectId);
        if (pullFound !== null) {
          const comment = store.addComment(pullFound.pull, body);
          return { typeName: 'AddCommentPayload', value: { comment } };
        }
        throw new Error('Could not resolve to a subject with the id provided');
      }
      default:
        return null;
    }
  } catch (err) {
    if (err instanceof StoreError) {
      ctx.errors.push({ message: err.message });
      return null;
    }
    if (err instanceof Error) {
      ctx.errors.push({ message: err.message });
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------- entry points

/** Execute one operation document; returns the {data, errors?} envelope. */
export function executeGraphQL(query: string, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  let doc: DocumentNode;
  try {
    doc = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  const operation = doc.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation in document' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const variable of operation.variables) {
    if (!(variable.name in vars) && variable.defaultValue !== null) {
      vars[variable.name] = valueOf(variable.defaultValue, vars);
    }
  }
  const ctx: ExecContext = { doc, variables: vars, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, {}, operation.selections);
  const out: { data: unknown; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

/** The __type introspection answer for a named type, or null for an unknown name. */
export function introspectType(name: string): Record<string, unknown> | null {
  const def = SCHEMA[name];
  if (def === undefined) return null;
  return {
    typeName: '__Type',
    value: {
      name,
      kind: def.kind,
      fields: def.fields ?? [],
      enumValues: def.enumValues ?? [],
    },
  };
}

/** Handle POST /api/graphql: one operation, or a JSON array of them (batched). */
export function handleGraphQL(bodyText: string): { status: number; json: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return { status: 400, json: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  const runOne = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'Expected an operation object' }] };
    }
    const record = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof record.query !== 'string') {
      return { data: null, errors: [{ message: 'Must provide query string.' }] };
    }
    const variables = record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables) ? (record.variables as Record<string, unknown>) : {};
    // Introspection by name: __type(name: "...") is answered from the schema table.
    return executeGraphQL(record.query, variables);
  };
  if (Array.isArray(parsed)) {
    return { status: 200, json: parsed.map(runOne) };
  }
  return { status: 200, json: runOne(parsed) };
}
