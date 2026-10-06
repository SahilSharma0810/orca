/**
 * A desktop launch with a prompt, started through the host's `agent.launch`.
 *
 * This window owns the workspace's tab layout, so it makes the agent's tab at the click, in the
 * split it was asked for, as any new agent tab is made. Everything else is the host's: it records
 * the launch under this click's operation id, starts the agent into that tab's pane, and delivers
 * the prompt by its one rule. The pane's spawn waits until the host has taken it
 * (`agent-launch-pane-spawn-hold`), then attaches to the agent or says why it could not start.
 */

import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { rememberAgentLaunchPanePrompt } from '@/lib/agent-launch-pane-prompt'
import {
  holdAgentLaunchPaneSpawn,
  isAgentLaunchPaneSpawnHeld
} from '@/lib/agent-launch-pane-spawn-hold'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { callRuntimeRpc, RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import { createAgentSessionOperationId } from '@/runtime/agent-session-operation-id'
import { isAgentLaunchResult } from '../../../shared/agent-launch-intent'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { prefersStructuredNativeChatByDefault } from '../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { Tab } from '../../../shared/tab-types'

export type HostAgentLaunchArgs = {
  agent: TuiAgent
  worktreeId: string
  /** The split the launch was made from; the tab joins it. */
  groupId?: string
  /** Already trimmed and non-empty. */
  prompt: string
  /** Absent uses the settings default; `null` means no arguments. */
  agentArgs?: string | null
  cwd?: string
  sessionOptions?: Readonly<Record<string, string>>
  launchSource?: LaunchSource
  quickCommandLabel?: string | null
  /** The launch seeds a workspace being opened, so its spawn must not reshuffle Recent. */
  pendingActivationSpawn?: boolean
  /** The view the tab opens in, decided as for any new agent tab. */
  viewMode?: Tab['viewMode']
}

/** What became of the launch, as this window must tell it. */
export type HostAgentLaunchDelivery =
  | { kind: 'delivered' }
  /** The agent runs (or ran) without the prompt. */
  | { kind: 'not-delivered'; agentExited: boolean }
  /** The agent runs; whether it has the prompt is unknown, so it must not be sent again. */
  | { kind: 'unconfirmed' }
  /** The pane shows how the launch ended: couldn't start, or couldn't confirm it started. */
  | { kind: 'pane-says' }
  /** The tab is gone, so the window says it: nothing started, or whether it did is unknown. */
  | { kind: 'not-started'; unconfirmed: boolean; code?: string }

/** Refused at admission: nothing ran under this click, and the host takes back the tab it was shown. */
const ADMISSION_REFUSAL_CODES = new Set([
  'agent_session_operation_invalid',
  'agent_session_operation_conflict',
  'agent_session_operation_expired',
  'agent_session_operation_capacity'
])

function tabExists(worktreeId: string, tabId: string): boolean {
  return (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)
}

function closeLaunchTab(worktreeId: string, tabId: string): void {
  if (tabExists(worktreeId, tabId)) {
    useAppStore.getState().closeTab(tabId, { recordInteraction: false })
  }
}

function deliveryFromResult(result: unknown): HostAgentLaunchDelivery {
  if (!isAgentLaunchResult(result)) {
    return { kind: 'unconfirmed' }
  }
  switch (result.prompt?.outcome) {
    case 'handed-to-terminal':
    case 'journaled':
      return { kind: 'delivered' }
    case 'unconfirmed':
      return { kind: 'unconfirmed' }
    case 'not-delivered':
      return { kind: 'not-delivered', agentExited: result.prompt.reason === 'agent-exited' }
    case undefined:
      // A missing receipt under-claims: the caller keeps the text.
      return { kind: 'not-delivered', agentExited: false }
  }
}

function launchParams(args: HostAgentLaunchArgs) {
  return {
    agent: args.agent,
    target: { kind: 'existing', worktree: `id:${args.worktreeId}` },
    prompt: { text: args.prompt, delivery: 'submit' },
    ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(args.sessionOptions ? { sessionOptions: args.sessionOptions } : {}),
    ...(args.launchSource ? { launchSource: args.launchSource } : {}),
    ...(args.groupId ? { placement: { groupId: args.groupId } } : {}),
    presentation: 'focused'
  }
}

/**
 * The ledger is bookkeeping: a desktop past its per-caller row cap still gets its agent, through the
 * host's unrecorded launch into the same pane. The refused launch already took back the tab it was
 * shown, so the tab closes and returns at spawn (rare: 512 launches a day); the host's reveal at
 * spawn hands the pane over (`terminal-presentation-ipc-bridge`).
 */
async function launchWithoutRecord(
  args: HostAgentLaunchArgs,
  pane: { tabId: string; leafId: string; windowMade: boolean }
): Promise<HostAgentLaunchDelivery> {
  try {
    return deliveryFromResult(
      await callRuntimeRpc<unknown>({ kind: 'local' }, 'agent.launch', {
        ...launchParams(args),
        paneKey: makePaneKey(pane.tabId, pane.leafId)
      })
    )
  } catch (error) {
    const code = error instanceof RuntimeRpcCallError ? error.code : undefined
    // A pane the host never revealed would open as a shell; one it did holds the agent's terminal.
    if (pane.windowMade && isAgentLaunchPaneSpawnHeld(pane.tabId, pane.leafId)) {
      closeLaunchTab(args.worktreeId, pane.tabId)
    }
    return { kind: 'not-started', unconfirmed: false, ...(code ? { code } : {}) }
  }
}

async function settleLaunch(
  args: HostAgentLaunchArgs,
  pane: { tabId: string; leafId: string; windowMade: boolean },
  send: Promise<unknown>,
  releaseHold: () => void
): Promise<HostAgentLaunchDelivery> {
  try {
    return deliveryFromResult(await send)
  } catch (error) {
    const code = error instanceof RuntimeRpcCallError ? error.code : undefined
    if (code === 'agent_session_operation_capacity') {
      // Awaited: the pane stays held until the unrecorded launch has its answer.
      return await launchWithoutRecord(args, pane)
    }
    // The host took the pane once it showed the tab; a window-made pane it never took would open as
    // a shell, and a refused one is the host's to take back.
    const hostTookPane = pane.windowMade
      ? !isAgentLaunchPaneSpawnHeld(pane.tabId, pane.leafId)
      : tabExists(args.worktreeId, pane.tabId)
    if (!hostTookPane || (code !== undefined && ADMISSION_REFUSAL_CODES.has(code))) {
      if (pane.windowMade) {
        closeLaunchTab(args.worktreeId, pane.tabId)
      }
      return {
        kind: 'not-started',
        unconfirmed: code === 'agent_session_operation_unknown',
        ...(code ? { code } : {})
      }
    }
    return { kind: 'pane-says' }
  } finally {
    releaseHold()
  }
}

export function launchAgentThroughHost(args: HostAgentLaunchArgs): {
  /** Null when the host shows the tab itself. */
  tabId: string | null
  delivery: Promise<HostAgentLaunchDelivery>
} {
  const store = useAppStore.getState()
  const tabId = createBrowserUuid()
  const leafId = createBrowserUuid()
  // Why: the window makes the tab only where the host cannot turn the launch into a chat, which the
  // host's own first check reads off these same settings; a chat names its tab by this pane's tab.
  const windowMakesTab = !prefersStructuredNativeChatByDefault(store.settings)
  // Before the tab exists, so its first mount already waits.
  const releaseHold = windowMakesTab ? holdAgentLaunchPaneSpawn(tabId, leafId) : () => {}
  const send = callRuntimeRpc<unknown>({ kind: 'local' }, 'agent.launchReplay', {
    ...launchParams(args),
    // A new click is a new operation; the pane is this click's too.
    operationId: createAgentSessionOperationId(),
    paneKey: makePaneKey(tabId, leafId)
  })
  if (!windowMakesTab) {
    return {
      tabId: null,
      delivery: settleLaunch(args, { tabId, leafId, windowMade: false }, send, releaseHold)
    }
  }
  store.createTab(args.worktreeId, args.groupId, undefined, {
    id: tabId,
    initialLeafId: leafId,
    agentLaunchPane: { leafId },
    launchAgent: args.agent,
    quickCommandLabel: args.quickCommandLabel,
    ...(args.pendingActivationSpawn ? { pendingActivationSpawn: true } : {}),
    ...(args.viewMode ? { viewMode: args.viewMode } : {})
  })
  rememberAgentLaunchPanePrompt(tabId, args.prompt)
  seedNativeChatAppliedSessionOptions(tabId, args.agent, args.sessionOptions)
  // Why: without it an activated launch can stay hidden behind an editor.
  store.setActiveTabType('terminal', args.worktreeId)
  persistAgentLaunchTabOrder(args.worktreeId, tabId)
  return {
    tabId,
    delivery: settleLaunch(args, { tabId, leafId, windowMade: true }, send, releaseHold)
  }
}
