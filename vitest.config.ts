import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const pkgs = ['protocol', 'core', 'hub', 'bridge', 'cli']
const alias = Object.fromEntries(
  pkgs.map((p) => [
    `@agent-peers/${p}`,
    fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url)),
  ]),
)

const live = process.env.AGENT_PEERS_LIVE === '1'

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['packages/*/test/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: { name: 'e2e', include: ['test/e2e/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
      },
      ...(live
        ? [
            {
              extends: true,
              test: {
                name: 'live',
                include: ['test/live/**/*.test.ts'],
                testTimeout: 600_000,
                hookTimeout: 600_000,
              },
            },
          ]
        : []),
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/dashboard/**', '**/*.d.ts', 'packages/cli/src/bin.ts'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
})
