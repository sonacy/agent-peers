# syntax=docker/dockerfile:1
#
# The agent-peers hub image (ARCHITECTURE §7 option D, §9): ghcr.io/sonacy/agent-peers-hub.
#
#   docker build -f docker/Dockerfile -t agent-peers-hub .
#   docker run -d --name agent-peers-hub --restart unless-stopped \
#     -p 7337:7337 \
#     -v agent-peers-hub:/data \
#     agent-peers-hub --public-url https://hub.example.com
#
# 7337 is the public listener (WebSocket, invites, /install.sh, member dashboard).
# 7338 is the ADMIN listener (operator API and admin dashboard). By default it binds the
# container's loopback only, so it is never published (not even by `-P`); the admin commands run
# inside the container and reach it there:
#
#   docker exec agent-peers-hub agent-peers invite payments    # a join prompt
#   docker exec agent-peers-hub agent-peers rooms
#   docker exec agent-peers-hub agent-peers hub rotate-admin-token
#
# To use the admin dashboard from the host, opt in explicitly: append `--admin-bind 0.0.0.0` and
# publish it on 127.0.0.1 ONLY (`-p 127.0.0.1:7338:7338`, see docker/compose.yaml), then reach it
# over SSH or Tailscale. Never publish 7338 on a public interface: Docker's port rules bypass
# ufw/firewalld.
#
# State lives in the /data volume: AGENT_PEERS_HOME=/data, so the hub's data dir is /data/hub, the
# same default the admin commands resolve. Arguments after the image name are appended to
# `agent-peers hub` (e.g. --public-url, --registration). Put TLS in front of 7337 (Caddy, a tunnel,
# `tailscale serve`).

ARG BUN_VERSION=1.3.10
# Base images are pinned by digest (multi-arch index); bump the digest together with the tag.
ARG BUN_DIGEST=sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e
ARG DISTROLESS_DIGEST=sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f

# Build on the runner's own platform and cross-compile for the target: no emulation needed.
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}@${BUN_DIGEST} AS build
ARG TARGETARCH
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile
RUN case "$TARGETARCH" in \
      amd64) arch=x64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && bun packages/cli/scripts/release.ts --targets "linux-$arch" --out /out \
 && mv "/out/agent-peers-linux-$arch" /out/agent-peers \
 && mkdir -p /out/data

# glibc + libstdc++, no shell, runs as uid 65532 (nonroot).
FROM gcr.io/distroless/cc-debian12:nonroot@${DISTROLESS_DIGEST}
COPY --from=build /out/agent-peers /usr/local/bin/agent-peers
COPY --from=build --chown=65532:65532 /out/data /data
ENV AGENT_PEERS_HOME=/data
USER 65532:65532
VOLUME ["/data"]
EXPOSE 7337
ENTRYPOINT ["/usr/local/bin/agent-peers", "hub"]
