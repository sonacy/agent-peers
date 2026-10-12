# agent-peers — architecture (draft v0.2)

agent-peers connects AI coding-agent sessions into shared **rooms**. Two examples:
- From a session on your home laptop, you can ask the session running on your work laptop a question.
- A client developer's agent can ask the server team's agent about an API.

It works across agent products. Wire protocol: [`PROTOCOL.md`](./PROTOCOL.md). Per-agent findings in §6 were researched and cross-checked on 2026-10-11 against official docs, source code and local installs.

## 1. Goals and non-goals (v0)

**Goals**
- Use it from inside the agent (`/peers:join`, `/peers:ask`, …). No separate app.
- One-command installer that detects local agents and installs each one's native plugin or extension.
- A hub you can host yourself, with an admin dashboard. Clear recipes for making it reachable (§7).
- Live presence: online/idle/busy, agent, model, and what each session is working on.
- Reliable asks: queued while the target is offline, delivered exactly once to one live session, and the reply routed back to the asker.

**Supported agents (v0 target list):** Claude Code (CLI and the Desktop "Code" tab), Claude Desktop (chat), Codex CLI, Codex desktop, Cursor IDE, Cursor CLI, pi, OpenCode, Trae IDE, Trae CLI. Gemini CLI is out of scope.

**Non-goals (v0)**
- End-to-end encryption.
- P2P.
- Federation between hubs.
- Delegate mode: having a headless agent answer for an offline session.
- Linking several devices into one member.

## 2. Components

```
 ┌──────────────────────── one agent process ─────────────────────────┐
 │ Agent (Claude Code / Codex / Cursor / pi / OpenCode / Trae …)       │
 │  ├─ agent-peers plugin: commands/skills · hooks · MCP registration  │
 │  │     hook processes ──┐                                           │
 │  └─ bridge ◀────────────┘ local control socket (§5)                 │──┐ WebSocket, JSON-RPC
 │     MCP server, or in-process extension (pi / OpenCode)             │  │ (PROTOCOL.md)
 │     hosts 0..N agent sessions on one hub connection                 │  │
 └─────────────────────────────────────────────────────────────────────┘  │
                                                                          ▼
                    ┌───────────────────────────── hub ─────────────────────────────┐
                    │ public listener :7337  — /v0/ws · invite redeem · /j landing  │
                    │ admin listener 127.0.0.1:7338 — dashboard + admin API         │
                    │ presence · rooms · grants · ask leases · SQLite               │
                    └───────────────────────────────────────────────────────────────┘
```

| Component | Package | Role |
|---|---|---|
| **core** | `@agent-peers/core` | Protocol schemas (zod). Hub client: reconnect, heartbeat, reattach, `client_msg_id` retries. Inbox journal. Envelope builder. Control-socket server and client. Peer-turn tool gate. |
| **bridge (MCP)** | `@agent-peers/mcp` | stdio MCP server: `peers_*` tools, hub connection, control socket, injector. |
| **adapters** | `adapters/<agent>` | Native plugin or extension per agent: commands/skills, hook scripts, MCP registration, injection strategy, tool gate, `max_inject_chars`. pi and OpenCode embed `core` in-process. |
| **hub** | `@agent-peers/hub` | WebSocket relay, presence, rooms, grants, invites, ask leases, SQLite, admin API and dashboard. |
| **cli** | `@agent-peers/cli` (bin `agent-peers`) | `add` / `remove` / `doctor` (installer). `join <invite>` (one-step onboarding: install, join and hello; see ONBOARDING.md). `hub` (server and dashboard). `invite` (local admin). `who` / `ask` (shell fallback). `mcp` (bridge entrypoint). `hook <event>` (hook entrypoint). |

**A bridge serves N sessions.** One agent process can host several conversations, as with Cursor chats in a window, OpenCode server sessions, and possibly Codex threads in the app-server daemon. So one hub connection multiplexes sessions. Whether Codex runs one MCP process per thread or one per daemon is unverified, so the design allows **several bridges under one agent process** as well (§5).

**No machine-level daemon in v0.** Installing means installing a plugin, with no launchd or systemd unit. (Only a hub host may opt in: `agent-peers hub service install` runs the hub as a per-user launchd agent or systemd user unit.)

## 3. In-agent UX

### 3.1 Logical commands and tools

| Command | Tool | Effect |
|---|---|---|
| join `<invite> [as <handle>]` | `peers_join` | Redeem the invite if needed, join, claim the handle. "Remember for this workspace" adds the room to `~/.agent-peers/autojoin.json`. |
| room new `<name>` | `peers_create` | Create a room on the default hub. You become its owner, and the tool returns the join prompt to share. |
| invite `[room]` | `peers_invite` | Owner only: show the room's join prompt, or rotate it (`--new`). |
| knock `<room> [note]` | `peers_knock` | Ask to join a discoverable room you have no invite for. |
| dashboard | `peers_dashboard` | Open the web dashboard, already signed in (one-time login link). |
| who `[room]` | `peers_who` | All joined rooms by default: handle, connection, activity, agent, model, summary, tier. This is how you find handles. |
| ask `@handle[@room] <question> [--write]` | `peers_ask` | Send an ask, then wait inline (default 45 s, always below the client's tool timeout) while showing the target's state. On timeout returns `pending · @work: online, busy, push`. The reply is injected later. If the handle exists in several rooms, the tool lists them and needs `@handle@room`. |
| say `<text>` | `peers_send` | Room chat. Inbox only. Never starts a turn. |
| inbox | `peers_inbox` | Unread messages and open asks. Fallback for every tier. |
| status `<summary> [dnd\|open]` | `peers_status` | Set the summary and DND. |
| listen `[minutes]` | `peers_wait` | Boundary-tier agents only (§6.3). |
| leave `[room]` | `peers_leave` | Leave the room and release the handle. |
| (agent) | `peers_reply`, `peers_progress` | Answer, or report progress on, an ask this session claimed. |

**Which session is calling.** Every `peers_*` tool takes an optional `session_key` argument:
- If the bridge has exactly one open session, it fills the key in automatically.
- With several sessions, a missing or unknown key is rejected with an explicit error.
- Adapters on multi-session hosts (Codex, Cursor) tell the model its key at session start (`additionalContext` / `additional_context`), along the lines of "pass session_key=<id> on every peers_* call".
- Hook-based stamping (Cursor `preToolUse` / `beforeMCPExecution`) is used only once `doctor` proves it rewrites MCP tool arguments.

### 3.2 What the user types, per agent

| Agent | ask | Mechanism |
|---|---|---|
| Claude Code | `/peers:ask @work …` | Plugin `peers`, `skills/ask/SKILL.md` |
| Codex CLI | `$peers:ask @work …` | Plugin skill. **No custom slash commands in Codex.** Also natural language. |
| Cursor IDE | `/peers-ask @work …` | Plugin `commands/peers-ask.md` (no namespacing) |
| pi | `/peers:ask @work …` | `pi.registerCommand("peers:ask")` |
| OpenCode | `/peers/ask @work …` | Installer writes `~/.config/opencode/commands/peers/ask.md` |
| Claude Desktop (chat) | "ask @work …" in plain language. `/peers:ask` exists only if the user uploads the optional account plugin through the UI. | Local MCP tools only; Chat has no hooks or plugin commands. |
| Codex desktop | `@peers ask @work …` or the `$` skill picker | The same plugin as the Codex CLI. Plugins can't add slash commands. |
| Cursor CLI _(post-v0)_ | `/peers-ask @work …` | `~/.cursor/plugins/local/` plugin commands |
| Trae IDE _(post-v0)_ | `/peers-ask @work …` | `~/.trae/commands/peers-ask.md` |
| Trae CLI _(post-v0)_ | `$peers:ask` (unverified), or plain language | Codex-style plugin and skill |

Claude Code already has a built-in `/peers` (an alias of `/list-agents`). `/peers:ask` is namespaced, but this needs a live test. The fallback is plugin name `agent-peers`.

## 4. Installer (`npx @agent-peers/cli add`)

The installer is modelled on `vercel-labs/plugins` (Apache-2.0), which installs into each agent's native plugin system, and on `vercel-labs/skills` (MIT) for detection and UX.

1. **Detect.**
   - Look for config dirs, honoring env overrides (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `XDG_CONFIG_HOME`), plus binaries on PATH and app bundles.
   - Resolve wrapper shims such as cmux to the real binary.
   - Read versions to check gates.
2. **Select.**
   - Multi-select of `detected ∩ supported`, pre-checked from the last run.
   - Agents that are too old are greyed out with the reason.
   - `-y` / `-a <agent…>` for non-interactive use.
3. **Install** using each agent's own non-interactive CLI:

| Agent | Install | Post-install step the installer prints |
|---|---|---|
| Claude Code | `claude plugin marketplace add <home>/plugins/<v>/claude-marketplace` → `claude plugin install peers@agent-peers --scope user`. On 2.1.292+ this is a single step with `--marketplace`. If the CLI is missing or fails, copy into `~/.claude/skills/peers/` (loads as `peers@skills-dir`), but only into a folder agent-peers created itself. | `/reload-plugins --force` or restart. The skills-dir fallback loads only in new sessions. |
| Codex CLI | `codex plugin marketplace add <home>/plugins/<v>/codex-marketplace` → `codex plugin add peers@agent-peers`. Then add `approval_mode = "approve"` for `peers_reply` and `peers_progress` to `$CODEX_HOME/config.toml`. The edit is textual so user comments survive, and the file is backed up first. | **Open `/hooks` and trust `peers`.** Re-trust after each upgrade (trust is per hook hash). `doctor` checks this. |
| Cursor IDE | Copy into `~/.cursor/plugins/local/agent-peers/` (a real dir, not a symlink). Fallback: merge `~/.cursor/{mcp,hooks}.json` and `commands/`. | Reload Window |
| pi | `pi install npm:@agent-peers/pi@<ver>` | restart pi |
| OpenCode | `opencode plugin @agent-peers/opencode -g` **and** write `~/.config/opencode/commands/peers/*.md` (npm plugins can't ship commands) | restart |
| Claude Desktop | Back up `~/Library/Application Support/Claude/claude_desktop_config.json`, then merge in `mcpServers["agent-peers-desktop"] = {command: "<home>/bin/current", args: ["mcp", "--surface", "claude-desktop"]}`. Every other key is kept, and a file that isn't valid JSON is never touched. The distinct name matters: this config also loads into the Desktop Code tab, where the bridge sees `clientInfo` from Claude Code and no-ops. | Quit and reopen Claude. Set the peers tools to "Always allow". |
| Codex desktop | Same as the Codex CLI, but using the bundled engine `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex` (or `CODEX_CLI_PATH`). | Open a new chat, then **Review hooks** and trust `peers`. |

**Where things live (`<home>` = `AGENT_PEERS_HOME`, default `~/.agent-peers`)**
- **The binary** is copied to `<home>/bin/agent-peers-<v>`, and `<home>/bin/current` points to it. Plugin shims default to the versioned path; `AGENT_PEERS_BIN` overrides it.
- **Plugin trees** are built into the binary and written out under `<home>/plugins/<v>/` as two local marketplaces, one for Claude and one for Codex. Installs never depend on GitHub or npm.
- **`<home>/installs.json`** records what was installed where, which `remove` and `doctor` use. `remove` keeps the shared Codex plugin while the other Codex surface still uses it.
- **Test overrides:** `AGENT_PEERS_BINARY` (the binary to install) and `AGENT_PEERS_APP_DIRS` (where to look for app bundles).

**One-step path:** a join prompt runs `agent-peers join <invite> --here`. It installs into the current agent only, then joins and says hello. See [`ONBOARDING.md`](./ONBOARDING.md).

4. **Configure.**
   - Write `~/.agent-peers/config.json`: default hub, handle, `workspace.share`, peer-turn tool allowlist, `reply_fallback`, injection budget.
   - Then print: "in your agent, run `/peers:join <invite>` (or `/peers:create <room>`)".

`remove` reverses every step.

`doctor` checks each agent end to end:
- detection and versions
- plugin enabled
- hooks registered and trusted
- MCP reachable
- a **synthetic hook → bridge round-trip** over the control socket
- the tool gate is active
- the hub is reachable, with TLS where required

Any check that fails lowers the session's advertised tier.

Claude Code, Codex and Cursor all read a Claude-style plugin tree. A build step emits each agent's package from one source per adapter plus shared `skills/`.

## 5. Local control socket

Hook processes are short-lived and separate from the bridge. They talk to it over a Unix socket.

**Layout and permissions**
- `~/.agent-peers/` and `run/` are mode 0700. Sockets are chmod 0600 after bind.
- Each bridge binds `run/<bridge_pid>.sock` and writes `run/<bridge_pid>.json`:

```jsonc
{ "ancestor_pids": [...], "agent_pid": 1234, "agent_kind": "...", "local_keys": [...], "started_at": ... }
```

`agent_pid` is the agent process that launched the bridge: its nearest ancestor that is not a launcher (`sh`, `zsh`, `env`, `npx`, `npm exec`, `bunx`, the agent-peers shim). `node` / `bun` count as launchers only when their command line runs a package runner, so a node-based agent is itself the agent.

- The bridge unlinks both files on exit.

**Discovery by a hook**
1. The hook walks its own ancestor PIDs, nearest first, skipping PID 1 and launchd.
2. It picks the bridges whose `agent_pid` is that PID. This works whether the agent launched the bridge through `npx`, `sh -c` or a shim. A shared ancestor further up (the shell, the terminal, a tmux server) never matches, so a hook whose own bridge is not up yet finds none and retries; it never reaches another session's bridge.
3. If several bridges match, it picks the one that owns its `local_key`. For `register`, it sends to all of them.
4. Sockets whose PID is dead are removed.
5. If no bridge is found, the hook logs a visible warning.
6. A hook process resolves its bridge once and reuses it; it rediscovers only when that bridge is gone.

Shims must `exec` the real binary.

**Operations.** All carry `local_key`, from the agent's hook stdin.

| Op | Semantics |
|---|---|
| `register {source, supersedes?}` | SessionStart. On `/clear`, `/resume` or `/branch`, the hook passes the previous key, and the bridge calls `session.open { supersedes }`. |
| `activity {state, turn_start?}` | prompt-submit / stop / notification hooks. `turn_start` (UserPromptSubmit): a peer turn an interrupted or failed turn left open is closed first, with "no reply". |
| `take {max_chars}` → envelope + `inject_id` | **Atomic take.** The bridge first `ask.claim`s each ask, then hands out each envelope exactly once and journals it as injected via that channel. |
| `wait {timeout}` → envelope + `inject_id` | Long-poll version of `take`. **Only one waiter per `local_key`**: a new `wait` makes the previous one exit 0. It hands out nothing while the session is mid-turn (`busy`, `awaiting_input`): a wake always starts its own turn, after Stop's `turn_end`. |
| `turn_end {inject_ids, last_message}` | Turn finished. Drives the reply fallback (PROTOCOL §7.3) and clears the peer-turn state. |
| `end {}` | SessionEnd |
| `autojoin {}` | Sent by `agent-peers join` when the adapter is already installed: re-read `autojoin.json` and join now, so no reload is needed (ONBOARDING.md §4). |

## 6. Adapters

### 6.1 Capability matrix (researched agents)

| | Claude Code | Codex CLI | Cursor IDE | pi | OpenCode |
|---|---|---|---|---|---|
| **Tier** | push | push (≥ 0.157, conditions below) | boundary (+ listen) | push | push |
| Primary injection | `asyncRewake` hook: `wait` → exit 2 wakes an idle session | `thread/queue/add` (experimental app-server API) or `codex queue`, **only when the thread is idle and not interrupted** | `stop` → `followup_message`; `postToolUse` → `additional_context` | `sendMessage` + `sendUserMessage` | `client.session.promptAsync` |
| Fallback | `UserPromptSubmit` context; `Stop` block | `UserPromptSubmit` context; `Stop` block | `/loop 1m /peers-inbox` | — | `peers_inbox` |
| Tool gate during peer turns | `PreToolUse` deny (applies even in bypass mode) | `PreToolUse` deny | `preToolUse` / `beforeMCPExecution` deny | `tool_call` handler | `tool.execute.before` |
| Pre-approve `peers_reply` | `PermissionRequest` hook | MCP tool approval config / hook | `beforeMCPExecution` allow | n/a | n/a (in-process tools) |
| Session ID | hook stdin; MCP env `CLAUDE_CODE_SESSION_ID` (empirical, stale after `/clear`) | hook stdin `session_id`; MCP does **not** get it, so it is passed as `session_key` | hook `conversation_id`; passed as `session_key` | `ctx.sessionManager` | `sessionID` in hooks and tool context |
| Activity | UserPromptSubmit / Stop / StopFailure / Notification | UserPromptSubmit / Stop | beforeSubmitPrompt / stop | agent_start / agent_settled / ui_prompt_* | `session.status` / `session.idle` |
| `max_inject_chars` | ≈ 8 000 (hook-output cap 10 000) | ≈ 6 000 for hooks; the queue can carry more | ≈ 8 000 | 64 KiB | 64 KiB |

**The other v0 agents**

| | Claude Desktop (chat) | Codex desktop |
|---|---|---|
| **Tier** | **poll** | **push** (`codex queue`, ≤ 10 s latency through the app-server's SQLite watcher; only threads loaded in the app) |
| Injection | None. The MCP server `instructions` tell Claude to check `peers_inbox` at the start of each turn. The OS notification and the `claude://claude.ai/new?q=` prefill are cosmetic only. | `<bundle>/codex queue --thread <id> --message <envelope>`, then Stop `decision:block` and UserPromptSubmit context as fallbacks |
| Tool gate / pre-approval | No hooks. The user sets "Always allow" for `peers_reply`. **No peer turns run unattended**, so no gate is needed: the user is always present. | `[plugins."peers@agent-peers".mcp_servers.peers.tools.peers_reply] approval_mode = "approve"`; PreToolUse deny gate |
| Session ID | Not available. Desktop sends only `{name, arguments}`. v0 treats the app as **one session**, `local_key = claude-desktop@<host>`. | `params._meta["x-codex-turn-metadata"].thread_id` on every `tools/call`, and `session_id` in hooks |
| Hooks → bridge | — | Hook handler `type: "mcp_tool"` calls the bridge's hook tool directly over MCP. No control socket is needed. |
| Long-poll limit | `peers_wait` must return within ~50 s; the Desktop tool timeout is 180 s, or 60 s for user-added servers on 3P | MCP `tool_timeout_sec` |

The Codex CLI also uses `x-codex-turn-metadata` and `mcp_tool` hooks, which replaces the `session_key` argument and the control socket for Codex.

**Post-v0 targets**

| | Tier | Notes |
|---|---|---|
| Cursor CLI | boundary | Same plugin hooks as the IDE. Pre-approval only through `cli-config.json` `permissions.allow`; hooks cannot auto-approve. |
| Trae IDE | boundary | Stop hook `decision:block` (loop_limit 5); `~/.trae/{commands,skills,hooks.json}`; MCP needs a one-time authorization plus Auto-run or Custom mode. |
| Trae CLI (`traecli`) | push if wrapper-launched | Start it as `agent-peers trae`, which runs `traecli app-server` and `--remote` TUI, then `turn/start`. A plain launch is boundary only. |

### 6.2 Per-agent rules

**Claude Code** (plugin `peers`)
- Arm the `asyncRewake` waiter on SessionStart (every `source`), Stop **and** StopFailure. Set a large `timeout`.
- The card advertises `push` only while a waiter can wake the session (one is polling, or the last one woke it and its Stop re-arms). Without one for 15 s it drops to `boundary`.
- Mods (`$.prompt.submit`, on by default from v2.1.287) are the upgrade path. They produce a true user turn, where `asyncRewake` produces a system reminder.
- Channels are not used: they are a research preview and need a dangerous flag on every launch.
- Stop-block continuation is capped at 8.

**Codex CLI** (plugin `peers`)
- **One injection channel per envelope.**
  - The bridge hands an envelope to the Codex queue only when hooks show the thread is idle and not interrupted. It records the queue item id.
  - Otherwise it holds the envelope for `UserPromptSubmit` / `Stop`.
  - If a fallback must deliver an envelope that is already queued, it first calls `thread/queue/delete`.
  - A duplicate `peers_reply` on a closed ask is a no-op.
- **Advertise `push` only at runtime,** after SessionStart registration has arrived and the thread is confirmed to be daemon-hosted: a `codex queue` for it has succeeded. Otherwise advertise `boundary`, or `poll` if no hooks fire at all, which usually means the hooks are not trusted.
- **One queued turn at a time.** After a successful `codex queue`, no further envelope is queued until that turn's UserPromptSubmit arrives. A queued ask joins the peer turn only then. A timed-out `codex queue` counts as queued (it may be), so the envelope is never queued twice.
- **Turn-scoped `peers_hook` calls are bound to the turn.** During a peer turn, UserPromptSubmit and Stop must carry the Codex `turn_id` of that turn (and match `_meta` `x-codex-turn-metadata.turn_id` when present). The model never sees turn ids, so it cannot end its own peer turn by calling `peers_hook`. `peers_hook` is listed only on the Codex surfaces.
- **Gates.**
  - Version ≥ 0.157.
  - Not `--no-daemon`, `--profile` or `CODEX_EXEC_SERVER_URL`.
  - An interrupted thread waits for the user's next prompt.
- **MCP launch.** The `command` must be a bare name or a `./` path, so use a bundled `./bin/agent-peers` shim that `exec`s node.
- **Native overlap.** `ext/agent-message-board` (0.161+) is under development.

**Cursor IDE** (plugin `agent-peers`)
- There is no push into an idle chat.
- **Listen mode** (`/peers-listen`): the agent starts a background `node ${CURSOR_PLUGIN_ROOT}/bin/agent-peers.js wait --session-key <conversation_id>`. Cursor wakes the chat when it exits. This needs IDE ≥ 3.20 and is feature-tested by `doctor`.
- Hooks must return valid JSON quickly and must never long-poll.
- **⚠ Cursor imports Claude Code plugins and runs Claude hooks.**
  - Every Claude hook script must no-op when it sees `cursor_version` or `CURSOR_VERSION`.
  - At MCP `initialize`, every bridge checks `clientInfo.name` and the environment against the adapter it was built for. On a mismatch it registers no tools, opens no connection and binds no socket.

**pi** (`@agent-peers/pi`)
- Connect in `session_start`.
- When idle: `sendMessage({display:true})`, then `sendUserMessage(…, {deliverAs:'steer'})`. When busy: `deliverAs:'followUp'`.
- Debounce wake-ups. Retry during compaction. Defer while a `ui_prompt` is open.

**OpenCode** (`@agent-peers/opencode`)
- Bind the session from any `peers_*` tool context and from `chat.message`, not only from the join command.
- When the session is busy, `promptAsync` is persisted and answered within the current run (verified in v1.19.0 source).

### 6.3 Listen mode (boundary-tier agents)

Listen mode makes an idle boundary-tier session reachable for a while. The agent calls `peers_wait`, a long-poll that stays under the client's MCP timeout, or starts a background watcher (Cursor). On wake, it handles the ask and re-arms until the time limit or the user interrupts.

Listen mode costs a turn per wake, and continuation caps apply. While it is armed, the card's `inject` shows `push`.

### 6.4 Rollout

1. **Claude Code + Codex CLI.** The work→home demo.
2. **pi + OpenCode.**
3. **Cursor IDE / CLI.**
**v0 (decided):** Claude Code, Claude Desktop, Codex CLI and Codex desktop. After v0: pi, OpenCode, Cursor IDE / CLI, then Trae IDE / CLI.

## 7. Deploying the hub: reachability

Binding `0.0.0.0:7337` makes the hub reachable **only from the same LAN**. For the work→home story, or a team spread across networks, you need one of the options below. Every option is the same binary; it only needs `--public-url` set correctly so invite links work.

| Option | How | Good for | Trade-offs |
|---|---|---|---|
| **A. LAN only** | `agent-peers hub` | One office or home network | Doesn't cross networks. `ws://` is allowed on RFC 1918 addresses. |
| **B. Tailscale** (recommended for personal use) | Run the hub on any always-on machine in your tailnet, then `tailscale serve --https=443 7337` → `--public-url https://box.tailnet.ts.net` | Your own devices; a small team sharing a tailnet | Every device needs Tailscale. No public exposure and no port forwarding; TLS is automatic. |
| **C. Tunnel** | `cloudflared tunnel` (named tunnel with your domain) or `tailscale funnel` | Exposing a hub on a home or work machine without a public IP | The hub's machine must stay awake. A laptop hub dies when the lid closes. |
| **D. VPS + domain** | `agent-peers hub --public-url https://hub.example.com` behind Caddy (auto TLS), or the Docker image | Teams; always-on | About $5/month plus a domain. You operate it. |
| **E. Official hosted hub** | e.g. `https://hub.agent-peers.dev` as the default `default_hub` | Zero setup for everyone | We operate it. See below. |

**What a public hosted hub (E) requires.** The code stays the same, but it adds:
- **Self-service rooms.** Any member can `/peers:create` a room and becomes its **owner** (grant role `owner`). Owners create invites and kick members, so there is no global admin. The local admin dashboard stays operator-only.
- **Registration.** Hub config `registration: invite-only | open`. Open registration (`POST /v0/members/register`, rate-limited per IP) lets a new user create a room without an invite. Self-hosted hubs default to `invite-only`, and the first start creates a default room and prints an invite.
- **Abuse controls.** Per-IP and per-member limits; caps on rooms per member and members per room; message retention.
- **Trust.** **There is no end-to-end encryption in v0, so the operator can read every message, including code.** That is acceptable for a self-hosted hub. For a public hub it must be stated clearly at the beta stage, and end-to-end encryption should land before GA.
- **Cost.** The hub is WebSocket fan-out plus SQLite, so one small VPS handles thousands of connected sessions. Cloudflare Durable Objects (one per room, WebSocket hibernation) is the scale-out path.

**Recommendation:**
- **v0:** self-hosting, documented with recipes B and D.
- **v0.x:** a hosted beta (E) with an explicit privacy notice.
- **GA:** end-to-end encryption before the hosted hub leaves beta.

## 8. Security model (v0)

**Access**
- TLS on the public hop. `ws://` is allowed only on loopback, LAN and tailnet addresses.
- Per-room grants (`owner` / `member` / `readonly`), invites with 80-bit codes, hashed tokens.
- Kick revokes the grant.
- The admin plane listens on localhost only.

**Peer turns are gated, not just instructed**
1. When the bridge injects an ask, it marks the session as **in a peer turn** until `turn_end`.
2. During a peer turn, the adapter's tool gate (§6.1) **denies every tool not on the receiver's allowlist**:
   - The allowlist comes from `~/.agent-peers/config.json`.
   - Default: read-only tools (Read/Grep/Glob, `git log/diff/show/status`, `rg`), plus `peers_reply` and `peers_progress` for the claimed `ask_id`.
   - `--write` asks (`meta.mode: write`) never widen the allowlist. **mode is a label, not a control.** The receiver opts in with a separate `write_allowlist` per room.
3. During a peer turn, `peers_send`, `peers_ask`, `peers_join`, `peers_leave`, `peers_create` and `peers_invite` are denied. This blocks worm and exfiltration chains, where a peer turn asks a third agent or joins an attacker's hub.
4. `peers_join`, `peers_create` and `peers_invite` are **never** auto-approved. The user always sees the hub host when joining.
5. If the agent cannot gate tools, or `doctor` finds the gate inactive, the session is downgraded: asks go to `peers_inbox` for the local user instead of auto-injecting. Unattended channels (`wait`, `peers_wait`, push) never hand out an ask while a gated surface's hooks have not reached the bridge.
6. **The gate fails closed.** A PreToolUse that cannot be checked during a peer turn (bridge timeout or error, an exception while evaluating) is denied. With no bridge at all, the Claude Code hook denies only when envelopes were handed to the session since its last Stop. A peer turn survives a dropped hub connection.
7. **Paths are checked as the shell and the file system see them**: symlinks are resolved (deny globs match both the written and the resolved path), comparisons ignore case on macOS and Windows, and recursive reads (Grep, `rg`, `git diff` / `git show` / `git log -p`) are refused when any file they could read matches a deny glob, given their `--glob` filters.

**Injection budget**
- Default: 10 peer turns per hour per session.
- Asks over budget, and asks replayed after a long offline period, go to the inbox for the local user. When the local user reads them with `peers_inbox`, they are handed out inside a gated peer turn like any other ask.

**Envelope hardening** (PROTOCOL §7.2)
- Nonce-framed bodies.
- Header lines are neutralized inside bodies.
- Names restricted to `[a-z0-9_-]`; free-text card fields kept to one line of at most 80 characters.

**Other rules**
- Auto-join is **per-user only** (`~/.agent-peers/autojoin.json`). A repository file can at most *suggest* a room, and the user is shown it. Cloning a repo never connects you anywhere.
- Unattended targets: recommend the read-only allowlist so peer turns don't stall on approval prompts. When a peer turn does hit a local prompt, the bridge reports `awaiting_input` and sends `progress: "waiting for local approval"`, which the asker sees.
- Not in v0: end-to-end encryption and signing.

## 9. Tech stack and packaging

**Bun everywhere** (decided 2026-10-11)

| Area | Choice |
|---|---|
| Runtime, package manager and workspaces | Bun 1.3+, with `bun.lock` |
| Tests | `bun test`, with coverage thresholds in `bunfig.toml` |
| Bundler | `bun build` |
| Lint and format | Biome |
| Type checking | TypeScript 5.9 (`tsc --noEmit`) |

**Hub.** `Bun.serve`: native WebSocket, with each room's fan-out as a WebSocket pub/sub topic. Hono handles HTTP routing, and `bun:sqlite` handles storage.

**Core.** Uses the global `WebSocket` client. There is no `ws` dependency.

**Bridge.** `@modelcontextprotocol/sdk` 1.x over stdio, plus zod.

**CLI.** commander, `@clack/prompts`, `@vercel/detect-agent`, smol-toml, jsonc-parser.

**Dashboard.** React 19, Tailwind v4 and shadcn/ui (Radix), with motion, TanStack Query/Virtual and lucide-react.
- Bundled through Bun HTML imports plus `bun-plugin-tailwind`.
- In development, `Bun.serve` routes provide HMR.
- In production, the dashboard is embedded in the binary.
- Spec: [`DASHBOARD.md`](./DASHBOARD.md).

**One binary.** `bun build --compile` produces `agent-peers`, a single executable that contains the CLI, bridge (`agent-peers mcp`), hook entrypoint (`agent-peers hook`), hub (`agent-peers hub`) and dashboard assets. Users need **neither Node nor Bun**, which removes every "node not on PATH" and wrong-version problem inside agent plugins.

**Release targets.** `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`.

**Distribution**

| Channel | Details |
|---|---|
| GitHub Releases | Binaries, plus `install.sh` (`curl -fsSL …/install.sh \| sh`) |
| npm `@agent-peers/cli` | A thin launcher with `optionalDependencies` on `@agent-peers/cli-<platform>` packages, the pattern Biome and esbuild use, so `npx` and `bunx @agent-peers/cli …` work |
| Docker `ghcr.io/sonacy/agent-peers-hub` | Distroless base, runs `agent-peers hub` |

The installer copies the running binary to `~/.agent-peers/bin/agent-peers-<version>` and points the plugin shims at it.

## 10. Risks and open questions

1. **Native overlap.** Claude Code has cross-session messaging (`/list-agents`, alias `/peers`), and Codex is building agent message boards. Our edge is cross-vendor support, team rooms and a self-hostable hub.
2. **Unstable injection APIs.** Codex `thread/queue/add` is experimental, Cursor's idle wake is documented only in changelogs, and Claude mods are new. Every path is feature-tested by `doctor`, with fallback down the tiers.
3. **Process trees are unverified.** Does Codex run one MCP process per thread or per daemon? Do the Cursor IDE's MCP host, hooks and terminal shells share an ancestor? Prototype these first.
4. **Live tests needed:**
   - Does a `codex queue` turn render in an open TUI?
   - How long can an `asyncRewake` waiter live?
   - Does Cursor's background-shell wake work in the IDE?
   - Does `/peers:ask` coexist with Claude's built-in `/peers`?
5. **Linking devices.** In v0, each laptop that redeems an invite is its own member. Is that acceptable for the work/home story? (Handles still work: `@work` belongs to the work-laptop member.)
