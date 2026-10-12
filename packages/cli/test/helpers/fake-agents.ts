/**
 * A fake machine for installer tests: temp HOME, a PATH holding fake `claude` / `codex` scripts that
 * record their argv, fake app bundles, and a fake agent-peers binary. Nothing real is touched.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSys } from '../../src/agents/sys'
import type { Sys } from '../../src/agents/types'
import type { InstallerDeps } from '../../src/commands/installer-deps'
import { memoryIo } from './world'

export interface FakeMachine {
  readonly root: string
  readonly home: string
  readonly peersHome: string
  readonly binDir: string
  readonly appsDir: string
  readonly log: string
  readonly source: string
  env: Record<string, string>
  sys(): Sys
  deps(extra?: Partial<InstallerDeps>): InstallerDeps
  io(): ReturnType<typeof memoryIo>
  calls(): Promise<readonly (readonly string[])[]>
  cleanup(): Promise<void>
}

async function writeExecutable(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
  await chmod(path, 0o755)
}

const RECORD = `log="\${FAKE_LOG:-/dev/null}"
{ printf '%s' "$(basename "$0")"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$log"
`

/** `claude`: --version, list commands from env, everything else succeeds with a --json result line. */
export const FAKE_CLAUDE = `#!/bin/sh
${RECORD}
case "$*" in
  "--version") echo "\${FAKE_CLAUDE_VERSION:-2.1.296} (Claude Code)"; exit 0;;
  "plugin marketplace list --json") printf '%s\\n' "\${FAKE_CLAUDE_MARKETPLACES:-[]}"; exit 0;;
  "plugin list --json") printf '%s\\n' "\${FAKE_CLAUDE_PLUGINS:-[]}"; exit 0;;
esac
if [ -n "\${FAKE_CLAUDE_FAIL:-}" ]; then
  case "$*" in *"$FAKE_CLAUDE_FAIL"*) echo '{"command":"install","outcome":"failed","message":"boom"}'; exit 1;; esac
fi
echo '{"command":"install","outcome":"ok","message":"done"}'
`

/** `codex`: keeps marketplace state in a file and writes the plugin table into config.toml like Codex. */
export const FAKE_CODEX = `#!/bin/sh
${RECORD}
state="\${FAKE_STATE:-/tmp/none}"
config="\${CODEX_HOME:-$HOME/.codex}/config.toml"
case "$*" in
  "--version") echo "codex-cli \${FAKE_CODEX_VERSION:-0.160.1}"; exit 0;;
esac
case "$1 $2 $3" in
  "plugin marketplace add")
    if [ -f "$state" ] && [ "$(cat "$state")" != "$4" ]; then
      echo "marketplace 'agent-peers' is already added from a different source; remove it before adding this source" >&2; exit 1
    fi
    if [ -f "$state" ]; then echo "Marketplace \\\`agent-peers\\\` is already added."; exit 0; fi
    printf '%s' "$4" > "$state"; echo '{"added":true}'; exit 0;;
  "plugin marketplace remove") rm -f "$state"; echo "Removed marketplace agent-peers"; exit 0;;
esac
case "$1 $2" in
  "plugin add")
    mkdir -p "$(dirname "$config")"
    if grep -q '^\\[plugins."peers@agent-peers"\\]' "$config" 2>/dev/null; then
      echo "Plugin peers@agent-peers is already installed."; exit 0
    fi
    printf '[plugins."peers@agent-peers"]\\nenabled = true\\n' >> "$config"
    echo '{"installed":true}'; exit 0;;
  "plugin remove")
    if [ -f "$config" ]; then
      sed '/^\\[plugins."peers@agent-peers"\\]$/,/^enabled = true$/d' "$config" > "$config.tmp" && mv "$config.tmp" "$config"
    fi
    echo '{"removed":true}'; exit 0;;
esac
exit 0
`

/** The agent-peers binary that `add` copies: answers --version and the MCP selftest. */
export const FAKE_PEERS_BINARY = `#!/bin/sh
${RECORD}
case "$*" in
  "--version") echo "0.1.0"; exit 0;;
  *--selftest*) [ -n "\${FAKE_SELFTEST_FAIL:-}" ] && { echo "selftest broke" >&2; exit 1; }
    echo "agent-peers mcp selftest ok ($3)" >&2; exit 0;;
esac
exit 0
`

export function infoPlist(bundleId: string, version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
</dict></plist>
`
}

export async function fakeMachine(): Promise<FakeMachine> {
  const root = await mkdtemp(join(tmpdir(), 'apc-inst-'))
  const home = join(root, 'home')
  const binDir = join(root, 'bin')
  const appsDir = join(root, 'Applications')
  const log = join(root, 'calls.log')
  const source = join(root, 'dist', 'agent-peers')
  await Promise.all([mkdir(home, { recursive: true }), mkdir(binDir), mkdir(appsDir)])
  await writeExecutable(source, FAKE_PEERS_BINARY)
  await writeFile(log, '')
  const machine: FakeMachine = {
    root,
    home,
    peersHome: join(home, '.agent-peers'),
    binDir,
    appsDir,
    log,
    source,
    env: {
      HOME: home,
      // System dirs for the fake scripts' sed/grep/cat; no claude or codex lives there.
      PATH: `${binDir}:/usr/bin:/bin`,
      AGENT_PEERS_HOME: join(home, '.agent-peers'),
      FAKE_LOG: log,
      FAKE_STATE: join(root, 'codex-marketplace.state'),
    },
    sys: () =>
      createSys({
        env: machine.env,
        home,
        platform: 'darwin',
        appDirs: [appsDir],
        now: () => 1_760_000_000_000,
      }),
    deps: (extra = {}) => ({
      sys: () => machine.sys(),
      sourceBinary: source,
      interactive: false,
      determineAgent: async () => ({ isAgent: false }),
      ...extra,
    }),
    io: () => memoryIo(machine.env),
    async calls() {
      const text = await readFile(log, 'utf8')
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t'))
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
  return machine
}

export const installFakeClaude = (m: FakeMachine, dir = m.binDir): Promise<void> =>
  writeExecutable(join(dir, 'claude'), FAKE_CLAUDE)

export const installFakeCodex = (m: FakeMachine, dir = m.binDir): Promise<void> =>
  writeExecutable(join(dir, 'codex'), FAKE_CODEX)

/** /Applications/ChatGPT.app with the bundled engine at Contents/Resources/codex-cli/bin/codex. */
export async function installFakeCodexApp(m: FakeMachine, version = '26.930.61225'): Promise<string> {
  const app = join(m.appsDir, 'ChatGPT.app')
  await mkdir(join(app, 'Contents'), { recursive: true })
  await writeFile(join(app, 'Contents', 'Info.plist'), infoPlist('com.openai.codex', version))
  await writeExecutable(join(app, 'Contents', 'Resources', 'codex-cli', 'bin', 'codex'), FAKE_CODEX)
  return app
}

/** /Applications/Claude.app plus its config dir. */
export async function installFakeClaudeDesktop(m: FakeMachine, config?: unknown): Promise<string> {
  const app = join(m.appsDir, 'Claude.app')
  await mkdir(join(app, 'Contents'), { recursive: true })
  await writeFile(
    join(app, 'Contents', 'Info.plist'),
    infoPlist('com.anthropic.claudefordesktop', '2.31226.1'),
  )
  const dir = join(m.home, 'Library', 'Application Support', 'Claude')
  await mkdir(dir, { recursive: true })
  if (config !== undefined) await writeFile(join(dir, 'claude_desktop_config.json'), JSON.stringify(config))
  return dir
}

/** Replaces the temp root in text so snapshots are stable. */
export const normalize = (m: FakeMachine, text: string): string => text.split(m.root).join('<TMP>')
