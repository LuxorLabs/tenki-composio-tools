# @luxorai/composio-tools

Luxor Sandbox tools for [Composio](https://composio.dev) agents. Gives any Composio agent disposable Linux microVMs from [Luxor Agent Cloud](https://luxor.ai) by Luxor AI: boot in ~2-4 seconds, run shell commands, snapshot state, and terminate, via Composio's [custom toolkits](https://docs.composio.dev/docs/extending-sessions/custom-tools-and-toolkits).

The tools run **in-process in your app** and call the Luxor Sandbox SDK directly. No extra backend, no Composio approval needed.

The old `@tenkicloud/composio-tools` name keeps working and publishes the same code.

## Install

```bash
npm install @luxorai/composio-tools @composio/core
```

`@composio/core` is a peer dependency (>= 0.13.0). Requires Node >= 18. ESM-only, matching `@composio/core`: from CommonJS use dynamic `import()`, or plain `require()` on Node >= 20.19.

## Quickstart

```ts
import { Composio } from '@composio/core';
import { luxorToolkit } from '@luxorai/composio-tools';

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });

const session = await composio.create('user_1', {
  experimental: { customToolkits: [luxorToolkit()] },
});

// The agent can now call:
//   LOCAL_LUXOR_CREATE_SANDBOX
//   LOCAL_LUXOR_EXEC_COMMAND
//   LOCAL_LUXOR_LIST_SANDBOXES
//   LOCAL_LUXOR_GET_SANDBOX
//   LOCAL_LUXOR_CREATE_SNAPSHOT
//   LOCAL_LUXOR_TERMINATE_SANDBOX
```

`tenkiToolkit()` exposes the same tools under the original `LOCAL_TENKI_*` slugs and takes the same options.

> Note: toolkits bind via `experimental.customToolkits` (standalone tools use `experimental.customTools`).

Authentication: set `LUXORAI_API_KEY` (or `LUXORAI_AUTH_TOKEN`) in your environment (get an `lx_` key at [luxor.ai](https://luxor.ai/docs/)), or pass `authToken` explicitly. Workspace API keys infer the workspace automatically, so no workspace or project configuration is needed. `LUXORAI_API_URL` and `LUXORAI_SANDBOX_GATEWAY_URL` override the endpoints. The `TENKI_*` names (`TENKI_API_KEY`, ...) and `tk_` keys are still accepted; `LUXORAI_*` wins when both are set.

## Configuration

```ts
luxorToolkit({
  authToken: 'lx_…', // default: LUXORAI_API_KEY env var (TENKI_API_KEY still accepted)
  preload: true, // expose tools in session.tools() without searching first
  bootTimeoutMs: 120_000, // creation + readiness budget; failed boots are terminated, not leaked
  defaults: {
    // applied to CREATE_SANDBOX when the agent omits them
    cpuCores: 4,
    memoryMb: 8192,
    allowOutbound: true,
    maxDurationMs: 30 * 60_000, // hard backstop: VM self-terminates even if the host crashes
  },
});
```

## Tools

| Tool                            | Input                                                                                                                                               | Returns                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `LOCAL_LUXOR_CREATE_SANDBOX`    | `name?`, `cpuCores?`, `memoryMb?`, `allowOutbound?`, `image?`, `snapshotId?`, `env?` (array of `{name, value}`), `maxDurationMinutes?` (default 30) | `sessionId`, specs, state, `bootTimeMs`                                                   |
| `LOCAL_LUXOR_EXEC_COMMAND`      | `sessionId`, `command`, `timeoutSeconds?` (default 30, max 600)                                                                                     | `exitCode`, `stdout`, `stderr`, `durationMs` (output truncated ~12KB/4KB for LLM context) |
| `LOCAL_LUXOR_LIST_SANDBOXES`    | `state?` (filter)                                                                                                                                   | `count`, `sandboxes[]` with id/name/state/specs                                           |
| `LOCAL_LUXOR_GET_SANDBOX`       | `sessionId`                                                                                                                                         | full detail incl. state, networking, expiry                                               |
| `LOCAL_LUXOR_CREATE_SNAPSHOT`   | `sessionId`, `name?`                                                                                                                                | `snapshotId` (usable in `CREATE_SANDBOX.snapshotId`)                                      |
| `LOCAL_LUXOR_TERMINATE_SANDBOX` | `sessionId`                                                                                                                                         | idempotent; `alreadyTerminated` flag                                                      |

Behavior notes: every tool returns structured JSON and never throws: SDK errors come back as `{ success: false, error: { type, message } }` so the agent can react. `EXEC_COMMAND` requires an existing `sessionId` (no implicit sandbox creation). Outbound internet is controlled by `allowOutbound`; when omitted, your Luxor **workspace defaults** apply; check `outboundNetworking` in the `CREATE_SANDBOX` response.

Lifecycle guarantees: `CREATE_SANDBOX` is **failure-atomic**: the session handle is held before waiting for readiness, so a boot that fails or exceeds `bootTimeoutMs` is terminated, never leaked. Every sandbox gets a **max-duration backstop** (default 30 min, override via `maxDurationMinutes` or `defaults.maxDurationMs`) so microVMs self-terminate even if the host process crashes before calling `TERMINATE_SANDBOX`. Readiness is detected by polling unary `refresh()` rather than the streaming `waitReady()` RPC, which some runtimes (e.g. Bun's `node:http2`) close prematurely.

## Security

- `LUXORAI_API_KEY` (or `TENKI_API_KEY`) grants control over your Luxor workspace. Keep it in the host environment, never inside sandboxes.
- Tools run in-process in _your_ application (the host you run the Composio session from), not on Composio's servers.
- The agent decides what commands to run; the sandbox is your isolation boundary. Set `allowOutbound: false` explicitly (per call or via `defaults`) if your workspace default is open and the task doesn't need network.

## How it works

Custom tools are **session-scoped**: `luxorToolkit()` returns a `CustomToolkit` whose `execute` functions run in your process and call the Luxor Sandbox SDK. Composio prefixes the slugs (`CREATE_SANDBOX` → `LOCAL_LUXOR_CREATE_SANDBOX`) and routes agent tool calls back to your process via `session.execute()`. Because execution is session-bound, drive these tools through the session object: `provider.handleToolCalls()` (global execute path) cannot reach them; see `scripts/agent-test.ts` for a working agentic loop.

## Development

```bash
pnpm install
pnpm test          # vitest unit tests (SDK mocked, no network, no keys needed)
pnpm build         # tsup → dist/ (ESM + CJS + d.ts)
pnpm typecheck
pnpm format:check
```

Live verification (needs a `.env` with real keys, see the script headers):

```bash
pnpm smoke   # drives all six tools through a real Composio session: create → exec → snapshot → terminate
pnpm agent   # an LLM autonomously boots, inspects, and terminates a sandbox
             # (any OpenAI-compatible endpoint: set LLM_API_KEY + LLM_MODEL, optional LLM_BASE_URL)
```

Both scripts terminate every microVM they create (even on failure) and `smoke` deletes its test snapshot.

## License

MIT
