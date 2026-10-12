# agent-peers — contributor notes for agents

Read `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md` and `docs/ONBOARDING.md` before changing behavior. The docs are the spec; if code must diverge, update the doc in the same change.

## Layout
- `packages/protocol` — pure: zod schemas, JSON-RPC framing, envelope builder, error codes. No I/O.
- `packages/core` — hub client (reconnect/heartbeat/reattach/retries), inbox journal, control socket, peer-turn gate.
- `packages/hub` — server (Hono + ws + node:sqlite), presence, rooms, grants, invites, asks, rename, admin API, serves dashboard.
- `packages/bridge` — stdio MCP server (`peers_*` tools, hook tool) + per-surface injectors.
- `packages/dashboard` — Preact SPA served by the hub.
- `packages/cli` — `agent-peers` bin (installer, join, hub, invite, shell commands, `mcp`, `hook`).
- `adapters/*` — plugin trees for Claude Code, Codex, Claude Desktop config.
- `test/e2e` — simulated-surface lifecycle tests (CI). `test/live` — real agents (opt-in).

## Conventions
- TypeScript strict, ESM, `.js` extensions in relative imports. Node ≥ 22.13.
- Immutable data: return new objects; never mutate inputs.
- Small files (< 400 lines), small functions (< 50 lines), no deep nesting.
- Validate every external input with the protocol zod schemas at the boundary.
- Never swallow errors; map them to protocol error codes.
- No `any`. No hardcoded secrets. No absolute paths in data sent to the hub.
- Every change ships with tests (Vitest). Keep coverage ≥ 80% per package.
- Tests use ephemeral ports, temp dirs (`fs.mkdtemp`) and `:memory:` SQLite; never touch the real `~/.agent-peers`, `~/.claude`, `~/.codex`.
- Run `pnpm check` before declaring work done.
