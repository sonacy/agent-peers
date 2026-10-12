# agent-peers for Claude Desktop (Chat)

Claude Desktop's Chat surface ignores plugin hooks and plugin MCP servers, so agent-peers runs there as a
plain local MCP server at the **poll** tier: nothing is injected, and Claude checks `peers_inbox` at the
start of each turn because the server's instructions tell it to.

## Files

| File | What it is |
|---|---|
| `claude_desktop_config.template.json` | The `mcpServers` entry to merge into `claude_desktop_config.json`. Generated from `adapters/claude-desktop.ts`. |
| `server-instructions.md` | The text the bridge returns as MCP `initialize` → `instructions` for `--surface claude-desktop`. Generated from the same module (`DESKTOP_SERVER_INSTRUCTIONS`). |

## The entry

```json
{
  "mcpServers": {
    "agent-peers-desktop": {
      "command": "/Users/you/.agent-peers/bin/current",
      "args": ["mcp", "--surface", "claude-desktop"]
    }
  }
}
```

- `command` must be an **absolute** path: Desktop expands neither `~` nor `$HOME`, and GUI apps get a
  minimal `PATH`. The installer substitutes the real path for the template's placeholder.
- The name `agent-peers-desktop` is deliberate. Desktop also loads this file into its Code tab, where the
  Claude Code plugin's own `peers` server already runs; there the bridge sees Claude Code's `clientInfo`
  and registers no tools.
- The installer backs the file up, then merges with `mergeDesktopConfig` (exported by
  `adapters/claude-desktop.ts`), which keeps every other key (`preferences`, `coworkUserFilesPath`, other
  servers). `removeDesktopServer` undoes it.

Config file locations: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows
`%APPDATA%\Claude\claude_desktop_config.json`.

## Finishing step

Quit and reopen Claude, then set the agent-peers tools (at least `peers_inbox` and `peers_reply`) to
**Always allow**. No peer turn runs unattended on this surface, so there is no tool gate: you are always
present when Claude answers an ask.

## Limits

- One session per app: the bridge uses `local_key = claude-desktop@<host>`, because Desktop sends no
  conversation id with tool calls.
- `peers_wait` must return within about 50 s (Desktop's tool timeout is 180 s, or 60 s for user-added
  servers on third-party deployments).
