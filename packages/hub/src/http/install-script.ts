/**
 * `GET /install.sh` (ONBOARDING §3 step 3): a POSIX sh installer pinned to the hub's own version.
 * It detects OS and architecture, downloads `agent-peers-<os>-<arch>` and `SHA256SUMS` from that
 * version's GitHub Release, verifies the checksum and execs the binary with the given arguments.
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

export function renderInstallScript(version: string, repo: string = DEFAULT_RELEASE_REPO): string {
  validateInstallInputs(version, repo)
  return `#!/bin/sh
# agent-peers installer, pinned to hub version ${version}.
# Usage: curl -fsSL <hub>/install.sh | sh -s -- join <invite_url> --here
set -eu

VERSION="${version}"
REPO="${repo}"
BASE_URL="https://github.com/\${REPO}/releases/download/v\${VERSION}"

say() { printf 'agent-peers: %s\\n' "$1" >&2; }
fail() { say "$1"; exit 1; }

detect_os() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    *) fail "unsupported OS: $(uname -s)" ;;
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
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
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

main() {
  os="$(detect_os)"
  arch="$(detect_arch)"
  asset="agent-peers-\${os}-\${arch}"
  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t agent-peers)"
  say "downloading \${asset} v\${VERSION}"
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
  exec "\${tmp}/\${asset}" "$@"
}

main "$@"
`
}
