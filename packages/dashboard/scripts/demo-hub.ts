/**
 * `bun run --filter @agent-peers/dashboard demo`: a seeded hub for local preview and Playwright.
 * Prints a one-time sign-in link for gulei and the operator URL; press Enter for a fresh link.
 * Flags: --port (7300), --admin-port (7301), --data-dir, --small (a 12-person big room), --json.
 */
import { parseArgs } from 'node:util'
import { startDemoHub } from './demo/hub'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: 'string', default: '7300' },
    'admin-port': { type: 'string', default: '7301' },
    'data-dir': { type: 'string' },
    small: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
})

const small = values.small ? { bigRoomMembers: 12, bigRoomOnline: 4, bigRoomBusy: 2, bigRoomKnocks: 5 } : {}
const demo = await startDemoHub({
  port: Number(values.port),
  adminPort: Number(values['admin-port']),
  ...(values['data-dir'] === undefined ? {} : { dataDir: values['data-dir'] }),
  ...small,
})

const print = (line: string) => process.stdout.write(`${line}\n`)
const loginUrl = await demo.seeded.loginUrl()
if (values.json) {
  print(
    JSON.stringify({
      url: demo.url,
      adminUrl: `${demo.adminUrl}/admin/`,
      adminToken: demo.info.adminToken,
      loginUrl,
    }),
  )
} else {
  print('Peers demo hub is up.')
  print(`  member dashboard (gulei, one-time, 5 min): ${loginUrl}`)
  print(`  operator view: ${demo.adminUrl}/admin/  (admin token: ${demo.info.adminToken})`)
  print('Press Enter for a fresh sign-in link, Ctrl+C to stop.')
}

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await demo.stop()
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())

for await (const _line of console) {
  const next = await demo.seeded.loginUrl()
  print(values.json ? JSON.stringify({ loginUrl: next }) : `  sign in: ${next}`)
}
