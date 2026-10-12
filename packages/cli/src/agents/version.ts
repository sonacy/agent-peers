/** Version parsing and gates (ARCHITECTURE §4 step 1, §6.2). */

/**
 * Agent version gates. Claude Code: plugin CLI flags by version (cli-reference); Codex: automatic
 * daemon startup (0.157) is what makes `codex queue` push reliable, and is the install floor.
 */
export const VERSION_GATES = {
  /** `claude plugin install/marketplace` as used here (`-y` landed in 2.1.229). */
  claudeMin: '2.1.229',
  /** `claude plugin install --json`. */
  claudeInstallJson: '2.1.268',
  /** `claude plugin marketplace add|remove --json`. */
  claudeMarketplaceJson: '2.1.287',
  /** Single-step `claude plugin install <p> --marketplace <source>`. */
  claudeMarketplaceFlag: '2.1.292',
  /** Codex plugin hooks (`mcp_tool`), `codex plugin add`, and daemon-backed `codex queue` push. */
  codexMin: '0.157.0',
} as const

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/

/** The first `x.y.z[-pre]` in a `--version` output (`2.1.296 (Claude Code)`, `codex-cli 0.160.1`). */
export function parseVersion(text: string): string | undefined {
  return VERSION_PATTERN.exec(text)?.[0]
}

/** Numeric `[major, minor, patch]` and prerelease of a version string; undefined when unparsable. */
function parts(version: string): { readonly nums: readonly number[]; readonly pre?: string } | undefined {
  const match = VERSION_PATTERN.exec(version)
  if (!match) return undefined
  const nums = [Number(match[1]), Number(match[2]), Number(match[3])]
  return match[4] === undefined ? { nums } : { nums, pre: match[4] }
}

/** -1, 0 or 1. A prerelease sorts before its release; unparsable versions sort first. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a)
  const right = parts(b)
  if (!left || !right) return left ? 1 : right ? -1 : 0
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  if (left.pre === right.pre) return 0
  if (left.pre === undefined) return 1
  if (right.pre === undefined) return -1
  return left.pre < right.pre ? -1 : 1
}

/** `version >= min`; false when the version is unknown. */
export function atLeast(version: string | undefined, min: string): boolean {
  return version !== undefined && parseVersion(version) !== undefined && compareVersions(version, min) >= 0
}
