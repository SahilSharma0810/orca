import type { AgentStatusEntry } from './agent-status-types'
import { agentChildWorkLiveness } from './agent-status-child-work-liveness'

export type AutomationAgentTurnStatus = Pick<
  AgentStatusEntry,
  | 'state'
  | 'workingMode'
  | 'mainAgent'
  | 'claudeTaskWakeupPending'
  | 'sessionBoundary'
  | 'children'
  | 'subagents'
> & { stateStartedAt?: number }

/** Foreground settlement is separate from whole-pane liveness and submitted-turn attribution. */
export function readAutomationAgentTurn(status: AutomationAgentTurnStatus): {
  state: AgentStatusEntry['state']
  stateStartedAt: number | undefined
  settled: boolean
  wholeWorkEnded: boolean
} {
  const state = status.mainAgent?.state ?? status.state
  const children = agentChildWorkLiveness(status.children)
  const blocked =
    state !== 'done' ||
    status.sessionBoundary === true ||
    status.claudeTaskWakeupPending !== undefined ||
    children === 'waiting' ||
    children === 'working' ||
    (status.children === undefined &&
      (status.subagents?.some((child) => child.state !== 'idle') ?? false))
  const wholeWorkEnded =
    !blocked && status.state === 'done' && !status.workingMode && children === null
  return {
    state,
    stateStartedAt: status.mainAgent?.stateStartedAt ?? status.stateStartedAt,
    settled:
      !blocked &&
      (wholeWorkEnded ||
        (status.state === 'working' &&
          status.workingMode === 'monitoring' &&
          status.mainAgent?.state === 'done')),
    wholeWorkEnded
  }
}
