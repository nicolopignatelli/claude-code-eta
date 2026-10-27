# eta

A mod for [Claude Code](https://claude.com/claude-code) that shows **how far Claude's
long-running background processes have got, and when they will finish**. When Claude
starts something that takes minutes (an eval, a build, a batch of model calls, a crawl),
a band above the prompt shows each run's progress, phase by phase, with its pace and an
ETA as a clock time. You stop asking "how long now?".

```
── background runs ─────────────────────────────────────────────────────────────
⏳ composer eval · ETA 16:24 (~3 min)
   composing    ████████████░░░░░░  12/18 beats   ~21 s each                       16:22
   judging      ███████░░░░░░░░░░░   7/18 beats   ~6 s each                        16:24  (alongside)
   report       not started           0/5 steps   ~2.0 s each (from my estimate)   16:25
```

Under the prompt, the hint line gains a dim summary of the run that finishes last:
`⏳ composer eval 12/18 · ETA 16:24`.

## How it works

Progress means something different for every run: beats composed, files built, pages
crawled. So the mod does not guess. When Claude starts a background process, it calls the
mod's `track_progress` tool once and hands it:

- **a probe**: a short shell command, written for that run, that counts how far it has
  got from the traces it leaves (lines in an output file, entries in a log, records in a
  report) and prints one JSON object with a count per phase:
  `{"composing": 12, "judging": 7, "report": 0}`;
- **the phases, in order**: each with its unit and total, whether it runs *alongside* the
  phase before it (judging while composing) or *after* it, and optionally Claude's
  estimate of the time per unit for a phase not started yet.

From then on the mod works alone, with no model calls and no tokens:

- it runs the probe every few seconds (10 s by default) and keeps the moments each count
  changed;
- at every redraw it works out each phase's pace from those changes over the last three
  minutes (a stall counts once it outlasts one unit), each phase's end, and the run's ETA:
  a phase alongside cannot end before the one beside it, a phase after adds its time;
- when the background task ends, its notification closes the row with how it ended and
  how long it ran (`✓ done in 8 min 27 s`, `✗ failed`, `✗ killed`).

The mod's tool calls draw nothing in the transcript: the band is all you see of it. Ask
Claude for the ETA and it reads the same numbers with `progress_status`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install eta --marketplace nicolopignatelli/claude-code-eta
```

Answer `y` to add the marketplace, then press Enter to install at the user scope. The mod
is active right away, with no restart, and in every session you start after that.

From a shell instead:

```
claude plugin install eta --marketplace nicolopignatelli/claude-code-eta
```

## What it runs

The probes are shell commands Claude writes. The mod runs them on its own timer, in the
folder Claude names, with a 20-second timeout, and **without a permission prompt for each
run**: they are visible in Claude's `track_progress` call (ctrl+o shows it). A probe only
needs to read and count; a probe that fails shows a yellow "probe failed" on its row and
never stops the run.

## Limits

- A process that leaves no countable trace while it works cannot be tracked.
- The band redraws when a probe writes, so the countdown moves in steps of the probe
  interval, not every second.
- A row closes on the task's notification as the transcript draws it, a few seconds after
  the task ends.
- Built on Claude Code's mod API (function hooks), which is in early access: the API may
  change between releases.

## Development

```
git clone https://github.com/nicolopignatelli/claude-code-eta
cd claude-code-eta
claude --plugin-dir .          # a session with the mod loaded from this folder; edits reload it
claude plugin validate .       # what Claude Code reads from the manifest, hooks and marketplace
```

Once a session has loaded the mod, Claude Code writes its type declarations to
`.claude-plugin/types/`, and `tsc -p .` type-checks the mod against them.

| File | What it does |
|---|---|
| `hooks/register.tsx` | The tools, the probe timer, the pace and ETA, the band and the hint-line tail |
| `types/index.d.ts` | The state the mod keeps: tracked runs, their phases and readings |

## License

MIT, see [LICENSE](LICENSE).
