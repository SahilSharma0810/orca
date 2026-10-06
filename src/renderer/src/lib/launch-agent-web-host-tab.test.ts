import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  tabsByWorktree: {} as Record<string, unknown[]>,
  closeTab: vi.fn(),
  setActiveTabType: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
const web = vi.hoisted(() => ({
  createWebRuntimeAgentSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebTerminalSurfaceTabId: vi.fn(() => true)
}))
vi.mock('@/runtime/web-runtime-session', () => web)
const showAgentLaunchPromptNotDeliveredNotice = vi.hoisted(() => vi.fn())
vi.mock('@/lib/agent-launch-prompt-not-delivered-notice', () => ({
  showAgentLaunchPromptNotDeliveredNotice
}))

const { launchAgentInWebHostTab } = await import('./launch-agent-web-host-tab')

function launch(promptDelivery: 'auto-submit' | 'submit-after-ready') {
  return launchAgentInWebHostTab({
    agent: 'claude',
    worktreeId: 'wt-1',
    environmentId: 'env-1',
    startupPlan: {
      agent: 'claude',
      launchCommand: 'claude',
      expectedProcess: 'claude',
      launchConfig: { agentArgs: '', agentEnv: {} }
    },
    prompt: 'resolve these threads',
    promptDelivery,
    pastePromptAfterReady: 'resolve these threads',
    submitPastedPrompt: true
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// Why: an AI button waits on this answer to say "started"; a paste the host could not land must not
// leave the click with no word at all.
describe('a paired host whose paste did not land', () => {
  it('tells a caller that acts on the result, once, with the prompt to copy', async () => {
    web.createWebRuntimeAgentSessionTerminal.mockResolvedValue({
      outcome: { status: 'created' },
      promptDelivered: false
    })

    await expect(launch('submit-after-ready')).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    expect(showAgentLaunchPromptNotDeliveredNotice).toHaveBeenCalledExactlyOnceWith({
      agent: 'claude',
      prompt: 'resolve these threads'
    })
  })

  it('stays quiet for a launch nothing waits on, as before', async () => {
    web.createWebRuntimeAgentSessionTerminal.mockResolvedValue({
      outcome: { status: 'created' },
      promptDelivered: false
    })

    await expect(launch('auto-submit')).resolves.toEqual({
      delivered: false,
      failureNotified: false
    })
    expect(showAgentLaunchPromptNotDeliveredNotice).not.toHaveBeenCalled()
  })
})
