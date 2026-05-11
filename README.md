# Anki Personal Learning Pipeline

A two-part Anki-based learning system built on top of [Claude Code](https://claude.com/claude-code):

1. **Interview-prep decks** — bulk-generated technical flashcards (JS, Vue 3, Nuxt 3, CSS, Browser, Performance & Security, SEO, Backend Fundamentals, etc.). Generated via Claude conversations and pushed via AnkiConnect.
2. **Personal English errors deck** — automatic capture of every `(Fluency note: …)` correction Claude writes during conversations, turned into sentence-pair flashcards (your wrong wording on the front, the natural rewrite + reason on the back).

Capture is silent and continuous. You decide when to flush a batch to Anki.

---

## Quick install

```bash
# Clone the repo
git clone https://github.com/chiehLiu/anki-pipeline.git ~/anki-pipeline
cd ~/anki-pipeline

# Copy scripts to ~/.claude/
./setup.sh

# Then manually merge two snippets (see "Setup" below):
#   1. The fluency rule into ~/.claude/CLAUDE.md
#   2. The Stop hook into ~/.claude/settings.json

# Restart Claude Code, install Anki + AnkiConnect, and you're done.
```

---

## Prerequisites

1. **Anki desktop** — https://apps.ankiweb.net/
2. **AnkiConnect add-on** — in Anki: *Tools → Add-ons → Get Add-ons → code `2055492159` → restart Anki*
3. **Node.js** ≥ 18 (native `fetch`)
4. **Claude Code CLI** with a `~/.claude/` directory

Verify AnkiConnect is reachable:
```bash
curl -s localhost:8765 -X POST -d '{"action":"version","version":6}'
# expected: {"result": 6, "error": null}
```

---

## Architecture

```
   ┌───────────────────────────────┐
   │  User types message in Claude │
   │  Code (any project)           │
   └────────────┬──────────────────┘
                │
                ▼
   ┌───────────────────────────────┐
   │  Claude writes response with  │
   │  (Fluency note: "~~wrong~~    │
   │  right" — reason)             │
   └────────────┬──────────────────┘
                │ Stop hook fires
                ▼
   ┌───────────────────────────────┐
   │  fluency_capture.mjs          │
   │  parses transcript, extracts  │
   │  new fluency notes            │
   └────────────┬──────────────────┘
                ▼
   ┌───────────────────────────────┐
   │  ~/.claude/fluency_log.jsonl  │
   │  pending corrections queue    │
   └────────────┬──────────────────┘
                │ user runs /flush-fluency
                ▼
   ┌───────────────────────────────┐
   │  fluency_flush.mjs            │
   │  builds notes, POSTs to       │
   │  AnkiConnect (localhost:8765) │
   └────────────┬──────────────────┘
                ▼
   ┌───────────────────────────────┐
   │  Anki desktop                 │
   │  English::Personal Errors::   │
   │    Grammar / Spelling         │
   └───────────────────────────────┘
```

---

## File layout (after install)

```
~/.claude/
├── CLAUDE.md                          # add the fluency rule (see snippet below)
├── settings.json                      # add the Stop hook (see snippet below)
├── scripts/
│   ├── fluency_lib.mjs                # parser + classifier + diff + Anki helper
│   ├── fluency_capture.mjs            # Stop hook script
│   ├── fluency_backfill.mjs           # one-time historical extraction
│   └── fluency_flush.mjs              # drain log → Anki
├── skills/
│   └── flush-fluency/
│       └── SKILL.md                   # /flush-fluency slash command
├── fluency_log.jsonl                  # auto-created: pending corrections
├── fluency_log.archive.jsonl          # auto-created: flushed corrections
└── .fluency_cursors/                  # auto-created: per-session line cursors
```

---

## Setup

### 1. Run `./setup.sh`

Copies the four scripts into `~/.claude/scripts/` and the skill into `~/.claude/skills/flush-fluency/`. Creates the cursor directory.

### 2. Append the fluency rule to `~/.claude/CLAUDE.md`

If `CLAUDE.md` doesn't exist, create it. Append this section:

```markdown
## English Fluency Coaching

The user is not a native English speaker and is actively working to improve. Help them learn by correcting their English in every conversation.

**When to correct:**
- Grammar mistakes (verb tense, subject-verb agreement, articles, prepositions, plurals, etc.)
- Awkward or unnatural phrasing
- Wrong word choice
- Spelling errors that change meaning
- Skip trivial typos (obvious finger slips) unless they cause confusion

**How to format the correction:**
- Place it inline at the **top** of your response, before answering the actual question.
- Use TWO parts: a clean human-readable fluency note, immediately followed by a hidden HTML comment carrying the machine-readable data.
- **Human part** (visible, easy to read):
  `(Fluency note: "<corrected sentence>" — <brief reason if non-obvious>)`
  Quote the natural rewrite. No inline diff markers. The reader sees only the corrected version.
- **Machine part** (hidden, on the very next line):
  `<!--fluency:{"o":"<original>","c":"<corrected>","r":"<reason>"}-->`
  - `o` = the user's original wording verbatim (a real substring of their message, with all original errors preserved).
  - `c` = the corrected version (same string as in the visible note's quote).
  - `r` = the reason (same as in the visible note's reason).
  - Use proper JSON-escaped strings (`\"` for quotes, `\\` for backslashes, `\n` for newlines).
  - The HTML comment renders invisibly in markdown viewers and Claude Code's terminal; the Anki capture script parses it directly from the transcript.
- Full example:
  ```
  (Fluency note: "These 51 notes are fine." — plural agreement.)
  <!--fluency:{"o":"this 51 notes is good","c":"These 51 notes are fine.","r":"plural agreement"}-->
  ```
- **Split per correction type.** Each distinct correction gets its own fluency note (visible block + machine comment). Don't bundle a typo and a grammar fix into one note.
  - **Spelling typos:** write a tight word-pair note. `o` is the misspelled token, `c` is the correct one. Example: `o:"verison", c:"version"`. The classifier sees single-word `o`+`c` → Spelling sub-deck → produces a compact word→word card.
  - **Grammar / phrasing fixes:** quote the full sentence. `o` is the user's original sentence, `c` is the natural rewrite. Multi-word `c` → Grammar sub-deck → produces a sentence-pair card with diff.
  - If a single user sentence has BOTH a typo and a grammar fix, write two separate notes — one Spelling, one Grammar. Don't mash them into one sentence-level note.
- For multiple separate sentences each needing correction, write multiple notes — each with its own visible block and its own machine comment.
- If the message is already fluent and natural, skip the note entirely. Don't force corrections.

**Scope:**
- Apply to chat messages the user writes to you.
- Also apply to code comments, commit messages, PR descriptions, and other prose they author.
- Do NOT correct technical jargon, domain terms, variable names, or code identifiers.

**Tone:**
- Treat it as gentle coaching, not criticism. Frame it as helping, not grading.
- Never skip answering the actual question to focus on the correction.
```

### 3. Merge the Stop hook into `~/.claude/settings.json`

Add this `hooks` block (or merge with an existing one) into the root of `settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node $HOME/.claude/scripts/fluency_capture.mjs"
          }
        ]
      }
    ]
  }
}
```

### 4. Restart Claude Code

Hooks only load on session start.

### 5. (Optional) Backfill from past transcripts

If you have an existing folder of Claude Code transcripts (`~/.claude/projects/<encoded-cwd>/*.jsonl`) and want to extract historical fluency notes:

```bash
# Edit PROJECT_DIR at the top of scripts/fluency_backfill.mjs
# to point at your transcript folder, then:
node ~/.claude/scripts/fluency_backfill.mjs --dry-run    # preview stats
node ~/.claude/scripts/fluency_backfill.mjs              # push to Anki
node ~/.claude/scripts/fluency_backfill.mjs --reset      # wipe deck first, then re-push
```

The backfill walks each assistant fluency note back through the parent UUID chain (skipping tool results, skill injections, image-only entries) to find your real user typing, then fuzzy-matches the corrected sentence against that text to recover the original wording.

---

## Usage

### Capture happens automatically

Every time Claude writes a `(Fluency note: …)` block in a reply, the Stop hook silently appends a parsed entry to `~/.claude/fluency_log.jsonl`.

### Flush to Anki

Open Anki, then in any Claude Code session, say one of:

- `/flush-fluency`
- *"flush my fluency notes"*
- *"push pending corrections to Anki"*

The flush script:
1. Reads `~/.claude/fluency_log.jsonl`.
2. Dedupes in-batch.
3. Creates the sub-decks if they don't exist.
4. POSTs new notes via AnkiConnect.
5. Archives flushed entries to `~/.claude/fluency_log.archive.jsonl`.
6. Clears the active log.

### Verify a deck count

```bash
curl -s localhost:8765 -X POST \
  -d '{"action":"findCards","version":6,"params":{"query":"deck:\"English::Personal Errors::Grammar\""}}' \
  | node -e 'process.stdin.on("data",d=>console.log("count:",JSON.parse(d).result.length))'
```

---

## Card format

**Front:** *"Spot the issue:"* + the original (wrong) wording.

**Back:**
- *Corrected:* the natural rewrite.
- *What changed:* word-level diff (red strikethrough for removed words, green bold for added).
- *Why:* one-line reason from the fluency note.

Cards are auto-classified:
- **Single-word, character-level fix** → `English::Personal Errors::Spelling`
- **Multi-word or structural fix** → `English::Personal Errors::Grammar`

---

## Fluency-note format

Each correction is **two parts**, written together:

```
(Fluency note: "<corrected sentence>" — <reason>)
<!--fluency:{"o":"<original>","c":"<corrected>","r":"<reason>"}-->
```

- The **visible block** is human-readable only — clean corrected sentence + brief reason.
- The **HTML comment** is for the parser — JSON with `o` (original), `c` (corrected), and `r` (reason). Most markdown renderers (including Claude Code's terminal) hide HTML comments, so the reader sees only the visible block.

The parser reads the JSON in the comment directly — no diff reconstruction needed. Legacy formats (inline strikethrough `~~wrong~~ right`, verbose-pair `you wrote: X → Y`, and corrected-only) are still supported in `fluency_lib.mjs` as fallbacks for old transcripts.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `fetch failed` / ECONNREFUSED on 8765 | Anki not open | Open Anki desktop |
| `cannot create note because it is a duplicate` | Anki rejects matching first-field across decks | Use `options.allowDuplicate: true` per note (already set in `buildNotes`) |
| Stop hook not firing | `settings.json` malformed or Claude not restarted | Validate JSON; restart Claude Code |
| Hook firing but no log entries | Fluency-note format mismatch | Check the strikethrough format; check parser regex in `fluency_lib.mjs` |
| Same note re-captured | Cursor file out of sync | Delete `~/.claude/.fluency_cursors/<session>.cursor` to reprocess from start |
| Wrong sub-deck (Spelling vs Grammar) | Heuristic miscategorized | Edit `classify()` in `fluency_lib.mjs` — currently uses reason keywords + word-count |
| Backfill returns garbage for "original" field | Skill injection / image attachment matched | Extend `isSyntheticUserMessage()` in `fluency_lib.mjs` to recognize the new pattern |

---

## Maintenance

- **Log grows unbounded** — flush periodically; flushed entries move to `fluency_log.archive.jsonl`.
- **Cursor files accumulate** — one per session; harmless. Clean with `rm ~/.claude/.fluency_cursors/*.cursor` if desired.
- **Anki review load** — defaults to 20 new cards/day per deck. Lower in *Deck options → New cards/day* if it feels heavy alongside other decks.

---

## How the parser works (high-level)

The library `scripts/fluency_lib.mjs` exposes:

- **`extractFluencyNotes(text)`** — paren-balanced extractor that finds every `(Fluency note …)` block in a piece of text.
- **`parseNote(note)`** — recognizes three historical formats: old (corrected-only), verbose-pair (`you wrote: X → Y`), and the current strikethrough format. Returns `{format, pairs, reason}`.
- **`applyStrikethroughDiff(text)`** — walks `~~wrong~~ right` and `~~wrong~~ {right phrase}` markers, reconstructs both `original` and `corrected`.
- **`classify(pair, reason)`** — Spelling vs Grammar.
- **`buildNotes(corrections, commonTags)`** — produces Anki note objects with sentence-pair front + diff-rendered back.
- **`renderWordDiff(original, corrected)`** — LCS-based word diff with HTML color spans.
- **`loadTranscriptIndex(filePath)`** — JSONL → `Map<uuid, entry>`.
- **`findPrecedingUserText(entry, byUuid)`** — walks parent UUIDs past tool results, skill injections, and image-only entries until it finds real user typing.
- **`findOriginalSubstring(corrected, userMessage)`** — sliding-window Jaccard match to recover the original wording when the fluency note has only the corrected version (legacy backfill case).

---

## License

MIT (or whatever you prefer — this is a personal-use system, attribution appreciated if you build on it).
