---
name: flush-fluency
description: Push pending fluency-coaching corrections from the local log file to the Anki personal-error decks via AnkiConnect. Use when the user types /flush-fluency, says "flush my fluency notes", or asks to push their accumulated English mistakes into Anki cards.
---

# flush-fluency

Pushes pending entries from `~/.claude/fluency_log.jsonl` to the Anki decks `English::Personal Errors::Grammar` and `English::Personal Errors::Spelling`, then archives the flushed entries.

## What to do

1. Confirm Anki is running (AnkiConnect listens on `localhost:8765`):
   ```bash
   curl -s localhost:8765 -X POST -d '{"action":"version","version":6}'
   ```
   If the connection fails, ask the user to open Anki desktop, then retry.

2. Run the flush script:
   ```bash
   node ~/.claude/scripts/fluency_flush.mjs
   ```

3. Report the result back to the user — number pushed, number skipped as duplicates, archive location.

4. If the user wants to verify, query Anki for the deck counts:
   ```bash
   curl -s localhost:8765 -X POST -d '{"action":"findCards","version":6,"params":{"query":"deck:\"English::Personal Errors::Grammar\""}}' | node -e 'process.stdin.on("data",d=>console.log("Grammar:",JSON.parse(d).result.length))'
   curl -s localhost:8765 -X POST -d '{"action":"findCards","version":6,"params":{"query":"deck:\"English::Personal Errors::Spelling\""}}' | node -e 'process.stdin.on("data",d=>console.log("Spelling:",JSON.parse(d).result.length))'
   ```

## How the pipeline works (for context)

- A Stop hook (`~/.claude/scripts/fluency_capture.mjs`) runs after every assistant turn, extracts any `(Fluency note — ...)` blocks from the response, and appends parsed corrections to `~/.claude/fluency_log.jsonl`.
- This skill drains that log into Anki and archives the entries to `~/.claude/fluency_log.archive.jsonl`.
- The shared library is at `~/.claude/scripts/fluency_lib.mjs` (parsing, classification, Anki note builder).
- Cards are classified as Spelling (single-word, character-level fix) or Grammar (multi-word or structural fix) and routed to the matching sub-deck.

## Notes

- Don't run the flush script on an empty log — it just no-ops, but a one-line confirmation is enough.
- Don't manually edit `fluency_log.jsonl` unless asked; the cursor file `~/.claude/.fluency_cursors/<session>.cursor` tracks which lines have already been processed by the hook, so edits can desync them.
