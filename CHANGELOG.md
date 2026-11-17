# Changelog

## 0.2.2 (2026-11-17)

- Environment variables now use the `LUXOR_` prefix (for example `LUXOR_API_KEY`). `LUXORAI_*` variables are no longer read; `TENKI_*` still works as a fallback. `LUXOR_API_KEY` is only used when it starts with `lx_` or `tk_`.
- Upgraded `@tenkicloud/sandbox` from `^0.5.4` to `^1.5.3` so `lx_` keys authenticate: they are now sent as Bearer tokens, like `tk_` keys. Tokens that do not start with `lx_` or `tk_` are rejected with `InvalidAuthTokenError`, the default API endpoint is `https://api.luxor.ai`, and `EXEC_COMMAND` now enforces `timeoutSeconds` (a command that runs out of time returns `status: "TIMED_OUT"`).

## 0.2.1 (2026-11-12)

- Package page now shows Luxor names, install commands and docs links.

## 0.2.0 (2026-07-24)

### Breaking changes

- **ESM-only.** The CJS build (`dist/index.cjs`) is removed. It could never work on Node 18/20 anyway: the `@composio/core` peer dependency ships no CJS build, so `require()` of this package threw `ERR_REQUIRE_ESM` there (caught by the new engine-floor CI job). ESM consumers are unaffected; CJS consumers on Node >= 20.19 / >= 22.12 can `require()` the ESM build natively, or use dynamic `import()`.
- `tenkiToolkit()` no longer accepts `workspaceId` / `projectId` options, and the `TENKI_WORKSPACE_ID` / `TENKI_PROJECT_ID` environment variables are no longer read. Tenki removed the project-id requirement from sandbox session creation (server-side and SDK); Workspace API keys infer the workspace automatically. Remove these options if you passed them — no other migration is needed.
- `GET_SANDBOX` / `CREATE_SANDBOX` responses now return `workspaceId` instead of `projectId` (field renamed upstream in the Tenki SDK).

### Changed

- Bumped `@tenkicloud/sandbox` from `^0.3.6` to `^0.5.4`.
- One fewer network round-trip on the first `CREATE_SANDBOX` call (the `whoAmI()` resolution step is gone).

### Added

- `LUXORAI_AUTH_TOKEN` / `LUXORAI_API_KEY` and `LUXORAI_API_ENDPOINT` / `LUXORAI_API_URL` and `LUXORAI_SANDBOX_GATEWAY_URL` are read before the SDK's `TENKI_*` fallback. Explicit options still win.
- `luxorToolkit()`: the same six tools under the `LUXOR` toolkit slug (`LOCAL_LUXOR_CREATE_SANDBOX`, ...). `tenkiToolkit()` and its `LOCAL_TENKI_*` slugs are unchanged.

## 0.1.0 (2026-07-20)

Initial release: `tenkiToolkit()` custom toolkit for Composio with six tools — `CREATE_SANDBOX`, `EXEC_COMMAND`, `LIST_SANDBOXES`, `GET_SANDBOX`, `CREATE_SNAPSHOT`, `TERMINATE_SANDBOX`. Failure-atomic boot, 30-minute max-duration backstop, structured error results, LLM-friendly output truncation.
