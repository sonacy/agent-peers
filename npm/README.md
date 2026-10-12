# npm packages

- `cli/`: the public launcher `@agent-peers/cli` (bin `agent-peers`). It resolves
  `@agent-peers/cli-<platform>-<arch>/bin/agent-peers[.exe]` and runs it.
- `platform/`: the template for the five platform packages. `{{platform}}` / `{{arch}}` are Node's
  `process.platform` / `process.arch` names.

Nothing here is published as is. `bun run release:npm` (packages/cli/scripts/npm-stage.ts) stamps
the release version into every package, fills the template per platform, copies each binary from
`dist/release/` into `bin/`, and writes the publishable trees to `dist/npm/`. See docs/RELEASING.md.
