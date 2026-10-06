/**
 * The one carry rule on a local Windows pane for agent.launch's guarded paste, per shell, from host
 * facts. A cmd or PowerShell pane can prove its shell alone in front, so a line it was not measured
 * carrying exactly is pasted once the agent runs (their startup-crash rows typed nothing). A Git Bash or WSL
 * pane cannot, so it never pastes: its POSIX line carries the prompt, and a file only past that.
 */

import { describe, expect, it } from 'vitest'
import { planLaunchPrompt } from './tui-agent-startup'
import { describeLaunchHost, type WindowsPaneShell } from './launch-host'
import type { LaunchPromptPaste } from './launch-prompt-carry'
import type { TuiAgent } from './tui-agent'

function plan(
  agent: TuiAgent,
  prompt: string,
  shell: WindowsPaneShell,
  launchPlatform: NodeJS.Platform = 'win32',
  paste: LaunchPromptPaste = 'when-host-guards-paste'
) {
  return planLaunchPrompt({
    agent,
    prompt,
    cmdOverrides: {},
    platform: launchPlatform,
    // The pane's quoting family, as the spawn picks it.
    shell:
      shell === 'cmd.exe'
        ? 'cmd'
        : shell === 'git-bash' || shell === 'wsl.exe'
          ? 'posix'
          : 'powershell',
    host: describeLaunchHost({
      launchPlatform,
      isRemote: false,
      hostPlatform: 'win32',
      paired: false,
      windowsPaneShell: shell
    }),
    paste
  })?.carry
}

/** A multi-line prompt PowerShell was never measured carrying exactly (512 B – 9 KB). */
const UNCERTAIN_ON_POWERSHELL = `Fix the failing checks.\n${'Then push. '.repeat(100)}`
/** A multi-line prompt PowerShell was measured damaging (9 KB and up). */
const DAMAGED_ON_POWERSHELL = `Fix the failing checks.\n${'Then push. '.repeat(1_000)}`
const SHORT = 'explain this repo'

describe('a launch prompt on a local Windows pane', () => {
  it.each<WindowsPaneShell>(['powershell.exe', 'pwsh.exe'])(
    'pastes a line %s was not measured carrying exactly, for every agent',
    (shell) => {
      for (const agent of ['claude', 'codex', 'gemini'] as const) {
        expect(plan(agent, UNCERTAIN_ON_POWERSHELL, shell)).toBe('paste-after-ready')
        expect(plan(agent, DAMAGED_ON_POWERSHELL, shell)).toBe('paste-after-ready')
        expect(plan(agent, SHORT, shell)).toBe('on-line')
      }
    }
  )

  // Why: only agent.launch's guard refuses a shell proven alone; a worktree follow-up or the window's
  // paste writes without it, so a line a Windows shell would damage stays off its paste.
  it('never moves a line onto a paste that lacks that guard', () => {
    expect(
      plan('claude', 'fix it\nthen push', 'cmd.exe', 'win32', 'when-host-proves-agent')
    ).not.toBe('paste-after-ready')
    expect(
      plan('claude', UNCERTAIN_ON_POWERSHELL, 'pwsh.exe', 'win32', 'when-host-proves-agent')
    ).not.toBe('paste-after-ready')
  })

  it('pastes any multi-line prompt on cmd, which breaks the line at its first newline', () => {
    expect(plan('claude', 'fix it\nthen push', 'cmd.exe')).toBe('paste-after-ready')
    expect(plan('gemini', 'fix it\nthen push', 'cmd.exe')).toBe('paste-after-ready')
    expect(plan('claude', SHORT, 'cmd.exe')).toBe('on-line')
  })

  it('never pastes on Git Bash, whose shell cannot be proven alone in front', () => {
    expect(plan('gemini', UNCERTAIN_ON_POWERSHELL, 'git-bash')).toBe('on-line')
    expect(plan('claude', DAMAGED_ON_POWERSHELL, 'git-bash')).toBe('on-line')
    // Past what Git Bash carries: a file for an agent that reads one, else the line, as main typed.
    const huge = `x\n${'y'.repeat(25_000)}`
    expect(plan('claude', huge, 'git-bash')).toBe('launch-file')
    expect(plan('gemini', huge, 'git-bash')).toBe('on-line')
  })

  it('never pastes in a WSL pane, which stages its POSIX line', () => {
    expect(plan('gemini', DAMAGED_ON_POWERSHELL, 'wsl.exe', 'linux')).toBe('on-line')
    expect(plan('claude', DAMAGED_ON_POWERSHELL, 'wsl.exe', 'linux')).toBe('on-line')
  })
})
