/**
 * The POSIX sh installer, in two flavours rendered from one template:
 *
 * - `GET /install.sh` (ONBOARDING §3 step 3): pinned to the hub's own version.
 * - `scripts/install.sh` (a GitHub Release asset): the latest release, or the version given with a
 *   leading `--version <ver>` or `$AGENT_PEERS_VERSION`.
 *
 * Both detect OS and architecture, download `agent-peers-<os>-<arch>` and `SHA256SUMS` from the
 * release, verify the checksum, install the binary as `<home>/bin/agent-peers-<version>` (the same
 * layout the CLI's own installer uses) and exec it with the remaining arguments. When the home is
 * not writable (an agent sandbox), the verified binary runs from the temp dir instead, so the CLI
 * itself can explain how to rerun with escalation.
 */
import { PeersError } from '@agent-peers/protocol'

export const DEFAULT_RELEASE_REPO = 'sonacy/agent-peers'

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** Both values are interpolated into shell; anything outside these shapes is refused. */
export function validateInstallInputs(version: string, repo: string): void {
  if (!SEMVER.test(version)) throw new PeersError('invalid_params', 'hub version must be semver')
  if (!REPO.test(repo)) throw new PeersError('invalid_params', 'release repo must be owner/name')
}

function header(pinned: string | undefined): string {
  if (pinned !== undefined) {
    return `# agent-peers installer, pinned to hub version ${pinned}.
# Usage: curl -fsSL <hub>/install.sh | sh -s -- join <invite_url> --here
set -eu

VERSION="${pinned}"`
  }
  return `# agent-peers installer for the latest release (or the version given with --version).
# Usage: curl -fsSL https://github.com/<repo>/releases/latest/download/install.sh | sh -s -- [--version <ver>] [args...]
#   e.g. ... | sh -s -- join <invite_url> --here
set -eu

VERSION="\${AGENT_PEERS_VERSION:-latest}"
case "\${1:-}" in
  --version=*) VERSION="\${1#--version=}"; shift ;;
  --version)
    case "\${2:-}" in
      latest | v[0-9]* | [0-9]*) VERSION="$2"; shift 2 ;;
    esac
    ;;
esac
VERSION="\${VERSION#v}"`
}

const BODY = `
say() { printf 'agent-peers: %s\\n' "$1" >&2; }
fail() { say "$1"; exit 1; }

case "$VERSION" in
  latest) ;;
  *[!0-9A-Za-z.-]* | "" | [!0-9]*) fail "invalid version: $VERSION" ;;
esac

if [ "$VERSION" = "latest" ]; then
  BASE_URL="https://github.com/\${REPO}/releases/latest/download"
else
  BASE_URL="https://github.com/\${REPO}/releases/download/v\${VERSION}"
fi
# Mirrors and tests: a directory holding the release assets.
BASE_URL="\${AGENT_PEERS_DOWNLOAD_URL:-$BASE_URL}"

detect_os() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    *) fail "unsupported OS: $(uname -s) (on Windows use: npx @agent-peers/cli)" ;;
  esac
}

detect_arch() {
  arch="$(uname -m)"
  if [ "$arch" = "x86_64" ] && [ "$(uname -s)" = "Darwin" ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    arch=arm64
  fi
  case "$arch" in
    x86_64 | amd64) echo x64 ;;
    arm64 | aarch64) echo arm64 ;;
    *) fail "unsupported architecture: $arch" ;;
  esac
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1" || fail "download failed: $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || fail "download failed: $1"
  else
    fail "curl or wget is required"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    fail "sha256sum, shasum or openssl is required to verify the download"
  fi
}

# The version the binary reports (for "latest"), else the requested one.
binary_version() {
  if [ "$VERSION" != "latest" ]; then
    echo "$VERSION"
    return 0
  fi
  reported="$("$1" --version 2>/dev/null | head -n 1)" || return 1
  case "$reported" in
    *[!0-9A-Za-z.-]* | "" | [!0-9]*) return 1 ;;
  esac
  echo "$reported"
}

# Installs the verified binary as <home>/bin/agent-peers-<version> and points <home>/bin/current at
# it. Prints the installed path; returns non-zero (printing nothing) when the home is not writable.
install_binary() {
  ver="$(binary_version "$1")" || return 1
  dir="\${AGENT_PEERS_HOME:-\${HOME:-}/.agent-peers}/bin"
  name="agent-peers-\${ver}"
  part="\${dir}/.\${name}.$$.tmp"
  mkdir -p "$dir" 2>/dev/null || return 1
  if ! { cp "$1" "$part" && chmod 755 "$part" && mv -f "$part" "\${dir}/\${name}"; } 2>/dev/null; then
    rm -f "$part" 2>/dev/null || true
    return 1
  fi
  link="\${dir}/.current.$$.tmp"
  if ln -s "$name" "$link" 2>/dev/null && mv -f "$link" "\${dir}/current" 2>/dev/null; then :; else
    rm -f "$link" 2>/dev/null || true
  fi
  echo "\${dir}/\${name}"
}

main() {
  os="$(detect_os)"
  arch="$(detect_arch)"
  asset="agent-peers-\${os}-\${arch}"
  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t agent-peers)"
  say "downloading \${asset} (\${VERSION})"
  download "\${BASE_URL}/\${asset}" "\${tmp}/\${asset}"
  download "\${BASE_URL}/SHA256SUMS" "\${tmp}/SHA256SUMS"
  expected="$(awk -v f="\${asset}" '$2 == f || $2 == "*" f { print $1; exit }' "\${tmp}/SHA256SUMS")"
  [ -n "$expected" ] || fail "no checksum for \${asset} in SHA256SUMS"
  actual="$(sha256_of "\${tmp}/\${asset}")"
  if [ "$expected" != "$actual" ]; then
    rm -rf "$tmp"
    fail "checksum mismatch for \${asset} (expected $expected, got $actual)"
  fi
  chmod 755 "\${tmp}/\${asset}"
  if installed="$(install_binary "\${tmp}/\${asset}")" && [ -n "$installed" ]; then
    rm -rf "$tmp"
    say "installed $installed"
    exec "$installed" "$@"
  fi
  say "could not write to the agent-peers home; running from a temporary directory"
  exec "\${tmp}/\${asset}" "$@"
}

main "$@"
`

function render(pinned: string | undefined, repo: string): string {
  return `#!/bin/sh\n${header(pinned)}\nREPO="${repo}"\n${BODY}`
}

/** `GET /install.sh`: the installer pinned to the hub's own version. */
export function renderInstallScript(version: string, repo: string = DEFAULT_RELEASE_REPO): string {
  validateInstallInputs(version, repo)
  return render(version, repo)
}

/** `scripts/install.sh` (a release asset): the latest release unless `--version` picks one. */
export function renderReleaseInstallScript(repo: string = DEFAULT_RELEASE_REPO): string {
  validateInstallInputs('0.0.0', repo)
  return render(undefined, repo)
}
