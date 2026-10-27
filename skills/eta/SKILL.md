---
name: eta
description: When to track a background process with the eta mod's track_progress tool, so the person sees its progress and ETA above the prompt. Use right after sending a long-running command to the background (an eval, a batch, a build, a crawl, parallel runs), when deciding whether a run is worth tracking, and when the person asks how long a run has left.
---

# Tracking background runs

`track_progress` puts a run's progress and ETA in front of the person, so they do not have
to ask. The moment to call it is right after the command goes to the background, while you
still know what the run is and what it leaves behind as it works. Each pattern below says
how to recognise a run worth tracking.

## Measurement runs

Evals, benchmarks, judged runs over a set of cases and trials. You recognise one by a fixed
set of cases, each producing a record as it finishes: a line in a capture file, a row in a
report, a verdict in a results file. Its total is known before it starts.

## Batches over many items

Model calls over a dataset, backfills over rows, renders, downloads, crawls, exploration
missions. You recognise one by an item count you know or can find out, and one output per
item: a file written, a record stored, a line logged.

## Long builds and test suites

Builds over many packages and test suites that report item by item. You recognise one by
output that names each test or package as it passes or fails.

## Parallel runs started together

Several background commands started at once, such as the cases of an eval run in parallel.
Track each one: one `track_progress` call per run, each with its own task id, so each gets
its own row and its own ending.

## Runs with stages

A run that does one kind of work and then another (compose then judge, the deciding cases
then the rest, download then process) has phases. Declare them in order, mark the ones that
run alongside the phase before them, and when an earlier run of the same kind gave you a
pace for a phase that has not started yet, pass it as that phase's estimate.

## When not to track

- **Processes that never end on their own**: dev servers, file watchers, tunnels.
- **Runs that finish within about a minute**: the ETA would arrive after the run.
- **Runs that leave nothing to count while they work**: no output file growing, no log
  lines per item, no records. Say there is no ETA to give rather than invent a probe that
  counts something else.

## When the person asks how long is left

Read `progress_status` and answer in one line: the ETA, and what is left of the phase that
decides it.
