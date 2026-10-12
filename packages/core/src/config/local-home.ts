/**
 * Typed access to the files under the agent-peers home. Every write goes through a 0600 temp file
 * and an atomic rename; credentials are persisted as soon as they are set (ONBOARDING §3 step 4).
 */
import { homedir } from 'node:os'
import { type AutojoinQuery, matchAutojoin, removeAutojoin, upsertAutojoin } from './autojoin'
import { ensurePrivateDir, readJsonFile, writeJsonFile } from './fs'
import { type EnvLike, type PeersPaths, peersPaths, resolvePeersHome } from './paths'
import { listRunPids, removeRunFiles } from './run-dir'
import {
  type AutojoinEntry,
  AutojoinFileSchema,
  type Credential,
  type Credentials,
  CredentialsSchema,
  hubOrigin,
  type LocalConfig,
  type LocalConfigInput,
  LocalConfigSchema,
} from './schemas'

export interface LocalHomeOptions {
  /** Explicit root; otherwise resolved from `env` (AGENT_PEERS_HOME) and `userHome`. */
  readonly root?: string
  readonly env?: EnvLike
  readonly userHome?: string
  readonly now?: () => number
}

export class LocalHome {
  readonly paths: PeersPaths
  readonly userHome: string
  private readonly now: () => number
  /** Serializes read-modify-write cycles within this process. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: LocalHomeOptions = {}) {
    this.userHome = options.userHome ?? homedir()
    this.paths = peersPaths(options.root ?? resolvePeersHome(options.env ?? process.env, this.userHome))
    this.now = options.now ?? Date.now
  }

  /** Creates the home, `run/` and `inbox/` with mode 0700. */
  async ensure(): Promise<void> {
    await ensurePrivateDir(this.paths.root)
    await ensurePrivateDir(this.paths.run)
    await ensurePrivateDir(this.paths.inbox)
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    return next
  }

  // ---- config.json ---------------------------------------------------------------------------------

  readConfig(): Promise<LocalConfig> {
    return readJsonFile(this.paths.config, LocalConfigSchema, () => LocalConfigSchema.parse({}))
  }

  writeConfig(config: LocalConfigInput): Promise<LocalConfig> {
    return this.serialize(() => writeJsonFile(this.paths.config, LocalConfigSchema, config))
  }

  updateConfig(update: (current: LocalConfig) => LocalConfigInput): Promise<LocalConfig> {
    return this.serialize(async () =>
      writeJsonFile(this.paths.config, LocalConfigSchema, update(await this.readConfig())),
    )
  }

  // ---- credentials.json ----------------------------------------------------------------------------

  readCredentials(): Promise<Credentials> {
    return readJsonFile(this.paths.credentials, CredentialsSchema, () => ({ hubs: {} }))
  }

  async credentialFor(hub: string): Promise<Credential | undefined> {
    const { hubs } = await this.readCredentials()
    return hubs[hubOrigin(hub)]
  }

  setCredential(hub: string, credential: Omit<Credential, 'saved_at'>): Promise<Credentials> {
    return this.serialize(async () => {
      const current = await this.readCredentials()
      const hubs = { ...current.hubs, [hubOrigin(hub)]: { ...credential, saved_at: this.now() } }
      return writeJsonFile(this.paths.credentials, CredentialsSchema, { hubs })
    })
  }

  removeCredential(hub: string): Promise<Credentials> {
    return this.serialize(async () => {
      const origin = hubOrigin(hub)
      const current = await this.readCredentials()
      const hubs = Object.fromEntries(Object.entries(current.hubs).filter(([key]) => key !== origin))
      return writeJsonFile(this.paths.credentials, CredentialsSchema, { hubs })
    })
  }

  // ---- autojoin.json -------------------------------------------------------------------------------

  async readAutojoin(): Promise<readonly AutojoinEntry[]> {
    return readJsonFile(this.paths.autojoin, AutojoinFileSchema, () => [])
  }

  async findAutojoin(query: AutojoinQuery): Promise<readonly AutojoinEntry[]> {
    return matchAutojoin(await this.readAutojoin(), query)
  }

  rememberAutojoin(entry: AutojoinEntry): Promise<readonly AutojoinEntry[]> {
    return this.serialize(async () =>
      writeJsonFile(this.paths.autojoin, AutojoinFileSchema, [
        ...upsertAutojoin(await this.readAutojoin(), entry),
      ]),
    )
  }

  forgetAutojoin(target: {
    readonly hub: string
    readonly room_id: string
    readonly workspace?: string
  }): Promise<readonly AutojoinEntry[]> {
    return this.serialize(async () =>
      writeJsonFile(this.paths.autojoin, AutojoinFileSchema, [
        ...removeAutojoin(await this.readAutojoin(), target),
      ]),
    )
  }

  // ---- run/ ----------------------------------------------------------------------------------------

  /** PIDs that have a `run/<pid>.json` info file. */
  runPids(): Promise<readonly number[]> {
    return listRunPids(this.paths.run)
  }

  /** Removes `run/<pid>.sock` and `run/<pid>.json`. */
  removeRunFiles(pid: number): Promise<void> {
    return removeRunFiles(this.paths.run, pid)
  }
}
