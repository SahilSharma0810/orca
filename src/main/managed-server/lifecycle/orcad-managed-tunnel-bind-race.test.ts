import { createServer } from 'node:net'
import { expect, it, vi } from 'vitest'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import type { PortForwardStartOptions } from '../../ssh/port-forwarding/ssh-port-forward-provider'
import { listenForPortForward } from '../../ssh/port-forwarding/ssh2-port-forward-provider'
import { listenOrcadStdioBridge } from './orcad-stdio-bridge-listener'
import { OrcadManagedTunnelTransportProvider } from './orcad-managed-tunnel-transport'
import { forwardToVerifiedOrcad } from './orcad-managed-tunnel-target'

it('recovers a real listener bind race through the managed transport and stdio fallback', async () => {
  const blocker = createServer()
  await listenForPortForward(blocker, '127.0.0.1', 0)
  const address = blocker.address()
  if (!address || typeof address === 'string') {
    throw new Error('No blocker TCP port')
  }
  const listen = async (_connection: SshConnection, options: PortForwardStartOptions) =>
    listenOrcadStdioBridge(options, async () => {
      throw new Error('No sockets should connect in this test')
    })
  const provider = { canHandle: () => true, start: listen }
  const transport = new OrcadManagedTunnelTransportProvider({
    forwards: [provider],
    stdio: provider,
    probe: async () => 'allowed',
    checkForward: async () => 'allowed',
    reserveLocalPort: async () => {}
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real forward manager and injected providers read only these connection methods.
  const connection = {
    isDisposed: () => false,
    getConnectGeneration: () => 1
  } as unknown as SshConnection
  const forwards = new SshPortForwardManager({}, [transport])
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let saved: number | undefined
  try {
    const forward = await forwardToVerifiedOrcad({
      targetId: 'ssh-bind-race',
      connection,
      forwards,
      localPort: address.port,
      remotePort: 6768,
      label: 'test',
      verify: async () => ({ verdict: 'verified' }),
      stillCurrent: () => true,
      onLocalPortRecovered: (port) => {
        saved = port
      }
    })
    expect(forward?.localPort).not.toBe(address.port)
    expect(saved).toBe(forward?.localPort)
    expect(blocker.listening).toBe(true)
  } finally {
    await forwards.closeAll()
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
    warn.mockRestore()
  }
})
