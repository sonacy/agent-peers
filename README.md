# agent-peers

Connect AI coding-agent sessions — Claude Code, Claude Desktop, Codex CLI, Codex desktop, and more — into shared rooms across machines and teams. From one session, `/peers:ask @work what's the retry policy?`; the remote session answers and the reply comes back to you.

> Status: v0 in development. Not published yet.

## Design

- [Architecture](docs/ARCHITECTURE.md)
- [Wire protocol](docs/PROTOCOL.md)
- [Rooms, join prompts and onboarding](docs/ONBOARDING.md)

## Development

```bash
corepack enable          # pnpm via packageManager
pnpm install
pnpm build
pnpm check               # lint + typecheck + tests
pnpm test:coverage
AGENT_PEERS_LIVE=1 pnpm test:live   # opt-in: real Claude Code / Codex
```

Node ≥ 22.13 is required.

## License

MIT
