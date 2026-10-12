/** bun:sqlite connection with WAL, foreign keys and versioned migrations. */
import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, existsSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { isMemoryDataDir } from '../config'
import { MIGRATIONS } from './migrations'

export const DB_FILE = 'hub.db'
/** The database holds every message and token hash: owner-only, whatever the process umask. */
export const DB_FILE_MODE = 0o600
const SIDECARS = ['', '-wal', '-shm', '-journal']

export function databasePath(dataDir: string): string {
  return isMemoryDataDir(dataDir) ? ':memory:' : join(dataDir, DB_FILE)
}

/**
 * Creates the database file 0600 before SQLite opens it (SQLite gives its WAL and shm files the
 * database file's mode) and tightens any file that already exists.
 */
export function restrictDatabaseFiles(path: string): void {
  if (!existsSync(path)) closeSync(openSync(path, 'a', DB_FILE_MODE))
  for (const suffix of SIDECARS) {
    if (existsSync(`${path}${suffix}`)) chmodSync(`${path}${suffix}`, DB_FILE_MODE)
  }
}

/** Opens (and migrates) the hub database. `':memory:'` gives an isolated in-memory database. */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') restrictDatabaseFiles(path)
  const db = new Database(path, { create: true, strict: true })
  db.run('PRAGMA foreign_keys = ON')
  db.run('PRAGMA busy_timeout = 5000')
  if (path !== ':memory:') db.run('PRAGMA journal_mode = WAL')
  migrate(db)
  if (path !== ':memory:') restrictDatabaseFiles(path)
  return db
}

export function schemaVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
  return row?.user_version ?? 0
}

export function migrate(db: Database, migrations: readonly string[] = MIGRATIONS): number {
  const from = schemaVersion(db)
  migrations.slice(from).forEach((sql, index) => {
    db.transaction(() => {
      db.run(sql)
      db.run(`PRAGMA user_version = ${from + index + 1}`)
    })()
  })
  return schemaVersion(db)
}
