/**
 * Claude Code hook stdout shapes (hooks reference): additionalContext for SessionStart and
 * UserPromptSubmit, `decision: "block"` for Stop, a PermissionRequest decision and a PreToolUse
 * deny. Every hook prints valid JSON; `{}` means "no opinion".
 */

export type HookJson = Readonly<Record<string, unknown>>

/** What one hook invocation produces: stdout, stderr and the exit code Claude Code reads. */
export interface HookResult {
  readonly exitCode: 0 | 2
  readonly stdout: string
  readonly stderr: string
}

export const EMPTY_JSON: HookJson = Object.freeze({})

export const jsonResult = (value: HookJson = EMPTY_JSON): HookResult => ({
  exitCode: 0,
  stdout: `${JSON.stringify(value)}\n`,
  stderr: '',
})

/** asyncRewake: exit 2 wakes an idle session; stderr becomes a system reminder for Claude. */
export const wakeResult = (text: string): HookResult => ({
  exitCode: 2,
  stdout: '',
  stderr: text.endsWith('\n') ? text : `${text}\n`,
})

export const additionalContext = (
  hookEventName: 'SessionStart' | 'UserPromptSubmit',
  context: string | undefined,
): HookJson =>
  context === undefined || context === ''
    ? EMPTY_JSON
    : { hookSpecificOutput: { hookEventName, additionalContext: context } }

export const blockStop = (reason: string): HookJson => ({ decision: 'block', reason })

export const allowPermission = (): HookJson => ({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
})

export const denyTool = (reason: string): HookJson => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
})
