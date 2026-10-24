import {
  getOrcadSshDeployment,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import {
  activeTunnelMatches,
  dropActiveOrcadTunnel,
  managedTunnelStillPaired,
  recordActiveOrcadTunnel,
  resolveManagedTunnelBinding,
  supersededTunnelError,
  type ActiveOrcadTunnel
} from './orcad-managed-tunnel-active'
import {
  environmentForwardChecks,
  forwardToVerifiedOrcad,
  type OrcadManagedTunnelTargeting
} from './orcad-managed-tunnel-target'
import type { OrcadTunnelServing } from './orcad-managed-tunnel-serving'

export type ManagedTunnelPortRecovery = {
  replaceLocalPort?: (
    expected: KnownRuntimeEnvironment,
    localPort: number
  ) => KnownRuntimeEnvironment
}

function managedTunnelLocalPortRecovery(
  environment: KnownRuntimeEnvironment,
  recovery: ManagedTunnelPortRecovery,
  stillCurrent: () => boolean,
  onSaved: (environment: KnownRuntimeEnvironment, localPort: number) => void
): ((localPort: number) => void) | undefined {
  const replaceLocalPort = recovery.replaceLocalPort
  if (!replaceLocalPort || !getOrcadSshDeployment(environment)) {
    return undefined
  }
  return (localPort) => {
    if (!stillCurrent()) {
      throw supersededTunnelError()
    }
    onSaved(replaceLocalPort(environment, localPort), localPort)
  }
}

type ManagedTunnelEnsureContext = {
  dependencies: Parameters<typeof resolveManagedTunnelBinding>[1]
  active: Map<string, ActiveOrcadTunnel>
  buildTargets: Map<string, string>
  getManagerGeneration: () => number
  ownershipGenerations: Map<string, number>
  forwards: SshPortForwardManager
  targeting: OrcadManagedTunnelTargeting
  checkServing: (environment: KnownRuntimeEnvironment) => Promise<OrcadTunnelServing>
}

export async function ensureManagedOrcadTunnelBinding(
  context: ManagedTunnelEnsureContext,
  environment: KnownRuntimeEnvironment,
  resolveCurrent: () => KnownRuntimeEnvironment | null,
  portRecovery: ManagedTunnelPortRecovery = {},
  rebound = false
): Promise<void> {
  const { deployment, targetStore, connectionManager, target } = resolveManagedTunnelBinding(
    environment,
    context.dependencies
  )
  context.buildTargets.set(environment.id, target.id)
  const managerGeneration = context.getManagerGeneration()
  const ownershipGeneration = context.ownershipGenerations.get(environment.id) ?? 0
  let ownedEnvironment = environment
  const expected = { environmentId: environment.id, ...deployment }
  const stillOwned = (): boolean =>
    context.getManagerGeneration() === managerGeneration &&
    (context.ownershipGenerations.get(environment.id) ?? 0) === ownershipGeneration &&
    managedTunnelStillPaired(
      ownedEnvironment,
      resolveCurrent(),
      targetStore.getTarget(target.id),
      expected
    )
  const connection = await connectionManager.connect(target)
  if (!stillOwned()) {
    throw supersededTunnelError()
  }
  const transportGeneration = connection.getConnectGeneration()
  const active = context.active.get(environment.id)
  if (activeTunnelMatches(active, { connection, transportGeneration, target, deployment })) {
    return
  }
  const checks = await environmentForwardChecks(context.targeting, {
    environment,
    target,
    connection
  })
  if (active && stillOwned()) {
    await dropActiveOrcadTunnel(context.active, context.forwards, environment.id, active)
  }
  if (!stillOwned()) {
    throw supersededTunnelError()
  }
  const stillCurrent = () =>
    stillOwned() && connection.getConnectGeneration() === transportGeneration
  const forward = await forwardToVerifiedOrcad({
    targetId: target.id,
    connection,
    forwards: context.forwards,
    localPort: deployment.localPort,
    label: `Orca on ${environment.name}`,
    ...checks,
    onLocalPortRecovered: managedTunnelLocalPortRecovery(
      environment,
      portRecovery,
      stillCurrent,
      (updated, localPort) => {
        ownedEnvironment = updated
        expected.localPort = localPort
      }
    ),
    stillCurrent
  })
  if (!forward) {
    throw supersededTunnelError()
  }
  recordActiveOrcadTunnel(context.active, environment.id, forward, {
    connection,
    preferredPort: deployment.remotePort,
    sshTargetGeneration: deployment.sshTargetGeneration,
    targetId: target.id,
    transportGeneration
  })
  const recorded = context.active.get(environment.id)
  const serving = await context.checkServing(ownedEnvironment)
  if (!stillOwned() || connection.getConnectGeneration() !== transportGeneration) {
    if (recorded) {
      await dropActiveOrcadTunnel(context.active, context.forwards, environment.id, recorded)
    }
    throw supersededTunnelError()
  }
  if (serving.rebind && !rebound) {
    await ensureManagedOrcadTunnelBinding(
      context,
      ownedEnvironment,
      resolveCurrent,
      portRecovery,
      true
    )
  }
}
