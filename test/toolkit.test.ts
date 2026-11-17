import { createServer, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomTool, CustomToolkit, SessionContext } from '@composio/core';
import {
  TenkiSandbox,
  SessionNotFoundError,
  type ExecResult,
  type Session,
  type Snapshot,
} from '@tenkicloud/sandbox';
import { luxorToolkit, tenkiToolkit } from '../src/toolkit';

// Mock only the TenkiSandbox client class; keep helpers (stdoutText, isTerminal, ...)
// and error classes real so tests exercise the same code paths as production.
vi.mock('@tenkicloud/sandbox', async importOriginal => {
  const actual = await importOriginal<typeof import('@tenkicloud/sandbox')>();
  return { ...actual, TenkiSandbox: vi.fn() };
});

const encoder = new TextEncoder();

function fakeExecResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    sessionId: 'sess-1',
    command: 'bash',
    args: ['-lc', 'echo hi'],
    status: 'SUCCEEDED',
    exitCode: 0,
    durationMs: 42,
    outputs: [],
    stdout: encoder.encode('hi\n'),
    stderr: new Uint8Array(),
    ...overrides,
  } as ExecResult;
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'test-sandbox',
    state: 'RUNNING',
    cpuCores: 2,
    memoryMb: 4096,
    diskSizeGb: 10,
    workspaceId: 'ws-1',
    outboundEnabled: false,
    timeoutAt: new Date('2026-07-14T12:00:00Z'),
    idleTimeoutMinutes: 30,
    tags: [],
    exec: vi.fn().mockResolvedValue(fakeExecResult()),
    close: vi.fn().mockResolvedValue(undefined),
    closeIfOpen: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Session;
}

function fakeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'snap-1',
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    name: 'checkpoint',
    state: 'READY',
    sizeBytes: 123_456,
    createdAt: new Date('2026-07-14T12:00:00Z'),
    tags: [],
    ...overrides,
  } as Snapshot;
}

interface MockClient {
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  createSnapshotAndWait: ReturnType<typeof vi.fn>;
}

function mockClient(overrides: Partial<MockClient> = {}): MockClient {
  const client: MockClient = {
    create: vi.fn().mockResolvedValue(fakeSession()),
    get: vi.fn().mockResolvedValue(fakeSession()),
    list: vi.fn().mockResolvedValue([fakeSession()]),
    createSnapshotAndWait: vi.fn().mockResolvedValue(fakeSnapshot()),
    ...overrides,
  };
  vi.mocked(TenkiSandbox).mockImplementation(() => client as unknown as TenkiSandbox);
  return client;
}

function getTool(toolkit: CustomToolkit, slug: string): CustomTool {
  const tool = toolkit.tools.find(t => t.slug === slug);
  if (!tool) throw new Error(`Tool ${slug} not found in toolkit`);
  return tool;
}

const ctx = {} as SessionContext;

async function execute(
  toolkit: CustomToolkit,
  slug: string,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return getTool(toolkit, slug).execute(input, ctx);
}

beforeEach(() => {
  vi.mocked(TenkiSandbox).mockReset();
});

describe('tenkiToolkit shape', () => {
  it('declares the TENKI toolkit with the six MVP tools', () => {
    const toolkit = tenkiToolkit();
    expect(toolkit.slug).toBe('TENKI');
    expect(toolkit.tools.map(t => t.slug).sort()).toEqual([
      'CREATE_SANDBOX',
      'CREATE_SNAPSHOT',
      'EXEC_COMMAND',
      'GET_SANDBOX',
      'LIST_SANDBOXES',
      'TERMINATE_SANDBOX',
    ]);
  });

  it('does not create a Tenki client until a tool is executed', () => {
    mockClient();
    tenkiToolkit();
    expect(TenkiSandbox).not.toHaveBeenCalled();
  });

  it('passes preload through to the toolkit', () => {
    expect(tenkiToolkit({ preload: true }).preload).toBe(true);
    expect(tenkiToolkit().preload).toBeUndefined();
  });
});

describe('luxorToolkit alias', () => {
  it('exposes the same tools under the LUXOR slug', () => {
    const luxor = luxorToolkit();
    expect(luxor.slug).toBe('LUXOR');
    expect(luxor.tools.map(t => t.slug).sort()).toEqual(
      tenkiToolkit()
        .tools.map(t => t.slug)
        .sort()
    );
    expect(getTool(luxor, 'CREATE_SANDBOX').description).toContain('other LUXOR tools');
  });

  it('executes through the same client', async () => {
    const client = mockClient();
    const result = await execute(luxorToolkit(), 'LIST_SANDBOXES', {});
    expect(result.success).toBe(true);
    expect(client.list).toHaveBeenCalled();
  });
});

describe('LUXOR_* env', () => {
  const KEYS = [
    'TENKI_AUTH_TOKEN',
    'TENKI_API_KEY',
    'LUXOR_AUTH_TOKEN',
    'LUXOR_API_KEY',
    'LUXOR_API_ENDPOINT',
    'LUXOR_API_URL',
    'LUXOR_SANDBOX_GATEWAY_URL',
  ];
  beforeEach(() => {
    for (const k of KEYS) vi.stubEnv(k, '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes LUXOR_API_KEY and LUXOR_API_URL to the SDK ahead of its TENKI_* fallback', async () => {
    vi.stubEnv('LUXOR_API_KEY', 'lx_key');
    vi.stubEnv('LUXOR_API_URL', 'https://api.luxor.test');
    mockClient();
    await execute(tenkiToolkit(), 'LIST_SANDBOXES', {});
    expect(TenkiSandbox).toHaveBeenCalledWith({
      authToken: 'lx_key',
      baseUrl: 'https://api.luxor.test',
    });
  });

  it('prefers LUXOR_AUTH_TOKEN over LUXOR_API_KEY, and explicit options over both', async () => {
    vi.stubEnv('LUXOR_AUTH_TOKEN', 'lx_token');
    vi.stubEnv('LUXOR_API_KEY', 'lx_key');
    mockClient();
    await execute(tenkiToolkit(), 'LIST_SANDBOXES', {});
    expect(TenkiSandbox).toHaveBeenLastCalledWith({ authToken: 'lx_token' });
    await execute(tenkiToolkit({ authToken: 'tk_explicit' }), 'LIST_SANDBOXES', {});
    expect(TenkiSandbox).toHaveBeenLastCalledWith({ authToken: 'tk_explicit' });
  });

  it('passes LUXOR_SANDBOX_GATEWAY_URL as the pinned gateway', async () => {
    vi.stubEnv('LUXOR_SANDBOX_GATEWAY_URL', 'gateway.luxor.test:443');
    mockClient();
    await execute(tenkiToolkit(), 'LIST_SANDBOXES', {});
    expect(TenkiSandbox).toHaveBeenLastCalledWith({ gatewayAddress: 'gateway.luxor.test:443' });
  });

  it('leaves auth to the SDK env fallback when no LUXOR_* value is set', async () => {
    mockClient();
    await execute(tenkiToolkit(), 'LIST_SANDBOXES', {});
    expect(TenkiSandbox).toHaveBeenLastCalledWith({});
  });

  describe('LUXOR_API_KEY guard', () => {
    // Build the real SDK client so its own TENKI_* fallback and missing-key error apply.
    async function mockClientWithRealAuth(): Promise<MockClient> {
      const actual =
        await vi.importActual<typeof import('@tenkicloud/sandbox')>('@tenkicloud/sandbox');
      const client = mockClient();
      vi.mocked(TenkiSandbox).mockImplementation(opts => {
        new actual.TenkiSandbox(opts);
        return client as unknown as TenkiSandbox;
      });
      return client;
    }

    it.each([['lx_key'], ['tk_key'], ['  lx_padded  ']])('uses %j', async value => {
      vi.stubEnv('LUXOR_API_KEY', value);
      vi.stubEnv('TENKI_API_KEY', 'tk_legacy');
      mockClient();
      await execute(tenkiToolkit(), 'LIST_SANDBOXES', {});
      expect(TenkiSandbox).toHaveBeenLastCalledWith({ authToken: value.trim() });
    });

    it('ignores a non-prefixed value so the SDK uses TENKI_API_KEY', async () => {
      vi.stubEnv('LUXOR_API_KEY', 'pool-key-123');
      vi.stubEnv('TENKI_API_KEY', 'tk_legacy');
      const client = await mockClientWithRealAuth();
      const result = await execute(tenkiToolkit(), 'LIST_SANDBOXES', {});
      expect(TenkiSandbox).toHaveBeenLastCalledWith({});
      expect(result.success).toBe(true);
      expect(client.list).toHaveBeenCalled();
    });

    it('reports the missing key when a non-prefixed value is the only credential', async () => {
      vi.stubEnv('LUXOR_API_KEY', 'pool-key-123');
      await mockClientWithRealAuth();
      const result = await execute(tenkiToolkit(), 'LIST_SANDBOXES', {});
      expect(TenkiSandbox).toHaveBeenLastCalledWith({});
      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ type: 'MissingAuthTokenError' });
      expect((result.error as { message: string }).message).toContain('TENKI_API_KEY');
    });

    it('rejects a non-prefixed TENKI_API_KEY in the SDK as a structured error', async () => {
      vi.stubEnv('LUXOR_API_KEY', 'pool-key-123');
      vi.stubEnv('TENKI_API_KEY', 'legacy-opaque');
      await mockClientWithRealAuth();
      const result = await execute(tenkiToolkit(), 'LIST_SANDBOXES', {});
      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ type: 'InvalidAuthTokenError' });
    });

    it('does not guard LUXOR_AUTH_TOKEN or an explicit authToken', async () => {
      vi.stubEnv('LUXOR_AUTH_TOKEN', 'opaque-token');
      mockClient();
      await execute(tenkiToolkit(), 'LIST_SANDBOXES', {});
      expect(TenkiSandbox).toHaveBeenLastCalledWith({ authToken: 'opaque-token' });
      await execute(tenkiToolkit({ authToken: 'explicit-token' }), 'LIST_SANDBOXES', {});
      expect(TenkiSandbox).toHaveBeenLastCalledWith({ authToken: 'explicit-token' });
    });
  });
});

describe('auth on the wire (real SDK client)', () => {
  let server: Http2Server;
  let baseUrl: string;
  let seen: Array<{ authorization?: string; cookie?: string }>;
  let clients: TenkiSandbox[];

  beforeEach(async () => {
    for (const k of ['TENKI_AUTH_TOKEN', 'TENKI_API_KEY', 'LUXOR_AUTH_TOKEN', 'LUXOR_API_KEY']) {
      vi.stubEnv(k, '');
    }
    seen = [];
    clients = [];
    // Local h2c endpoint: records the auth headers, then fails the RPC as UNAUTHENTICATED.
    server = createServer();
    // client.close() resets the connection, which is not a test failure.
    server.on('session', session => session.on('error', () => {}));
    server.on('stream', (stream, headers) => {
      stream.on('error', () => {});
      seen.push({ authorization: headers.authorization, cookie: headers.cookie });
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '16' },
        { endStream: true }
      );
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const actual =
      await vi.importActual<typeof import('@tenkicloud/sandbox')>('@tenkicloud/sandbox');
    vi.mocked(TenkiSandbox).mockImplementation(opts => {
      const client = new actual.TenkiSandbox(opts);
      clients.push(client);
      return client;
    });
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    await new Promise(resolve => server.close(resolve));
    vi.unstubAllEnvs();
  });

  it.each([
    ['LUXOR_API_KEY', 'lx_wire_key'],
    ['LUXOR_API_KEY', 'tk_wire_key'],
    ['TENKI_API_KEY', 'lx_legacy_var'],
  ])('sends %s=%s as a Bearer token, not a cookie', async (name, value) => {
    vi.stubEnv(name, value);
    const result = await execute(tenkiToolkit({ baseUrl }), 'LIST_SANDBOXES', {});
    expect(seen).toEqual([{ authorization: `Bearer ${value}`, cookie: undefined }]);
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ type: 'UnauthorizedError' });
  });

  it('sends an explicit lx_ authToken as a Bearer token', async () => {
    await execute(luxorToolkit({ authToken: 'lx_explicit', baseUrl }), 'LIST_SANDBOXES', {});
    expect(seen).toEqual([{ authorization: 'Bearer lx_explicit', cookie: undefined }]);
  });
});

describe('CREATE_SANDBOX', () => {
  it('creates the session without any workspace/project resolution (key infers scope)', async () => {
    const client = mockClient();
    const toolkit = tenkiToolkit();

    const result = await execute(toolkit, 'CREATE_SANDBOX', { name: 'box' });

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('sess-1');
    expect(result.state).toBe('RUNNING');
    expect(result.workspaceId).toBe('ws-1');
    expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'box' }));
    expect(client.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ workspaceId: expect.anything() })
    );
    expect(client.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ projectId: expect.anything() })
    );
  });

  it('converts env pairs into the record expected by the Tenki SDK', async () => {
    const client = mockClient();

    await execute(tenkiToolkit(), 'CREATE_SANDBOX', {
      env: [
        { name: 'NODE_ENV', value: 'test' },
        { name: 'FOO', value: 'bar' },
      ],
    });

    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({ env: { NODE_ENV: 'test', FOO: 'bar' } })
    );
  });

  it('applies factory defaults but lets tool input win', async () => {
    const client = mockClient();
    const toolkit = tenkiToolkit({ defaults: { cpuCores: 4, allowOutbound: true } });

    await execute(toolkit, 'CREATE_SANDBOX', { cpuCores: 8 });

    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({ cpuCores: 8, allowOutbound: true })
    );
  });

  it('boots without blocking readiness and applies the max-duration backstop by default', async () => {
    const client = mockClient();

    await execute(tenkiToolkit(), 'CREATE_SANDBOX', {});

    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({ waitReady: false, maxDurationMs: 30 * 60_000 })
    );
  });

  it('lets maxDurationMinutes input override the backstop', async () => {
    const client = mockClient();

    await execute(tenkiToolkit(), 'CREATE_SANDBOX', { maxDurationMinutes: 5 });

    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({ maxDurationMs: 5 * 60_000 })
    );
  });

  it('is failure-atomic: terminates the sandbox when boot ends in a terminal state', async () => {
    const session = fakeSession({ state: 'CREATING' });
    (session.refresh as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      (session as { state: string }).state = 'TERMINATED';
    });
    mockClient({ create: vi.fn().mockResolvedValue(session) });

    const result = await execute(tenkiToolkit(), 'CREATE_SANDBOX', {});

    expect(result.success).toBe(false);
    expect((result.error as { message: string }).message).toContain('terminal state');
    expect(session.closeIfOpen).toHaveBeenCalled();
  });

  it('is failure-atomic: terminates the sandbox when readiness times out', async () => {
    const session = fakeSession({ state: 'CREATING' });
    mockClient({ create: vi.fn().mockResolvedValue(session) });

    const result = await execute(tenkiToolkit({ bootTimeoutMs: 1 }), 'CREATE_SANDBOX', {});

    expect(result.success).toBe(false);
    expect((result.error as { message: string }).message).toContain('not ready after');
    expect(session.closeIfOpen).toHaveBeenCalled();
  });
});

describe('EXEC_COMMAND', () => {
  it('runs the command via bash -lc and maps the result', async () => {
    const session = fakeSession();
    const client = mockClient({ get: vi.fn().mockResolvedValue(session) });
    const toolkit = tenkiToolkit();

    const result = await execute(toolkit, 'EXEC_COMMAND', {
      sessionId: 'sess-1',
      command: 'echo hi',
    });

    expect(client.get).toHaveBeenCalledWith('sess-1');
    expect(session.exec).toHaveBeenCalledWith('bash', {
      args: ['-lc', 'echo hi'],
      timeoutMs: 30_000,
    });
    expect(result).toMatchObject({
      success: true,
      exitCode: 0,
      status: 'SUCCEEDED',
      stdout: 'hi',
      stdoutTruncated: false,
      stderr: '',
      stderrTruncated: false,
    });
  });

  it('converts timeoutSeconds to milliseconds', async () => {
    const session = fakeSession();
    mockClient({ get: vi.fn().mockResolvedValue(session) });

    await execute(tenkiToolkit(), 'EXEC_COMMAND', {
      sessionId: 'sess-1',
      command: 'sleep 5',
      timeoutSeconds: 120,
    });

    expect(session.exec).toHaveBeenCalledWith('bash', {
      args: ['-lc', 'sleep 5'],
      timeoutMs: 120_000,
    });
  });

  it('truncates oversized stdout and flags it', async () => {
    const big = 'x'.repeat(20_000);
    const session = fakeSession({
      exec: vi.fn().mockResolvedValue(fakeExecResult({ stdout: encoder.encode(big) })),
    } as Partial<Session>);
    mockClient({ get: vi.fn().mockResolvedValue(session) });

    const result = await execute(tenkiToolkit(), 'EXEC_COMMAND', {
      sessionId: 'sess-1',
      command: 'cat big-file',
    });

    expect(result.stdoutTruncated).toBe(true);
    expect((result.stdout as string).length).toBeLessThan(13_000);
    expect(result.stdout as string).toContain('[truncated');
  });

  it('returns a structured error for an unknown session instead of throwing', async () => {
    mockClient({
      get: vi.fn().mockRejectedValue(new SessionNotFoundError('session sess-x not found')),
    });

    const result = await execute(tenkiToolkit(), 'EXEC_COMMAND', {
      sessionId: 'sess-x',
      command: 'echo hi',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ type: 'SessionNotFoundError' });
  });
});

describe('LIST_SANDBOXES', () => {
  it('returns summaries with a count', async () => {
    mockClient({
      list: vi
        .fn()
        .mockResolvedValue([fakeSession(), fakeSession({ id: 'sess-2', state: 'PAUSED' })]),
    });

    const result = await execute(tenkiToolkit(), 'LIST_SANDBOXES', {});

    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.sandboxes).toEqual([
      expect.objectContaining({ sessionId: 'sess-1', state: 'RUNNING' }),
      expect.objectContaining({ sessionId: 'sess-2', state: 'PAUSED' }),
    ]);
  });

  it('filters by state when requested', async () => {
    mockClient({
      list: vi
        .fn()
        .mockResolvedValue([fakeSession(), fakeSession({ id: 'sess-2', state: 'PAUSED' })]),
    });

    const result = await execute(tenkiToolkit(), 'LIST_SANDBOXES', { state: 'PAUSED' });

    expect(result.count).toBe(1);
    expect(result.sandboxes).toEqual([expect.objectContaining({ sessionId: 'sess-2' })]);
  });

  it('never emits object schemas without properties (Composio rejects them)', () => {
    // Regression guard for ToolRouterV2_BadRequest 4300: Composio's backend rejects
    // any JSON-schema object (top-level or nested, e.g. z.record) that has no fixed
    // `properties`. Walk every tool's full input_schema tree.
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node !== 'object' || node === null) return;
      const schema = node as Record<string, unknown>;
      if (schema.type === 'object') {
        const properties = schema.properties as Record<string, unknown> | undefined;
        if (!properties || Object.keys(properties).length === 0) offenders.push(path);
      }
      for (const [key, value] of Object.entries(schema)) walk(value, `${path}.${key}`);
    };
    for (const tool of tenkiToolkit().tools) walk(tool.inputSchema, tool.slug);
    expect(offenders).toEqual([]);
  });
});

describe('GET_SANDBOX', () => {
  it('returns full session details', async () => {
    mockClient();

    const result = await execute(tenkiToolkit(), 'GET_SANDBOX', { sessionId: 'sess-1' });

    expect(result).toMatchObject({
      success: true,
      sessionId: 'sess-1',
      state: 'RUNNING',
      cpuCores: 2,
      memoryMb: 4096,
      workspaceId: 'ws-1',
      outboundNetworking: false,
      expiresAt: '2026-07-14T12:00:00.000Z',
    });
  });
});

describe('CREATE_SNAPSHOT', () => {
  it('creates a snapshot and waits for readiness', async () => {
    const client = mockClient();

    const result = await execute(tenkiToolkit(), 'CREATE_SNAPSHOT', {
      sessionId: 'sess-1',
      name: 'checkpoint',
    });

    expect(client.createSnapshotAndWait).toHaveBeenCalledWith('sess-1', { name: 'checkpoint' });
    expect(result).toMatchObject({
      success: true,
      snapshotId: 'snap-1',
      state: 'READY',
      createdAt: '2026-07-14T12:00:00.000Z',
    });
  });
});

describe('TERMINATE_SANDBOX', () => {
  it('closes a running sandbox', async () => {
    const session = fakeSession();
    mockClient({ get: vi.fn().mockResolvedValue(session) });

    const result = await execute(tenkiToolkit(), 'TERMINATE_SANDBOX', { sessionId: 'sess-1' });

    expect(session.close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: true, terminated: true, alreadyTerminated: false });
  });

  it('is idempotent for an already-terminated sandbox', async () => {
    const session = fakeSession({ state: 'TERMINATED' });
    mockClient({ get: vi.fn().mockResolvedValue(session) });

    const result = await execute(tenkiToolkit(), 'TERMINATE_SANDBOX', { sessionId: 'sess-1' });

    expect(session.close).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      terminated: true,
      alreadyTerminated: true,
      state: 'TERMINATED',
    });
  });

  it('is idempotent for a missing sandbox', async () => {
    mockClient({ get: vi.fn().mockRejectedValue(new SessionNotFoundError('gone')) });

    const result = await execute(tenkiToolkit(), 'TERMINATE_SANDBOX', { sessionId: 'sess-x' });

    expect(result).toMatchObject({ success: true, terminated: true, alreadyTerminated: true });
  });

  it('still surfaces unrelated errors as structured results', async () => {
    mockClient({ get: vi.fn().mockRejectedValue(new Error('network down')) });

    const result = await execute(tenkiToolkit(), 'TERMINATE_SANDBOX', { sessionId: 'sess-1' });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ type: 'Error', message: 'network down' });
  });
});

describe('error handling', () => {
  it('never throws: a missing API key surfaces as a structured error on first call', async () => {
    vi.mocked(TenkiSandbox).mockImplementation(() => {
      throw new Error('TENKI_API_KEY is not set');
    });

    const result = await execute(tenkiToolkit(), 'LIST_SANDBOXES', {});

    expect(result.success).toBe(false);
    expect((result.error as { message: string }).message).toContain('TENKI_API_KEY');
  });
});
