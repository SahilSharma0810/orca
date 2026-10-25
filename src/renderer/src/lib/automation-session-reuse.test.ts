import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AutomationRun } from '../../../shared/automations-types'
import { findReusableAutomationSession } from './automation-session-reuse'

const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = `tab-1:${leafId}`
const splitLeafId = '22222222-2222-4222-8222-222222222222'
const splitPaneKey = `tab-1:${splitLeafId}`
const terminalTab: Tab = {
  id: 'tab-1',
  entityId: 'tab-1',
  groupId: 'group-1',
  worktreeId: 'wt-1',
  contentType: 'terminal',
  label: 'Claude',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

function run(overrides: Partial<AutomationRun>): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    title: 'Run 1',
    scheduledFor: 1,
    status: 'completed',
    trigger: 'manual',
    workspaceId: 'wt-1',
    workspaceDisplayName: 'Workspace',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab-1',
    terminalPaneKey: paneKey,
    terminalPtyId: 'pty-1',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 1,
    dispatchedAt: 1,
    createdAt: 1,
    ...overrides
  }
}

function status(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'previous',
    updatedAt: 10,
    stateStartedAt: 10,
    paneKey,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

describe('automation session reuse in the renderer store', () => {
  it.each([
    {},
    { state: 'working', workingMode: 'monitoring', mainAgent: { state: 'done', stateStartedAt: 5 } }
  ] satisfies Partial<AgentStatusEntry>[])(
    'uses the exact split-pane PTY with status %j',
    (agentStatus) => {
      const session = findReusableAutomationSession({
        automationId: 'auto-1',
        agentId: 'claude',
        worktreeId: 'wt-1',
        currentRunId: 'run-current',
        runs: [
          run({
            id: 'run-new',
            terminalSessionId: 'tab-1',
            terminalPaneKey: splitPaneKey,
            terminalPtyId: 'pty-right',
            createdAt: 2
          })
        ],
        state: {
          agentStatusByPaneKey: {
            [splitPaneKey]: status({ ...agentStatus, paneKey: splitPaneKey })
          },
          ptyIdsByTabId: { 'tab-1': ['pty-left', 'pty-right'] },
          terminalLayoutsByTabId: {
            'tab-1': {
              root: null,
              activeLeafId: leafId,
              expandedLeafId: null,
              ptyIdsByLeafId: {
                [leafId]: 'pty-left',
                [splitLeafId]: 'pty-right'
              }
            }
          },
          unifiedTabsByWorktree: {
            'wt-1': [terminalTab]
          }
        }
      })

      expect(session).toEqual({ tabId: 'tab-1', ptyId: 'pty-right', paneKey: splitPaneKey })
    }
  )

  it('does not reuse an unrelated split pane for a run with exact pane identity', () => {
    const session = findReusableAutomationSession({
      automationId: 'auto-1',
      agentId: 'claude',
      worktreeId: 'wt-1',
      currentRunId: 'run-current',
      runs: [run({ id: 'run-new', terminalSessionId: 'tab-1', createdAt: 2 })],
      state: {
        agentStatusByPaneKey: {
          [splitPaneKey]: status({ paneKey: splitPaneKey })
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-right'] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: null,
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: {
              [leafId]: 'pty-1',
              [splitLeafId]: 'pty-right'
            }
          }
        },
        unifiedTabsByWorktree: {
          'wt-1': [terminalTab]
        }
      }
    })

    expect(session).toBeNull()
  })

  it('rejects an exact run pane when its PTY is no longer live', () => {
    const session = findReusableAutomationSession({
      automationId: 'auto-1',
      agentId: 'claude',
      worktreeId: 'wt-1',
      currentRunId: 'run-current',
      runs: [run({ id: 'run-new', terminalSessionId: 'tab-1', createdAt: 2 })],
      state: {
        agentStatusByPaneKey: { [paneKey]: status() },
        ptyIdsByTabId: { 'tab-1': ['pty-other'] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: null,
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: 'pty-1' }
          }
        },
        unifiedTabsByWorktree: {
          'wt-1': [terminalTab]
        }
      }
    })

    expect(session).toBeNull()
  })
})
