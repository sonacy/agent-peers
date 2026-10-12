# Releasing agent-peers

One tag produces every distribution channel in [ARCHITECTURE §9](./ARCHITECTURE.md#9-tech-stack-and-packaging):

| Channel | What | Built by |
|---|---|---|
| GitHub Release `vX.Y.Z` | `agent-peers-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64.exe}`, `SHA256SUMS`, `install.sh` | `.github/workflows/release.yml` → `build`, `smoke`, `github` |
| npm | `@agent-peers/cli` (launcher) + `@agent-peers/cli-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64}` | `npm` job |
| GHCR | `ghcr.io/sonacy/agent-peers-hub:X.Y.Z`, `:X.Y`, `:latest` (linux/amd64, linux/arm64) | `docker` job |

## Layout

- `packages/cli` is the CLI source, workspace name `@agent-peers/cli-app` (private, never published).
  The public npm name `@agent-peers/cli` belongs to the launcher in `npm/cli`.
- `packages/cli/scripts/release.ts` compiles release binaries. It regenerates the embedded adapter
  trees, builds the dashboard (`packages/dashboard`, when present) and generates an entry that imports
  it statically so `bun build --compile` embeds the SPA. Every target is cross-compiled from one
  machine with `--minify --sourcemap`.
- `npm/cli` is the launcher: `bin/agent-peers.js` resolves
  `@agent-peers/cli-<platform>-<arch>/bin/agent-peers[.exe]` (installed through `optionalDependencies`;
  each platform package carries `os`/`cpu`) and runs it with inherited stdio. It works under Node 18+
  and Bun. `npm/platform` is the template for the platform packages.
- `packages/cli/scripts/npm-stage.ts` stamps the version, fills the template per platform, copies and
  checksum-verifies the binaries, and writes publishable trees to `dist/npm/`.
- `scripts/install.sh` is generated from the hub's installer template
  (`packages/hub/src/http/install-script.ts`), the same one the hub serves pinned to its version at
  `/install.sh`. Regenerate with `bun run release:install-sh`; a test fails when it drifts.
- `docker/Dockerfile` builds on the runner's platform, cross-compiles the Linux binary for the target
  architecture and copies it into `gcr.io/distroless/cc-debian12:nonroot`.

## Local commands

```sh
bun run release:build                    # every target → dist/release/ + SHA256SUMS
bun packages/cli/scripts/release.ts --current --dashboard skip   # just this machine, quickly
bun run release:npm                      # dist/release → dist/npm (version from packages/cli)
bun run release:install-sh               # regenerate scripts/install.sh
docker build -f docker/Dockerfile -t agent-peers-hub .
```

`release.ts` flags: `--targets darwin-arm64,linux-x64` (or `all`), `--current`, `--out <dir>`,
`--outfile <file>` (one target, no `SHA256SUMS`), `--dashboard build|embed|skip`,
`--adapters write|check|skip`, `--no-minify`, `--no-sourcemap`.

## Cutting a release

1. Bump the version everywhere it is declared, to the same `X.Y.Z`:
   - `packages/*/package.json` (the binary reports `packages/cli`'s version, and the hub pins
     `/install.sh` to it)
   - `adapters/claude-code/.claude-plugin/plugin.json`, `adapters/codex/.codex-plugin/plugin.json`,
     then `bun packages/cli/scripts/embed-adapters.ts`
   - `ADAPTER_VERSION` in `packages/bridge` (hubs compare it with `min_adapter`)
   - `bun packages/cli/scripts/check-versions.ts vX.Y.Z` confirms that every one of these matches. The
     release workflow runs the same check and refuses a mismatch.
2. `bun run check`, then commit.
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`. A `-suffix` (e.g. `v0.2.0-rc.1`) makes a
   GitHub prerelease, the npm dist-tag `next` and no Docker `latest`.
4. The workflow refuses a tag that differs from `packages/cli/package.json`. It then builds, runs
   each binary natively (`--version`, `mcp --selftest`; Windows reports without blocking, and
   darwin-x64 is cross-compiled only), creates the release with build attestations, publishes npm
   and pushes the image. Rerunning a failed run is safe: npm versions that already exist are skipped.

## First publish (one time, manual)

Trusted publishing can only be configured on a package that already exists, so the first version of
each of the six packages is published by hand. The npm org `agent-peers` exists; its owner is
`sonacy2538`.

1. `npm login` as `sonacy2538` (or a member of the `agent-peers` org with publish rights), with 2FA.
2. Build and stage: `bun run release:build && bun run release:npm`.
3. Publish the platform packages first, then the launcher:

   ```sh
   for dir in dist/npm/cli-* dist/npm/cli; do npm publish "$dir" --access public; done
   ```

   `--provenance` only works from CI, so these first versions carry none. Alternatively, put a
   granular automation token with publish rights on `@agent-peers/*` into the repository secret
   `NPM_TOKEN` and let the tag workflow do the first publish (it uses the token when trusted
   publishing is not configured yet). Delete the secret once step 4 is done.
4. On npmjs.com, for **each** of the six packages: Settings → Trusted publishing → GitHub Actions:
   - Organization or user: `sonacy`
   - Repository: `agent-peers`
   - Workflow filename: `release.yml`
   - Environment: `npm`
5. In the GitHub repository settings, create the environment `npm` (optionally with required
   reviewers). Then, on each package: Settings → Publishing access → "Require two-factor
   authentication and disallow tokens".

From then on the `npm` job publishes through OIDC (`id-token: write`, npm ≥ 11.5.1) with no token, and
npm attaches provenance automatically while the repository is public.

## GHCR

The `docker` job pushes with the workflow's `GITHUB_TOKEN` (`packages: write`). After the first push,
open the package `agent-peers-hub` on GitHub → Package settings: link it to the repository and make it
public.

Running it: see the header of `docker/Dockerfile` (or `docker/compose.yaml`). Inside the container the
admin listener has to bind `0.0.0.0` (`--admin-bind 0.0.0.0`) to be reachable at all, so publish it
only on the host's loopback: `-p 7337:7337 -p 127.0.0.1:7338:7338`. Never publish 7338 on a public
interface. Admin commands run inside the container, e.g. `docker exec agent-peers-hub agent-peers invite`.

## Verifying a release

```sh
curl -fsSLO https://github.com/sonacy/agent-peers/releases/download/vX.Y.Z/agent-peers-linux-x64
curl -fsSLO https://github.com/sonacy/agent-peers/releases/download/vX.Y.Z/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
gh attestation verify agent-peers-linux-x64 --repo sonacy/agent-peers
npm audit signatures   # in a project that installed @agent-peers/cli
```
