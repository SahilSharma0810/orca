import { readFileSync } from 'node:fs'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { TUI_AGENT_CONFIG, isTuiAgent } from '../../shared/tui-agent-config'
import { findReusableAutomationRun } from '../../shared/automation-session-reuse'
import { readAutomationAgentTurn } from '../../shared/automation-agent-turn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../shared/automations-types'
import { RUN_TERMINAL_GRACE_MS } from './headless-run-terminal-retention'

vi.mock('./service', () => ({
  AutomationService: class {
    start = vi.fn()
    stop = vi.fn()
    markDispatchResult = vi.fn(async () => ({}))
    runInAutomationLane = <T>(_automationId: string, operation: () => Promise<T>): Promise<T> =>
      operation()
  }
}))

import { createRuntimeAutomationService } from './runtime-automation-service'

function finishedRuns(count: number): AutomationRun[] {
  return Array.from(
    { length: count },
    (_, n) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retention reads only these run fields.
      ({
        id: `r${n}`,
        automationId: 'nightly',
        status: 'completed',
        error: null,
        terminalPaneKey: `tab-${n}:1`,
        terminalPtyId: `pty-${n}`,
        workspaceId: `wt-${n}`,
        dispatchedAt: n,
        startedAt: n,
        createdAt: n
      }) as AutomationRun
  )
}

function firstRunOwnsWorkspace(worktreeId: string) {
  return worktreeId === 'wt-0' ? { automationProvenance: { automationRunId: 'r0' } } : undefined
}

function build(headless: boolean) {
  const runtime = {
    getAgentStatusRowsForPane: vi.fn((paneKey: string): AgentStatusIpcPayload[] => [
      {
        paneKey,
        state: 'done',
        prompt: '',
        connectionId: null,
        receivedAt: 1,
        stateStartedAt: 1
      }
    ]),
    setAutomationService: vi.fn(),
    notifyAutomationsChanged: vi.fn(),
    getTerminalHandleForPaneKey: vi.fn((paneKey: string) => `handle:${paneKey}`),
    getTerminalPtyIdForHandle: vi.fn((handle: string) => `pty-${handle.split('tab-')[1]?.[0]}`),
    readTerminalClientUse: vi.fn((ptyId: string) => (ptyId === 'pty-1' ? 'used' : 'unused')),
    closeTerminal: vi.fn(async (_handle: string) => ({})),
    confirmTerminalShellAlone: vi.fn(async (_ptyId: string) => false),
    closeTerminalTab: vi.fn(async (_handle: string) => ({})),
    sleepTerminalsForWorktree: vi.fn(
      async (
        _selector: string,
        options: { soleLivePtyId?: string }
      ): Promise<{ livePtyIds: string[]; stoppedPtyIds: string[] }> => ({
        livePtyIds: [options.soleLivePtyId ?? ''],
        stoppedPtyIds: [options.soleLivePtyId ?? '']
      })
    )
  }
  const store = {
    listAutomationRuns: vi.fn(() => finishedRuns(5)),
    listAutomations: () => [],
    getWorktreeMeta: vi.fn(
      (
        _worktreeId: string
      ): { automationProvenance: { automationRunId: string; origin?: 'client' } } | undefined =>
        undefined
    )
  }
  const service = createRuntimeAutomationService({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked service and retention read only listAutomationRuns.
    store: store as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retention reads only the members faked above.
    runtime: runtime as never,
    headless
  })
  return { runtime, service, store }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('headless automation service run terminal retention', () => {
  it.each([false, true])(
    'retains recorded Monitor work through sweep/drain (own workspace=%s)',
    async (own) => {
      vi.useFakeTimers()
      const { runtime, service, store } = build(true)
      if (own) {
        store.getWorktreeMeta.mockImplementation(firstRunOwnsWorkspace)
      }
      const paneKey = 'tab-0:11111111-1111-4111-8111-111111111111'
      store.listAutomationRuns.mockReturnValue(
        finishedRuns(4).map((run) => (run.id === 'r0' ? { ...run, terminalPaneKey: paneKey } : run))
      )
      runtime.readTerminalClientUse.mockImplementation((ptyId) =>
        ptyId === 'pty-0' ? 'unused' : 'used'
      )
      const trace: { scenario: string; payload: Record<string, unknown> }[] = readFileSync(
        new URL('../../shared/__fixtures__/claude-task-notification-hooks.jsonl', import.meta.url),
        'utf8'
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const events = trace.filter((row) => row.scenario === 'monitor-events')
      const stop = events.findIndex((row) => row.payload.hook_event_name === 'Stop')
      expect(events[stop].payload.background_tasks).toMatchObject([
        { type: 'shell', status: 'running' }
      ])
      const state = createHookListenerState()
      const publish = (payload: unknown) => {
        const event = normalizeHookPayload(state, 'claude', { paneKey, payload }, 'production')
        if (!event) {
          return runtime.getAgentStatusRowsForPane(paneKey)[0]
        }
        const row = {
          ...event.payload,
          paneKey,
          connectionId: null,
          receivedAt: Date.now(),
          stateStartedAt: 1
        }
        runtime.getAgentStatusRowsForPane.mockReturnValue([row])
        return row
      }
      events.slice(0, stop + 1).forEach((row) => publish(row.payload))
      service.start()
      await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS + 2 * 60_000)
      // The seed is captured; these two ordinary cycles are composed with the same live shell inventory.
      for (let cycle = 0; cycle < 2; cycle++) {
        const working = publish(events[1].payload)
        expect(readAutomationAgentTurn(working).settled).toBe(false)
        const ended = publish(events[stop].payload)
        expect(readAutomationAgentTurn(ended).settled).toBe(true)
        for (const agentId of Object.keys(TUI_AGENT_CONFIG).filter(isTuiAgent)) {
          expect(
            findReusableAutomationRun({
              automationId: 'nightly',
              agentId,
              worktreeId: 'wt-0',
              currentRunId: 'next',
              runs: store.listAutomationRuns(),
              agentStatusForPane: () => ({ ...ended, agentType: agentId }),
              liveSession: (run) => (run.id === 'r0' ? run.terminalPtyId : null)
            })
          ).toBe('pty-0')
        }
        expect(ended).toMatchObject({
          state: 'working',
          workingMode: 'monitoring',
          mainAgent: { state: 'done' }
        })
        await service.releaseFinishedRunTerminals?.()
      }
      expect(runtime.closeTerminal).not.toHaveBeenCalled()
      expect(runtime.sleepTerminalsForWorktree).not.toHaveBeenCalled()
      // Real task-notification/finishing-turn events must keep the same pane alive too.
      for (const event of events.slice(stop + 1)) {
        publish(event.payload)
      }
      expect(
        readAutomationAgentTurn(runtime.getAgentStatusRowsForPane(paneKey)[0]).wholeWorkEnded
      ).toBe(true)
      await service.releaseFinishedRunTerminals?.()
      expect(own ? runtime.sleepTerminalsForWorktree : runtime.closeTerminal).toHaveBeenCalled()
      service.stop()
    }
  )

  it('closes finished run terminals on orcad once the service runs, and stops with it', async () => {
    vi.useFakeTimers()
    const { runtime, service } = build(true)
    service.start()
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS + 2 * 60_000)

    expect(runtime.closeTerminal.mock.calls.map(([handle]) => handle)).toEqual(['handle:tab-0:1'])
    expect(runtime.closeTerminalTab).not.toHaveBeenCalled()
    expect(service.markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'r0', status: 'completed', terminalPaneKey: null })
    )

    service.stop()
    runtime.closeTerminal.mockClear()
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS * 2)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('closes nothing in a pane a restart gave a new PTY, and still forgets the old one', async () => {
    vi.useFakeTimers()
    const { runtime, service } = build(true)
    runtime.getTerminalPtyIdForHandle.mockImplementation((handle: string) =>
      handle === 'handle:tab-0:1' ? 'pty-user' : `pty-${handle.split('tab-')[1]?.[0]}`
    )
    service.start()
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS + 2 * 60_000)

    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(service.markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'r0', terminalPaneKey: null, terminalPtyId: null })
    )
    service.stop()
  })

  it('fails and closes a dispatched run whose agent exited, proven by its shell alone', async () => {
    vi.useFakeTimers()
    const { runtime, service, store } = build(true)
    store.listAutomationRuns.mockReturnValue([
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: retention reads only these run fields.
      { ...finishedRuns(1)[0], status: 'dispatched' } as AutomationRun
    ])
    runtime.getAgentStatusRowsForPane.mockReturnValue([])
    runtime.confirmTerminalShellAlone.mockResolvedValue(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked service exposes the drain hook it was given.
    const drain = (service as unknown as { releaseFinishedRunTerminals: () => Promise<number> })
      .releaseFinishedRunTerminals
    await expect(drain()).resolves.toBe(1)
    expect(runtime.confirmTerminalShellAlone).toHaveBeenCalledWith('pty-0')
    expect(service.markDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'r0', status: 'dispatch_failed', terminalPtyId: null })
    )
  })

  it('leaves run terminals to the renderer on the desktop', async () => {
    vi.useFakeTimers()
    const { runtime, service } = build(false)
    service.start()
    await vi.advanceTimersByTimeAsync(RUN_TERMINAL_GRACE_MS * 2)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('sleeps a completed run in its own workspace, dropping only its PTY id', async () => {
    const { runtime, service, store } = build(true)
    store.getWorktreeMeta.mockImplementation(firstRunOwnsWorkspace)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked service exposes the drain hook it was given.
    const drain = (service as unknown as { releaseFinishedRunTerminals: () => Promise<number> })
      .releaseFinishedRunTerminals
    await expect(drain()).resolves.toBe(4)

    expect(runtime.sleepTerminalsForWorktree).toHaveBeenCalledWith('id:wt-0', {
      soleLivePtyId: 'pty-0'
    })
    expect(runtime.sleepTerminalsForWorktree).toHaveBeenCalledTimes(1)
    expect(service.markDispatchResult).toHaveBeenCalledWith({
      runId: 'r0',
      status: 'completed',
      terminalPtyId: null
    })
    expect(runtime.closeTerminal.mock.calls.map(([handle]) => handle).toSorted()).toEqual([
      'handle:tab-2:1',
      'handle:tab-3:1',
      'handle:tab-4:1'
    ])
  })

  // Why: a client-origin label names another owner's run, even if its id matches one of ours.
  it('does not let a client-origin label claim a host run’s workspace', async () => {
    const { runtime, service, store } = build(true)
    store.getWorktreeMeta.mockImplementation((worktreeId: string) =>
      worktreeId === 'wt-0'
        ? { automationProvenance: { automationRunId: 'r0', origin: 'client' } }
        : undefined
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked service exposes the drain hook it was given.
    const drain = (service as unknown as { releaseFinishedRunTerminals: () => Promise<number> })
      .releaseFinishedRunTerminals
    await drain()

    expect(runtime.sleepTerminalsForWorktree).not.toHaveBeenCalled()
    expect(runtime.closeTerminal).toHaveBeenCalledWith('handle:tab-0:1')
  })

  it.each([
    [
      'another terminal there is live',
      async () => ({ livePtyIds: ['pty-0', 'pty-user'], stoppedPtyIds: [] })
    ],
    ['the sleep throws', () => Promise.reject(new Error('terminal_worktree_sleep_failed'))],
    [
      'its PTY is gone but another terminal is live',
      async () => ({ livePtyIds: ['pty-user'], stoppedPtyIds: [] })
    ],
    [
      'the stop left its PTY live',
      async () => ({
        livePtyIds: ['pty-0'],
        stoppedPtyIds: ['pty-0'],
        remainingLivePtyIds: ['pty-0']
      })
    ]
  ])('keeps a run in its own workspace, ids and all, when %s', async (_case, sleep) => {
    const { runtime, service, store } = build(true)
    store.getWorktreeMeta.mockImplementation(firstRunOwnsWorkspace)
    store.listAutomationRuns.mockReturnValue(finishedRuns(1))
    runtime.sleepTerminalsForWorktree.mockImplementation(sleep)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked service exposes the drain hook it was given.
    const drain = (service as unknown as { releaseFinishedRunTerminals: () => Promise<number> })
      .releaseFinishedRunTerminals
    await expect(drain()).resolves.toBe(0)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(service.markDispatchResult).not.toHaveBeenCalled()
  })
})
