import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Phase, Run } from '../types'

const PLUGIN = 'eta'
const TICK_MS = 5_000
const DEFAULT_INTERVAL_S = 10
const PROBE_TIMEOUT_MS = 20_000
// The rate is measured over this much recent time, so a slow start or a change
// of pace stops weighing on the estimate once it is behind.
const RATE_WINDOW_MS = 180_000
const MAX_SAMPLES = 200
// How long an ended run stays on screen.
const ENDED_SHOWN_MS = 60_000
const BAR_CELLS = 18

// Change the tag when Run's fields change: it declines what an earlier
// version stored, which outlives a reload.
const runs = atom({ plugin: 'eta', key: 'runs' } as const, [], { shape: 'runs-1' })
const tzOffsetMinutes = atom({ plugin: 'eta', key: 'tzOffsetMinutes' } as const, 0)
const TITLE = 'background runs'
// The one accent: the ETA and the progress of what is running. Named colours
// follow the terminal's theme.
const ACCENT = 'cyan'

const TOOL_TRACK = 'track_progress'
const TOOL_STATUS = 'progress_status'
const TOOL_STOP = 'stop_tracking'
// The widget is the only thing the person sees of this mod: its tool calls
// draw no row in the transcript, their results reach Claude alone. The full
// view (ctrl+o, --verbose) still draws them, so every probe can be inspected.
const OWN_TOOLS: ReadonlySet<string> = new Set(
  [TOOL_TRACK, TOOL_STATUS, TOOL_STOP].map(name => `mcp__${PLUGIN}__${name}`),
)

type PhaseInput = {
  name?: unknown
  unit?: unknown
  total?: unknown
  alongside?: unknown
  seconds_per_unit?: unknown
}

type Reading = { done: number; total: number | null }

type Projection = {
  phase: Phase
  secondsPerUnit: number | null
  isMeasured: boolean
  endAt: number | null
  isComplete: boolean
}

// Task ids whose end notification was drawn: a drawing may not write state,
// so the tick records the ending.
const pendingEndings = new Map<string, { status: string; durationMs: number | null }>()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    const { stdout } = await $.process.run(['date', '+%z'])
    await update($, tzOffsetMinutes, () => parseOffset(stdout.trim()))

    await $.tool.register({
      name: TOOL_TRACK,
      description:
        'Track the progress of a long-running background process and show it with an ETA above the prompt and under it. ' +
        'Call right after starting the process. `probe` is a shell command, run every `interval_seconds`, that prints ' +
        'one JSON object mapping each phase name to its count so far, a number or {"done": n, "total": m} when the ' +
        'total is only known while running. Declare the phases in order; `alongside: true` for a phase that runs during ' +
        'the one before it (judging while composing), false for one that starts after it. `seconds_per_unit` is your ' +
        'estimate for a phase not measured yet. With `task_id` (the background task id) the row closes itself when the ' +
        'task ends. Calling again with the same task_id (or label) replaces the run.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short name of the run, as the person would call it.' },
          task_id: { type: 'string', description: 'The background task id from the Bash result.' },
          probe: { type: 'string', description: 'Shell command printing the JSON counts per phase.' },
          cwd: { type: 'string', description: 'Directory the probe runs in.' },
          interval_seconds: { type: 'number', description: `Seconds between probes, default ${DEFAULT_INTERVAL_S}.` },
          phases: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                unit: { type: 'string', description: 'Plural unit: beats, reads, steps.' },
                total: { type: 'number' },
                alongside: { type: 'boolean' },
                seconds_per_unit: { type: 'number' },
              },
              required: ['name', 'unit'],
            },
          },
        },
        required: ['label', 'probe', 'phases'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: TOOL_STATUS,
      description: 'The progress and ETA of every tracked background run, as the person sees them.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: TOOL_STOP,
      description: 'Stop tracking a run, by its task_id or label.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The task_id or the label.' } },
        required: ['id'],
      },
      isDeferred: false,
    })

    $.clock.every(TICK_MS, () => {
      void tick($)
    })

    return started
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__${TOOL_TRACK}` }, async ($, e) => {
    const built = buildRun(e, await $.clock.now())
    if (typeof built === 'string') {
      return { deny: `${PLUGIN}: ${built}` }
    }
    // A new run clears the ended ones: their result was told, and it is the new run that is watched.
    await update($, runs, list => [...list.filter(run => run.id !== built.id && run.ended === null), built])
    const probed = await probeRun($, built)

    return {
      result: probed.probeError
        ? `Tracking "${built.label}", but the first probe failed: ${probed.probeError}`
        : `Tracking "${built.label}": ${describeCounts(probed)}. Next probe in ${built.intervalMs / 1000} s.`,
    }
  }).catch(() => ({ deny: `${PLUGIN}: tracking failed` }))

  on('tool.call', { tool: `mcp__${PLUGIN}__${TOOL_STATUS}` }, async $ => {
    const now = await $.clock.now()
    const tz = await read($, tzOffsetMinutes)
    const list = await read($, runs)

    return { result: list.length === 0 ? 'No tracked runs.' : list.map(run => statusText(run, now, tz)).join('\n\n') }
  }).catch(() => ({ deny: `${PLUGIN}: the status failed` }))

  on('tool.call', { tool: `mcp__${PLUGIN}__${TOOL_STOP}` }, async ($, e) => {
    const id = typeof e.id === 'string' ? e.id : ''
    const list = await read($, runs)
    const found = list.find(run => run.id === id || run.taskId === id || run.label === id)
    if (!found) {
      return { result: `No tracked run is called "${id}".` }
    }
    await update($, runs, all => all.filter(run => run.id !== found.id))

    return { result: `Stopped tracking "${found.label}".` }
  }).catch(() => ({ deny: `${PLUGIN}: stopping failed` }))

  // The moment to track a run is when it goes to the background: Claude reads
  // a reminder after the result, with the task id it needs; the person sees
  // nothing of it. Untracked runs only, and never a foreground command.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) {
      return ran
    }
    const taskId = ran.result.backgroundTaskId
    if (taskId === undefined) {
      return ran
    }
    const isTracked = (await read($, runs)).some(run => run.taskId === taskId && run.ended === null)
    if (isTracked) {
      return ran
    }

    return { ...ran, context: [...(ran.context ?? []), trackingReminder(taskId)] }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${PLUGIN}: its Bash hook failed.` }))

  on('ui.render', { component: 'ToolUse' }, ($, e, next) =>
    OWN_TOOLS.has(e.props.tool) && e.props.isExpanded !== true ? <></> : next(e),
  )
  on('ui.render', { component: 'ToolResult' }, ($, e, next) =>
    OWN_TOOLS.has(e.props.tool) && e.props.isExpanded !== true ? <></> : next(e),
  )

  // A background task's end reaches the transcript as a notification row whose
  // props name the task: its id, how it ended, how long it ran.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    const task = e.props.task
    if (task?.id !== undefined) {
      pendingEndings.set(task.id, { status: task.status ?? 'ended', durationMs: task.durationMs ?? null })
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, runs)
    if (e.props.hasSurvey || list.length === 0) {
      return next(e)
    }
    const now = await $.clock.now()
    const tz = await read($, tzOffsetMinutes)
    const { Box, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const rows = list.map(run => (
      <Box key={run.id} flexDirection="column">
        {runHeader(Text, Box, run, now, tz)}
        {run.ended === null &&
          project(run, now).map(projection => phaseRow(Text, projection, tz))}
      </Box>
    ))

    // A labelled rule and a blank line above it set the band apart from the conversation.
    const lead = `── ${TITLE} `
    return (
      <Box flexDirection="column" width={width} marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {lead + '─'.repeat(Math.max(0, width - lead.length))}
        </Text>
        {rows}
      </Box>
    )
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const list = (await read($, runs)).filter(run => run.ended === null)
    if (list.length === 0) {
      return next(e)
    }
    const now = await $.clock.now()
    const tz = await read($, tzOffsetMinutes)
    const ranked = list
      .map(run => ({ run, endAt: runEndAt(project(run, now)) }))
      // An unknown ETA ranks as the latest: that run is the one to wait on.
      .sort((a, b) => (b.endAt ?? Number.MAX_SAFE_INTEGER) - (a.endAt ?? Number.MAX_SAFE_INTEGER))
    const latest = ranked[0]
    const projections = latest === undefined ? [] : project(latest.run, now)
    const lead = projections.find(projection => !projection.isComplete) ?? projections[0]
    if (latest === undefined || lead === undefined) {
      return next(e)
    }
    const { run, endAt } = latest
    const count = lead.phase.total === null ? `${lead.phase.done}` : `${lead.phase.done}/${lead.phase.total}`
    const eta = endAt === null ? 'estimating…' : `ETA ${clock(endAt, tz)}`
    const more = list.length > 1 ? ` (+${list.length - 1})` : ''

    return next({ ...e, props: { ...e.props, tail: `⏳ ${run.label} ${count} · ${eta}${more}` } })
  })
}

function trackingReminder(taskId: string): string {
  return (
    `Background task ${taskId} started. If it will run for more than about a minute and leaves ` +
    `progress it can be counted by (lines in an output file, entries in a log, records in a report), ` +
    `track it now with mcp__${PLUGIN}__${TOOL_TRACK}, task_id "${taskId}". ` +
    `If it never ends on its own (a server, a watcher) or leaves nothing to count, don't.`
  )
}

function runHeader(Text: any, Box: any, run: Run, now: number, tz: number) {
  if (run.ended !== null) {
    const took = run.ended.durationMs ?? run.ended.at - run.startedAt
    const isOk = run.ended.status === 'completed'
    return (
      <Text color={isOk ? 'green' : 'red'} wrap="truncate-end">
        {isOk ? '✓' : '✗'} {run.label} · {isOk ? 'done' : run.ended.status} in {duration(took)}
      </Text>
    )
  }
  const endAt = runEndAt(project(run, now))
  const right =
    endAt === null ? (
      <Text dimColor>estimating…</Text>
    ) : (
      <Text color={ACCENT}>
        ETA {clock(endAt, tz)} (~{duration(Math.max(0, endAt - now))})
      </Text>
    )

  // The ETA follows the label on the same line: laid at the far edge it fell off the row.
  return (
    <Text wrap="truncate-end">
      <Text bold>⏳ {run.label}</Text>
      <Text dimColor> · </Text>
      {right}
      {run.probeError ? <Text color="yellow"> · probe failed: {run.probeError.slice(0, 60)}</Text> : null}
    </Text>
  )
}

async function tick($: any): Promise<void> {
  const now = await $.clock.now()
  const list: Run[] = await read($, runs)
  if (list.length === 0) {
    pendingEndings.clear()
    return
  }

  for (const run of list) {
    const ending = run.taskId === null ? undefined : pendingEndings.get(run.taskId)
    if (run.ended === null && ending !== undefined) {
      await update($, runs, all =>
        all.map(one => (one.id === run.id ? { ...one, ended: { ...ending, at: now } } : one)),
      )
    }
  }
  await update($, runs, all => all.filter(run => run.ended === null || now - run.ended.at < ENDED_SHOWN_MS))

  const due = (await read($, runs)).filter(run => run.ended === null && now - run.lastProbeAt >= run.intervalMs)
  await Promise.all(due.map(run => probeRun($, run)))
}

async function probeRun($: any, run: Run): Promise<Run> {
  const now = await $.clock.now()
  let readings: Record<string, Reading> | null = null
  let probeError: string | null = null
  try {
    const { exitCode, stdout, stderr } = await $.process.run(['/bin/sh', '-c', run.probe], {
      cwd: run.cwd ?? undefined,
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    if (exitCode !== 0) {
      probeError = `exit ${exitCode}${stderr.trim() ? `: ${stderr.trim().slice(0, 120)}` : ''}`
    } else {
      readings = parseReadings(stdout)
      if (readings === null) {
        probeError = 'did not print a JSON object of counts'
      }
    }
  } catch (error) {
    probeError = error instanceof Error ? error.message : String(error)
  }

  let result = run
  await update($, runs, all =>
    all.map(one => {
      if (one.id !== run.id) {
        return one
      }
      const phases = one.phases.map(phase => {
        const reading = readings?.[phase.name]
        if (reading === undefined) {
          return phase
        }
        const total = reading.total ?? phase.total
        if (reading.done === phase.done && total === phase.total) {
          return phase
        }
        const samples = [...phase.samples, { at: now, done: reading.done }].slice(-MAX_SAMPLES)
        return { ...phase, done: reading.done, total, samples }
      })
      const isAllComplete = phases.every(phase => phase.total !== null && phase.done >= phase.total)
      const ended =
        isAllComplete && one.taskId === null ? { status: 'completed', at: now, durationMs: null } : one.ended
      result = { ...one, phases, lastProbeAt: now, probeError, ended }
      return result
    }),
  )

  return result
}

function buildRun(e: Record<string, unknown>, now: number): Run | string {
  const label = typeof e.label === 'string' ? e.label.trim() : ''
  const probe = typeof e.probe === 'string' ? e.probe.trim() : ''
  const phasesIn = Array.isArray(e.phases) ? (e.phases as PhaseInput[]) : []
  if (!label) return 'label is required'
  if (!probe) return 'probe is required'
  if (phasesIn.length === 0) return 'at least one phase is required'

  const phases: Phase[] = []
  for (const [index, input] of phasesIn.entries()) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const unit = typeof input.unit === 'string' ? input.unit.trim() : ''
    if (!name || !unit) return `phase ${index + 1} needs a name and a unit`
    if (phases.some(phase => phase.name === name)) return `two phases are called "${name}"`
    phases.push({
      name,
      unit,
      total: positiveNumber(input.total),
      alongside: index > 0 && input.alongside === true,
      secondsPerUnit: positiveNumber(input.seconds_per_unit),
      done: 0,
      // No reading at the call: the run started before it, so a zero stamped
      // now would make its first stretch look faster than it was.
      samples: [],
    })
  }

  const taskId = typeof e.task_id === 'string' && e.task_id.trim() ? e.task_id.trim() : null
  const interval = positiveNumber(e.interval_seconds) ?? DEFAULT_INTERVAL_S

  return {
    id: taskId ?? label,
    taskId,
    label,
    probe,
    cwd: typeof e.cwd === 'string' && e.cwd.trim() ? e.cwd.trim() : null,
    intervalMs: Math.max(2, interval) * 1000,
    startedAt: now,
    lastProbeAt: 0,
    probeError: null,
    phases,
    ended: null,
  }
}

function parseReadings(stdout: string): Record<string, Reading> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const readings: Record<string, Reading> = {}
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      readings[name] = { done: value, total: null }
    } else if (value !== null && typeof value === 'object' && typeof (value as { done?: unknown }).done === 'number') {
      const { done, total } = value as { done: number; total?: unknown }
      readings[name] = { done, total: positiveNumber(total) }
    }
  }
  return readings
}

/**
 * Each phase's time per unit and when it ends. A phase that runs alongside
 * the one before cannot end before it; one that runs after starts when it ends.
 */
function project(run: Run, now: number): Projection[] {
  // Projected from the last reading: what the counts say is as of then.
  const at = run.lastProbeAt > 0 ? run.lastProbeAt : now
  const projections: Projection[] = []
  let previousEnd: number | null = at

  for (const [index, phase] of run.phases.entries()) {
    const measured = measuredSecondsPerUnit(phase, at)
    const secondsPerUnit = measured ?? phase.secondsPerUnit
    const isComplete = phase.total !== null && phase.done >= phase.total
    let endAt: number | null

    if (isComplete) {
      endAt = phase.samples[phase.samples.length - 1]?.at ?? at
    } else if (phase.total === null || secondsPerUnit === null) {
      endAt = null
    } else {
      const remainingMs = (phase.total - phase.done) * secondsPerUnit * 1000
      if (index === 0) {
        endAt = at + remainingMs
      } else if (phase.alongside) {
        endAt = previousEnd === null ? null : Math.max(at + remainingMs, previousEnd)
      } else {
        const start: number | null = phase.done > 0 ? at : previousEnd
        endAt = start === null ? null : start + remainingMs
      }
    }

    projections.push({ phase, secondsPerUnit, isMeasured: measured !== null, endAt, isComplete })
    previousEnd = endAt
  }

  return projections
}

function measuredSecondsPerUnit(phase: Phase, observedAt: number): number | null {
  const samples = phase.samples
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (first === undefined || last === undefined || samples.length < 2) {
    return null
  }
  // The last change at or before the window's start gives a full window; with
  // none, the first reading.
  const windowStart = last.at - RATE_WINDOW_MS
  let base = first
  for (const sample of samples) {
    if (sample.at <= windowStart) {
      base = sample
    }
  }
  const progressed = last.done - base.done
  if (progressed <= 0) {
    return null
  }
  // Measured between changes, so the wait since the last one is not taken for
  // slow work; once that wait outlasts a unit, the run has slowed and counts it.
  const betweenChanges = (last.at - base.at) / 1000 / progressed
  const sinceLastChange = (observedAt - last.at) / 1000
  return sinceLastChange > betweenChanges ? (observedAt - base.at) / 1000 / progressed : betweenChanges
}

function runEndAt(projections: Projection[]): number | null {
  let latest = 0
  for (const projection of projections) {
    if (projection.endAt === null) {
      return null
    }
    latest = Math.max(latest, projection.endAt)
  }
  return latest
}

function phaseLine(projection: Projection, now: number, tz: number): string {
  const { phase, secondsPerUnit, isMeasured, endAt, isComplete } = projection
  const name = phase.name.padEnd(12)
  const bar = phase.total === null ? ''.padEnd(BAR_CELLS) : progressBar(phase.done, phase.total)
  const count = (phase.total === null ? `${phase.done} ${phase.unit}` : `${phase.done}/${phase.total} ${phase.unit}`).padEnd(18)
  let pace = ''
  if (secondsPerUnit !== null) {
    pace = `~${perUnit(secondsPerUnit)} each${isMeasured ? '' : ' (from my estimate)'}`
  }
  const notStarted = phase.done === 0 && phase.samples.length === 0
  const when = isComplete ? 'done' : endAt === null ? '' : clock(endAt, tz)
  const tag = phase.alongside ? '  (alongside)' : ''
  const head = notStarted && !isComplete ? `${name} ${'not started'.padEnd(BAR_CELLS)}` : `${name} ${bar}`

  return `   ${head}  ${count} ${pace.padEnd(32)} ${when}${tag}`.trimEnd()
}

/** One phase as the band draws it: the bar and the ETA in the accent, the rest quiet. */
function phaseRow(Text: any, projection: Projection, tz: number) {
  const { phase, secondsPerUnit, isMeasured, endAt, isComplete } = projection
  const name = phase.name.padEnd(12)
  const notStarted = phase.done === 0 && phase.samples.length === 0 && !isComplete
  const count = (phase.total === null ? `${phase.done} ${phase.unit}` : `${phase.done}/${phase.total} ${phase.unit}`).padEnd(18)
  const pace =
    secondsPerUnit === null ? '' : `~${perUnit(secondsPerUnit)} each${isMeasured ? '' : ' (from my estimate)'}`
  const when = isComplete ? 'done' : endAt === null ? '' : clock(endAt, tz)
  const tag = phase.alongside ? '  (alongside)' : ''

  let bar
  if (notStarted) {
    bar = <Text dimColor>{'not started'.padEnd(BAR_CELLS)}</Text>
  } else if (phase.total === null) {
    bar = <Text>{''.padEnd(BAR_CELLS)}</Text>
  } else {
    const filled = Math.round(Math.min(1, phase.total <= 0 ? 0 : phase.done / phase.total) * BAR_CELLS)
    bar = (
      <Text>
        <Text color={isComplete ? 'green' : ACCENT}>{'█'.repeat(filled)}</Text>
        <Text dimColor>{'░'.repeat(BAR_CELLS - filled)}</Text>
      </Text>
    )
  }

  return (
    <Text key={phase.name} wrap="truncate-end">
      <Text dimColor={isComplete}>{`   ${name} `}</Text>
      {bar}
      <Text dimColor={isComplete}>{`  ${count} `}</Text>
      <Text dimColor>{pace.padEnd(32)} </Text>
      <Text color={isComplete || endAt === null ? undefined : ACCENT} dimColor={isComplete}>
        {when}
      </Text>
      <Text dimColor>{tag}</Text>
    </Text>
  )
}

function statusText(run: Run, now: number, tz: number): string {
  if (run.ended !== null) {
    const took = run.ended.durationMs ?? run.ended.at - run.startedAt
    return `${run.label}: ${run.ended.status} after ${duration(took)}`
  }
  const projections = project(run, now)
  const endAt = runEndAt(projections)
  const header = `${run.label}: ${endAt === null ? 'estimating' : `ETA ${clock(endAt, tz)} (~${duration(Math.max(0, endAt - now))})`}` +
    (run.probeError ? ` [probe failed: ${run.probeError}]` : '')

  return [header, ...projections.map(projection => phaseLine(projection, now, tz).trim())].join('\n')
}

function describeCounts(run: Run): string {
  return run.phases
    .map(phase => `${phase.name} ${phase.total === null ? phase.done : `${phase.done}/${phase.total}`} ${phase.unit}`)
    .join(', ')
}

function progressBar(done: number, total: number): string {
  const share = total <= 0 ? 0 : Math.min(1, done / total)
  const filled = Math.round(share * BAR_CELLS)
  return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 || minutes >= 10 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

function perUnit(seconds: number): string {
  if (seconds < 10) return `${seconds.toFixed(1)} s`
  if (seconds < 90) return `${Math.round(seconds)} s`
  return `${(seconds / 60).toFixed(1)} min`
}

function clock(epochMs: number, tzOffset: number): string {
  const local = new Date(epochMs + tzOffset * 60_000)
  const hours = String(local.getUTCHours()).padStart(2, '0')
  const minutes = String(local.getUTCMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

function parseOffset(text: string): number {
  // `date +%z` prints ±HHMM.
  if (text.length !== 5 || (text[0] !== '+' && text[0] !== '-')) return 0
  const hours = Number(text.slice(1, 3))
  const minutes = Number(text.slice(3, 5))
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0
  return (text[0] === '-' ? -1 : 1) * (hours * 60 + minutes)
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}
