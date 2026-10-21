import type { ParticipantInfo } from '../../api/endpoints/hub'
import { STAND_IN_COPY } from '../../utils/agentAccessCopy'
import HubContactLabel from './HubContactLabel'

/**
 * A retained agent of another server in a workroom (a `hub_stand_in`
 * participant): name from server · fp, then a "remote" badge. Greyed with the
 * reason once its bridge is inactive (unretained, unlisted, identity changed;
 * any other reason reads "can no longer take part"). Plain text only.
 */
export default function StandInChip({ info }: { info: ParticipantInfo }) {
  const hub = info.hub ?? null
  const inactive = hub?.bridge_state === 'inactive'
  return (
    <span
      className={`inline-flex flex-wrap items-baseline gap-1 text-sm min-w-0 ${inactive ? 'opacity-60' : ''}`}
      aria-disabled={inactive || undefined}
      data-testid="stand-in-chip"
      data-inactive={inactive || undefined}
    >
      <HubContactLabel
        fields={{
          remote_username: hub?.name ?? null,
          deployment_name: hub?.deployment_name ?? null,
          deployment_fingerprint: hub?.deployment_fingerprint ?? null,
        }}
        fallbackName={info.id}
      />
      <span
        className="px-1.5 rounded bg-sky-50 text-sky-700 text-[10px] font-semibold uppercase tracking-wide"
        title={STAND_IN_COPY.remoteTitle}
        data-testid="stand-in-remote"
      >
        {STAND_IN_COPY.remote}
      </span>
      {inactive && (
        <span className="text-xs text-gray-500" data-testid="stand-in-inactive">
          {STAND_IN_COPY.inactive(hub?.inactive_reason)}
        </span>
      )}
    </span>
  )
}
