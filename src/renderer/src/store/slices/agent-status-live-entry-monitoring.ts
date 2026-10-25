import { agentProviderSessionsEqual } from '../../../../shared/agent-session-resume'
import { sameAgentStatusTerminalOwner } from '../../../../shared/agent-status-terminal-owner'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentStatusPayload } from './agent-status-contract'

export function resolveAgentStatusLiveEntryMonitoring(
  existing: AgentStatusEntry | undefined,
  payload: AgentStatusPayload,
  identity: Pick<
    AgentStatusEntry,
    'agentType' | 'providerSession' | 'terminalHandle' | 'connectionId' | 'worktreeId'
  >
): Pick<AgentStatusEntry, 'workingMode' | 'claudeTaskWakeupPending'> {
  const retainOscFacts =
    payload.observation?.origin === 'osc' &&
    existing?.state === payload.state &&
    existing.agentType === identity.agentType &&
    agentProviderSessionsEqual(
      identity.agentType,
      existing.providerSession,
      identity.providerSession
    ) &&
    payload.sessionBoundary !== true &&
    existing.terminalHandle === identity.terminalHandle &&
    sameAgentStatusTerminalOwner(existing, identity)
  return {
    workingMode: payload.workingMode ?? (retainOscFacts ? existing.workingMode : undefined),
    claudeTaskWakeupPending:
      payload.claudeTaskWakeupPending ??
      (retainOscFacts ? existing.claudeTaskWakeupPending : undefined)
  }
}
