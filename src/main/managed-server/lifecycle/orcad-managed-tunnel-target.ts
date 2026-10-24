import { withRuntimeSshTunnelLocalPort } from '../../../shared/runtime-environment-managed-tunnel-port'
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import {
  readManagedOrcadPublishedPort,
  resolveManagedOrcadTunnelPort,
  type OrcadTunnelPortInput
} from './orcad-managed-bound-port'
import {
  orcadIdentityRefusal,
  verifyManagedOrcadTunnelIdentity,
  type OrcadTunnelIdentity
} from './orcad-managed-tunnel-identity'
import { managedOrcadSlot } from './orcad-managed-runtime-context'
import { wakeStoppedManagedOrcad } from './orcad-managed-wake'
import { resolveOrcadRemoteContext } from '../install/orcad-remote-context'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type { PortForwardEntry } from '../../../shared/ssh-types'
import type { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'

export type OrcadManagedTunnelTargeting = {
  resolveRemotePort: (input: OrcadTunnelPortInput) => Promise<number>
  verifyIdentity: (environment: KnownRuntimeEnvironment) => Promise<OrcadTunnelIdentity>
  /** Wake only proven-stopped slots before rereading a moved or unreachable server. */
  wakeStoppedServer?: (input: OrcadTunnelPortInput) => Promise<void>
  readPublishedPort?: (input: OrcadTunnelPortInput) => Promise<number | null>
}

export const MANAGED_ORCAD_TUNNEL_TARGETING: OrcadManagedTunnelTargeting = {
  resolveRemotePort: resolveManagedOrcadTunnelPort,
  verifyIdentity: verifyManagedOrcadTunnelIdentity,
  wakeStoppedServer: wakeStoppedManagedOrcadForTunnel,
  readPublishedPort: readManagedOrcadPublishedPort
}

// Stopped slots may have lost their port; waking publishes a new free port for the reread.
async function wakeStoppedManagedOrcadForTunnel(input: OrcadTunnelPortInput): Promise<void> {
  const access = getRuntimeSshAccess(input.environment)
  if (!access) {
    return
  }
  try {
    const context = await resolveOrcadRemoteContext(input.target, input.connection)
    await wakeStoppedManagedOrcad(managedOrcadSlot(context, access.remotePort))
  } catch (error) {
    // Failed wake does not settle identity; reread and validate the resulting forward.
    console.warn('[ssh] Could not start the managed Orca server behind a foreign answer:', error)
  }
}

/** Tests may trust persisted ports without an identity round trip. */
export const PERSISTED_PORT_TARGETING: OrcadManagedTunnelTargeting = {
  resolveRemotePort: async ({ environment }) => getRuntimeSshAccess(environment)?.remotePort ?? 0,
  verifyIdentity: async () => ({ verdict: 'verified' })
}

type VerifiedOrcadForwardArgs = {
  targetId: string
  connection: SshConnection
  forwards: SshPortForwardManager
  localPort: number
  label: string
  remotePort: number
  /** Without a reread, foreign answers fail immediately. */
  rereadRemotePort?: () => Promise<number>
  /** Omit when the caller validates identity itself. */
  verify?: (localPort: number) => Promise<OrcadTunnelIdentity>
  stillCurrent: () => boolean
  onLocalPortRecovered?: (localPort: number) => void
  wakeStoppedServer?: () => Promise<number>
}

export type OrcadTunnelStartChecks = Pick<
  VerifiedOrcadForwardArgs,
  'rereadRemotePort' | 'verify'
> & {
  /** Persisted preferred port when the server bound elsewhere. */
  preferredPort?: number
}

export async function environmentForwardChecks(
  targeting: OrcadManagedTunnelTargeting,
  input: OrcadTunnelPortInput
): Promise<
  Required<Pick<VerifiedOrcadForwardArgs, 'remotePort' | 'rereadRemotePort' | 'verify'>> &
    Pick<VerifiedOrcadForwardArgs, 'wakeStoppedServer'>
> {
  const wakeAndResolve = async () => {
    await targeting.wakeStoppedServer?.(input)
    return targeting.resolveRemotePort(input)
  }
  return {
    remotePort: await targeting.resolveRemotePort(input),
    rereadRemotePort: wakeAndResolve,
    ...(targeting.wakeStoppedServer ? { wakeStoppedServer: wakeAndResolve } : {}),
    verify: (localPort) =>
      targeting.verifyIdentity(withRuntimeSshTunnelLocalPort(input.environment, localPort))
  }
}

/** Remove superseded forwards; retry foreign ports once. Pinned-server token refusals fail immediately. */
export async function forwardToVerifiedOrcad(
  args: VerifiedOrcadForwardArgs
): Promise<PortForwardEntry | null> {
  let remotePort = args.remotePort
  let localPort = args.localPort
  let recoveredLocalPort = false
  let attemptedWake = false
  for (let attempt = 0; ; attempt++) {
    let forward: PortForwardEntry | null
    try {
      forward = await addCurrentForward({ ...args, localPort }, remotePort)
    } catch (error) {
      if (!args.stillCurrent()) {
        return null
      }
      if (
        recoveredLocalPort ||
        !args.onLocalPortRecovered ||
        !args.verify ||
        localPort === 0 ||
        !(error instanceof Error) ||
        error.cause !== 'EADDRINUSE'
      ) {
        throw error
      }
      recoveredLocalPort = true
      forward = await addCurrentForward({ ...args, localPort: 0 }, remotePort)
      if (forward) {
        localPort = forward.localPort
      }
    }
    if (!forward) {
      return null
    }
    let identity: OrcadTunnelIdentity
    try {
      identity = args.verify ? await args.verify(forward.localPort) : { verdict: 'verified' }
    } catch (error) {
      await args.forwards.removeForwardAndWait(forward.id)
      throw error
    }
    if (!args.stillCurrent()) {
      await args.forwards.removeForwardAndWait(forward.id)
      return null
    }
    if (recoveredLocalPort && identity.verdict === 'unreachable') {
      await args.forwards.removeForwardAndWait(forward.id)
      if (!attemptedWake && args.wakeStoppedServer) {
        attemptedWake = true
        remotePort = await args.wakeStoppedServer()
        if (!args.stillCurrent()) {
          return null
        }
        continue
      }
      throw new Error(`Could not verify the replacement SSH tunnel: ${identity.detail}`)
    }
    if (identity.verdict === 'verified' || identity.verdict === 'unreachable') {
      if (recoveredLocalPort) {
        try {
          args.onLocalPortRecovered?.(forward.localPort)
        } catch (error) {
          await args.forwards.removeForwardAndWait(forward.id)
          throw error
        }
      }
      if (identity.verdict === 'unreachable') {
        // Unreachable servers may be down or starting; this is not proof of a foreign server.
        console.warn(
          `[ssh] Managed Orca server did not answer through its tunnel: ${identity.detail}`
        )
      }
      return forward
    }
    await args.forwards.removeForwardAndWait(forward.id)
    // Token refusal from our pinned server is not a moved port; waking cannot repair pairing.
    if (identity.verdict === 'unpaired') {
      throw orcadIdentityRefusal(remotePort, identity)
    }
    const canReread = attempt === 0 && args.rereadRemotePort
    attemptedWake ||= Boolean(canReread)
    const reread = canReread ? await canReread() : remotePort
    if (reread === remotePort || !args.stillCurrent()) {
      throw orcadIdentityRefusal(remotePort, identity)
    }
    remotePort = reread
  }
}

async function addCurrentForward(
  args: VerifiedOrcadForwardArgs,
  remotePort: number
): Promise<PortForwardEntry | null> {
  const forward = await args.forwards.addForward(
    args.targetId,
    args.connection,
    args.localPort,
    '127.0.0.1',
    remotePort,
    args.label
  )
  if (args.localPort !== 0 && forward.localPort !== args.localPort) {
    await args.forwards.removeForwardAndWait(forward.id)
    throw new Error('Managed Orca tunnel bound an unexpected local port.')
  }
  if (!args.stillCurrent()) {
    await args.forwards.removeForwardAndWait(forward.id)
    return null
  }
  return forward
}
