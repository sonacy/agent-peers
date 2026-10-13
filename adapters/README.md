# adapters

The agent plugin trees agent-peers installs into each agent (ARCHITECTURE §4, §6), plus the canonical names
the bridge and the hook entrypoint share with them.

```
adapters/
├── tools.ts              canonical MCP tool list, commands, hook commands (import this from the bridge)
├── skills.ts             renders every SKILL.md for both plugins from PEERS_COMMANDS
├── claude-desktop.ts     Desktop mcpServers entry, merge/remove helpers, server instructions
├── build.ts / build-lib.ts   `bun adapters/build.ts [--check]`
├── validate*.ts          structural checks used by --check and the tests (test/adapters)
├── claude-code/          Claude Code plugin `peers`
├── codex/                Codex plugin `peers` (CLI and desktop)
├── claude-desktop/       Claude Desktop template, instructions, README
└── marketplace/          local Claude Code marketplace `agent-peers` (plugins/ is generated)
```

## Build and check

```sh
bun adapters/build.ts          # regenerate skills + Desktop files, copy claude-code into marketplace/plugins/peers
bun adapters/build.ts --check  # exit 1 if generated files are stale or any tree breaks a rule
bun test test/adapters         # also runs `claude plugin validate --strict` when `claude` is installed
```

Local install for development (from the repo root, after `bun adapters/build.ts`):

```sh
claude plugin marketplace add ./adapters/marketplace
claude plugin install peers@agent-peers
```

Codex has no local marketplace here yet (see "Open issues").

The shims exec `${AGENT_PEERS_BIN:-${AGENT_PEERS_HOME:-$HOME/.agent-peers}/bin/current}`, so point
`AGENT_PEERS_BIN` at a dev build (`packages/cli/dist/agent-peers`) to try a local binary.

## Canonical names (`tools.ts`)

| Export | Meaning |
|---|---|
| `PEERS_TOOLS` / `PEERS_TOOL_NAMES` | Every MCP tool the bridge registers: 13 user tools, `peers_reply` and `peers_progress` (agent), and the hidden `peers_hook` (Codex hooks only). |
| `PEERS_COMMANDS` | The 13 commands → tool, argument hint, description, and `userOnly` (join, room, leave, invite, knock, dashboard). |
| `AUTO_APPROVED_TOOLS` | `peers_reply`, `peers_progress`: the only tools a hook or approval config may auto-approve. |
| `NEVER_AUTO_APPROVED_TOOLS`, `PEER_TURN_DENIED_TOOLS` | ARCHITECTURE §8.4 and §8.3, for the bridge's gate. |
| `CLAUDE_HOOK_COMMANDS` | The `agent-peers hook <cmd> --agent claude-code` subcommands the CLI must implement. |
| `CODEX_HOOK_EVENTS`, `HOOK_TOOL_NAME` | The events Codex sends to `peers_hook`. |
| `claudeCodeToolName`, `codexToolName` | `mcp__plugin_peers_peers__<tool>` and `mcp__peers__<tool>`. |

## Decisions

**Plugin name `peers`, marketplace `agent-peers`.** Commands are `/peers:ask` (Claude Code) and `$peers:ask`
(Codex). Claude Code's built-in `/peers` alias of `/list-agents` still needs a live coexistence test
(ARCHITECTURE §10.4); renaming is a one-line change in `tools.ts` plus the manifests.

**One shim, exec'd.** `bin/agent-peers` is a POSIX `sh` script that `exec`s the installed binary with `"$@"`,
so hooks keep the agent as an ancestor PID (control-socket discovery, ARCHITECTURE §5). If the binary is
missing it exits **1**, never 2: exit 2 from a Claude Code hook blocks the prompt or the stop. The same file
ships in both plugins; a test keeps them identical.

**Cursor no-op lives in the shim.** Cursor imports Claude Code plugins and runs their hooks. When the shim
runs `hook …` with `CURSOR_VERSION` set, it prints `{}` and exits 0 without starting the binary. Non-hook
commands (the MCP server) still run; the bridge refuses Cursor at MCP `initialize` (ARCHITECTURE §6.2). The
hook entrypoint should also no-op when hook stdin carries `cursor_version`.

**Claude Code hooks (`claude-code/hooks/hooks.json`).** Every handler uses exec form
(`command` = `${CLAUDE_PLUGIN_ROOT}/bin/agent-peers`, `args` = `hook <cmd> --agent claude-code`), which the
hooks reference recommends for path placeholders.

| Event | Handlers | Notes |
|---|---|---|
| SessionStart (every source, no matcher) | `session-start` (sync, 15 s) + `wait` | Register; the waiter arms the wake path. |
| UserPromptSubmit | `user-prompt-submit` (10 s) | Activity busy; `take` fallback as `additionalContext`. |
| Stop | `stop` (10 s) + `wait` | `turn_end`, reply nudge once via `decision: "block"`, then re-arm. |
| StopFailure | `stop-failure` (10 s) + `wait` | Output is ignored by Claude Code; used for activity/`turn_end` and to re-arm. |
| Notification (`permission_prompt\|elicitation_dialog\|elicitation_url_dialog`) | `notification` (10 s) | `awaiting_input`. `idle_prompt` is deliberately not matched. |
| PermissionRequest (`^mcp__plugin_peers_peers__peers_(reply\|progress)$`) | `permission-request` (10 s) | Auto-allow only the reply tools. Skills' `allowed-tools` would not cover a later peer turn. |
| PreToolUse (all tools) | `pre-tool-use` (10 s) | Peer-turn gate; applies in bypass mode too. |
| SessionEnd | `session-end` | Shares Claude Code's 1.5 s budget; plugin timeouts cannot raise it. |

`wait` is `async: true` + `asyncRewake: true` with `timeout: 86400`. Claude Code enforces the timeout for
asyncRewake hooks (default 600 s), and exit 2 wakes an idle session with the hook's stderr as a system
reminder. The waiter's long-poll must end before the timeout; it is re-armed by the next Stop/StopFailure.
`claude plugin validate --strict` passes (2.1.296).

**Codex hooks are `mcp_tool` handlers, declared inline** in `.codex-plugin/plugin.json` as
`"hooks": { "hooks": { … } }`, the shape OpenAI's bundled plugins ship. They call `peers_hook` on the
already-connected `peers` server with input templated from the event (`${session_id}`,
`${hook_event_name}`, `${cwd}`, `${model}`; `${turn_id}` only on turn-scoped events, because SessionStart
has none; plus `${source}`, `${last_assistant_message}`, `${stop_hook_active}`, `${tool_name}`,
`${tool_input}` where they exist). A placeholder that fills a whole value keeps its JSON type. SessionStart
may run before the server is ready and is then skipped, so the bridge must register implicitly on the first
UserPromptSubmit/Stop (ONBOARDING §4). Details and the `approval_mode = "approve"` guidance:
[`codex/README.md`](codex/README.md).

**Codex MCP launch.** `mcp.json` uses `./bin/agent-peers` because Codex only accepts a bare command or a
contained `./` path. Codex resolves that path against the server's `cwd`, which defaults to the thread's
workspace, so `cwd` is `"."` (the plugin root, as OpenAI's bundled plugins do; without it the server fails
with `No such file or directory`, live-verified on 0.160.1). The bridge takes the workspace from the hooks'
`cwd`, never from its own. Codex forwards only a small default environment to MCP servers, so `env_vars`
names `CODEX_HOME`, `CODEX_CLI_PATH`, `AGENT_PEERS_HOME` and `AGENT_PEERS_BIN`: the bridge's `codex queue`
must reach the same CODEX_HOME, and a custom agent-peers home must survive. `tool_timeout_sec: 120` covers the
45 s `peers_ask` wait and the ~50 s `peers_wait` long-poll. Codex desktop uses the same tree with
`--surface codex`; the bridge detects the desktop at runtime.

**Skills are generated.** `skills.ts` renders 13 skills per plugin from `PEERS_COMMANDS`: Claude Code gets
`$ARGUMENTS`, `argument-hint` and `disable-model-invocation: true` for the six user-only commands; Codex gets
`name` + `description`, no `$ARGUMENTS` (Codex does not substitute it), and
`agents/openai.yaml` with `policy.allow_implicit_invocation: false` for the same six. Each skill names one
tool, tells the model not to invent handles or invites, and repeats the untrusted-input rule.

**Claude Desktop.** `claude-desktop.ts` owns the `agent-peers-desktop` entry
(`<abs binary> mcp --surface claude-desktop`), an immutable merge that keeps every other key, removal, and
`DESKTOP_SERVER_INSTRUCTIONS` (check `peers_inbox` at the start of every turn). The bridge should import
that constant for its `initialize` instructions. See [`claude-desktop/README.md`](claude-desktop/README.md).

**Local marketplace.** A marketplace entry's `source` may not contain `..`, and symlinks only warn and are
skipped, so `bun adapters/build.ts` copies `claude-code/` to `marketplace/plugins/peers` (gitignored).

## Open issues

- **Root typecheck.** `adapters/*.ts` and `test/adapters` are outside the workspaces; typecheck them with
  `bunx tsc --noEmit -p adapters/tsconfig.json` until the root `typecheck` script includes it.
- **Docs drift.** ARCHITECTURE §4 still shows the Desktop entry as `<abs node> <runtime>/bridge.js`; the
  single-binary form here (`<abs binary> mcp --surface claude-desktop`) matches §9 and ONBOARDING §3.
- **Published marketplace.** ARCHITECTURE §4 installs with `claude plugin marketplace add <owner>/agent-peers`,
  which needs a `.claude-plugin/marketplace.json` at the repo root (source `./adapters/claude-code`). Codex
  reads its own marketplace layout (`.agents/plugins/marketplace.json`, format not yet verified).
- **Windows.** The shim is POSIX `sh`; Claude Code's exec form needs a real executable on Windows. A
  `bin/agent-peers.cmd` or a direct path to the installed `.exe` is needed before Windows support.
- **claude.ai / Cowork** refuse plugins with a top-level `bin/`; this plugin targets Claude Code only.
- **`peers_hook` visibility.** MCP has no hidden tools, so the model sees `peers_hook`. Its description must
  say "never call"; whether Codex can call a tool excluded via `disabled_tools` is unverified.
- **Live tests still needed:** Codex templating of missing fields and the `$peers:ask` mention parse in the
  Codex TUI. Plugin-level `approval_mode`, `mcp_tool` hooks, `codex queue` push and `exec resume` are
  live-verified on 0.160.1 (`codex/README.md`, "Live-verified").
