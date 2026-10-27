/** A phase's count at the moment it changed. */
export type Sample = { at: number; done: number }

export type Phase = {
  name: string
  unit: string
  total: number | null
  /** Runs alongside the phase before it (judging during composing), not after it. */
  alongside: boolean
  /** Claude's estimate of the time per unit, used until the phase is measured. */
  secondsPerUnit: number | null
  done: number
  samples: Sample[]
}

export type Ending = { status: string; at: number; durationMs: number | null }

export type Run = {
  /** The background task id when there is one, else the label. */
  id: string
  taskId: string | null
  label: string
  probe: string
  cwd: string | null
  intervalMs: number
  startedAt: number
  lastProbeAt: number
  probeError: string | null
  phases: Phase[]
  ended: Ending | null
}

declare module 'claude-code' {
  interface PluginState {
    eta: { runs: Shaped<Run[]>; tzOffsetMinutes: number }
  }
}
