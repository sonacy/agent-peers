# agent-peers: contributor notes for agents

Read the docs before changing behavior:
- `docs/ARCHITECTURE.md`
- `docs/PROTOCOL.md`
- `docs/ONBOARDING.md`
- `docs/DASHBOARD.md` (its design source is `docs/design/peers-dashboard-mockup.png`)

The docs are the spec. If the code has to diverge from them, update the doc in the same change.

## Toolchain: Bun only

- **Bun 1.3+** is the runtime, package manager (workspaces, `bun.lock`), test runner (`bun test`) and bundler (`bun build`; `--compile` produces the single-file `agent-peers` binary).
- **TypeScript 5.9** is used only for type checking (`tsc --noEmit`, bundler resolution, `types: ["bun"]`).
- **Biome** for lint and format.
- **Internal packages are consumed from source.** `exports` points to `./src/index.ts`, and nothing is pre-built. Only `packages/cli` is compiled, and `packages/dashboard` is bundled.
- **Prefer Bun-native APIs:**
  - `Bun.serve` for WebSocket and HTTP, with Hono as the router
  - `bun:sqlite`
  - the global `WebSocket` client
  - `Bun.file` / `Bun.write`, `Bun.spawn`, `Bun.password`
  - `crypto.subtle` / `Bun.CryptoHasher` for hashing

  Do not add `ws`, `better-sqlite3` or Node-only servers.

## Layout

| Path | What lives there |
|---|---|
| `packages/protocol` | Pure code: zod schemas, JSON-RPC framing, envelope builder, error codes, names. No I/O. |
| `packages/core` | Hub client (reconnect, heartbeat, reattach, retries), inbox journal, control socket, peer-turn gate. |
| `packages/hub` | `Bun.serve` + Hono + `bun:sqlite`: presence, rooms, grants, invites, knocks, asks, rename, member API, admin API. Serves the dashboard. |
| `packages/bridge` | stdio MCP server (`peers_*` tools, hook tool) and the per-surface injectors. |
| `packages/dashboard` | React 19 + Tailwind v4 + shadcn/ui SPA, bundled by Bun and embedded in the binary. |
| `packages/cli` | The `agent-peers` binary: installer, `join`, `hub`, `invite`, `dashboard`, shell commands, `mcp`, `hook`. |
| `adapters/*` | Plugin trees for Claude Code and Codex, and the Claude Desktop config. |
| `test/e2e` | Simulated-surface lifecycle tests. These run in CI. |
| `test/live` | Real agents. Opt-in: `AGENT_PEERS_LIVE=1`. |

## Conventions

**Code**
- TypeScript strict. Relative imports have no extension (bundler resolution).
- Immutable data: return new objects and never mutate inputs.
- Keep things small: files under 400 lines, functions under 50 lines, no deep nesting.
- Validate every external input with the protocol zod schemas at the boundary.
- Never swallow errors. Map them to protocol error codes.
- No `any`. No hardcoded secrets. Never send absolute paths to the hub.

**Tests**
- Every change ships with tests: `import { describe, expect, it, mock } from 'bun:test'`.
- Coverage must stay at 80% or above (`bun test --coverage`, thresholds in `bunfig.toml`).
- Tests must be isolated from the real environment:
  - ports: listen on `port: 0`
  - temp dirs: `fs.mkdtemp`
  - SQLite: `:memory:`
  - timers: short ones
  - never touch the real `~/.agent-peers`, `~/.claude`, `~/.codex` or Claude Desktop config.

**Before declaring work done:** run `bun run check`, which runs lint, typecheck and test.
