import { describe, expect, it, vi } from 'vitest'
import type { TerminalForegroundVerdict } from '../../terminal-foreground-group'
import { proveCarriedTerminalAgentLaunchPrompt } from './agent-launch-carried-prompt-proof'

type Verdict = TerminalForegroundVerdict

/**
 * A pane whose foreground reads come from `foreground(ms since start)`, and whose shell reports the
 * launch line finished at `finishedAt` (never when null).
 */
function pane(args: {
  foreground: (elapsedMs: number) => Verdict
  finishedAt?: number | null
  hookTurn?: 'observed' | 'unobserved'
}) {
  const startedAt = Date.now()
  return {
    observeTerminalLaunchTurnStart: vi.fn(
      (_handle: string, _launch: unknown, timeoutMs: number, signal?: AbortSignal) =>
        new Promise<'observed' | 'unobserved'>((resolve) => {
          if (args.hookTurn === 'observed') {
            resolve('observed')
            return
          }
          const timer = setTimeout(() => resolve('unobserved'), timeoutMs)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve('unobserved')
          })
        })
    ),
    getTerminalPromptRequestBinding: vi.fn(() => ({
      ptyId: 'pty-1',
      processIncarnation: 'i',
      generation: 1
    })),
    readTerminalForegroundVerdict: vi.fn(async () => args.foreground(Date.now() - startedAt)),
    terminalCommandFinishedSince: vi.fn(
      (_ptyId: string, since: number) =>
        args.finishedAt != null &&
        startedAt + args.finishedAt >= since &&
        Date.now() - startedAt >= args.finishedAt
    )
  }
}

async function timed<T>(run: Promise<T>): Promise<{ result: T; elapsed: number }> {
  const started = Date.now()
  const result = await run
  return { result, elapsed: Date.now() - started }
}

function prove(runtime: ReturnType<typeof pane>, timeoutMs = 800, launchStartedAt = Date.now()) {
  return proveCarriedTerminalAgentLaunchPrompt({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements every runtime method the proof calls; the rest of the runtime is never reached.
    runtime: runtime as unknown as Parameters<
      typeof proveCarriedTerminalAgentLaunchPrompt
    >[0]['runtime'],
    handle: 'term_1',
    agent: 'claude',
    launchStartedAt,
    timeoutMs
  })
}

describe('proving a prompt the launch command carried', () => {
  // Why: the prompt is on its command line; waiting for it to be ready held follow-ups for a whole
  // first answer where hooks are off.
  it('counts the launched agent once it stays in front past startup, without waiting for it to be ready', async () => {
    const { result, elapsed } = await timed(
      prove(pane({ foreground: (ms) => (ms < 150 ? 'shell' : 'launched-agent') }), 8_000)
    )
    expect(result).toEqual({ outcome: 'handed-to-terminal' })
    expect(elapsed).toBeGreaterThanOrEqual(150 + 2_000)
    expect(elapsed).toBeLessThan(150 + 2_000 + 500)
  })

  // Why: on a loaded host a crash at startup lives long enough to be seen (QA: no notice in 70 s).
  it('calls an agent seen in front an exit when its launch line finishes after', async () => {
    const { result, elapsed } = await timed(
      prove(
        pane({ foreground: (ms) => (ms < 600 ? 'launched-agent' : 'shell'), finishedAt: 600 }),
        8_000
      )
    )
    expect(result).toEqual({ outcome: 'not-delivered', reason: 'agent-exited' })
    expect(elapsed).toBeLessThan(1_500)
  })

  // Why: Orca's codex wrapper runs `codex --help` first, and the shell holds the terminal between.
  it('never calls the shell between a probe and the agent an exit', async () => {
    const foreground = (ms: number) => (ms < 200 || ms >= 500 ? 'launched-agent' : 'shell')
    const { result, elapsed } = await timed(prove(pane({ foreground }), 8_000))
    expect(result).toEqual({ outcome: 'handed-to-terminal' })
    expect(elapsed).toBeLessThan(3_500)
  })

  // Why: Orca's SSH zsh and fish send no finished-command report, so the shell back is all there is.
  it('calls the shell back for a moment after the agent was seen an exit, with no report', async () => {
    const { result, elapsed } = await timed(
      prove(pane({ foreground: (ms) => (ms < 600 ? 'launched-agent' : 'shell') }), 8_000)
    )
    expect(result).toEqual({ outcome: 'not-delivered', reason: 'agent-exited' })
    expect(elapsed).toBeLessThan(2_000)
  })

  // Why: a nested shell inside a running agent can report a finished command on the agent's pane.
  it('never calls a finished command an exit while the launched agent holds the terminal', async () => {
    await expect(
      prove(pane({ foreground: () => 'launched-agent', finishedAt: 100 }), 8_000)
    ).resolves.toEqual({ outcome: 'handed-to-terminal' })
  })

  it('catches an exit just before the budget ends', async () => {
    await expect(
      prove(
        pane({ foreground: (ms) => (ms < 300 ? 'launched-agent' : 'shell'), finishedAt: 950 }),
        1_000
      )
    ).resolves.toEqual({ outcome: 'not-delivered', reason: 'agent-exited' })
  })

  it('answers by the budget even when the hook watch never returns', async () => {
    const stuck = pane({ foreground: () => 'shell' })
    stuck.observeTerminalLaunchTurnStart.mockImplementation(() => new Promise(() => {}))
    const { result, elapsed } = await timed(prove(stuck, 400))
    expect(result).toEqual({ outcome: 'handed-to-terminal' })
    expect(elapsed).toBeLessThan(700)
  })

  it('answers by the budget even when a read never returns', async () => {
    const stuck = pane({ foreground: () => 'shell' })
    stuck.readTerminalForegroundVerdict.mockImplementation(() => new Promise(() => {}))
    const { result, elapsed } = await timed(prove(stuck, 400))
    expect(result).toEqual({ outcome: 'handed-to-terminal' })
    expect(elapsed).toBeLessThan(700)
  })

  // Why: a slow shell startup runs its own commands in front; none of them is the agent.
  it('never counts another process in front, and leaves the prompt handed over at the budget', async () => {
    const { result, elapsed } = await timed(prove(pane({ foreground: () => 'other' }), 400))
    expect(result).toEqual({ outcome: 'handed-to-terminal' })
    expect(elapsed).toBeGreaterThanOrEqual(390)
  })

  it('calls an agent too brief to be seen an exit, from the shell reporting its line finished', async () => {
    const { result, elapsed } = await timed(
      prove(pane({ foreground: () => 'shell', finishedAt: 50 }), 5_000)
    )
    expect(result).toEqual({ outcome: 'not-delivered', reason: 'agent-exited' })
    expect(elapsed).toBeLessThan(1_000)
  })

  it('never takes a command that finished before the launch for its exit', async () => {
    const runtime = pane({ foreground: () => 'shell', finishedAt: 0 })
    await expect(prove(runtime, 400, Date.now() + 60_000)).resolves.toEqual({
      outcome: 'handed-to-terminal'
    })
  })

  it('reads a shell in front with nothing finished as not yet run, never as an exit', async () => {
    await expect(prove(pane({ foreground: () => 'shell' }), 400)).resolves.toEqual({
      outcome: 'handed-to-terminal'
    })
  })

  it("takes the agent's own hook turn as proof, whatever holds the terminal", async () => {
    await expect(
      prove(pane({ foreground: () => 'other', hookTurn: 'observed' }), 5_000)
    ).resolves.toEqual({ outcome: 'handed-to-terminal' })
  })

  // Why: bookkeeping never gates the caller's follow-up, nor fails a launch whose agent runs.
  it('leaves the prompt handed over when the host cannot answer', async () => {
    const broken = pane({ foreground: () => 'launched-agent' })
    broken.observeTerminalLaunchTurnStart.mockImplementation(() => {
      throw new Error('terminal_not_writable')
    })
    broken.getTerminalPromptRequestBinding.mockImplementation(() => {
      throw new Error('terminal_not_writable')
    })
    await expect(prove(broken)).resolves.toEqual({ outcome: 'handed-to-terminal' })
  })
})
