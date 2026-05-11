#!/usr/bin/env node
// Flush ~/.claude/fluency_log.jsonl to Anki, dedupe against existing notes,
// then archive flushed entries.

import fs from 'node:fs';
import path from 'node:path';
import { buildNotes, ankiPost } from './fluency_lib.mjs';

const LOG = path.join(process.env.HOME, '.claude/fluency_log.jsonl');
const ARCHIVE = path.join(process.env.HOME, '.claude/fluency_log.archive.jsonl');

async function main() {
  if (!fs.existsSync(LOG) || fs.readFileSync(LOG, 'utf8').trim() === '') {
    console.log('No pending fluency notes. Nothing to flush.');
    return;
  }

  const entries = fs
    .readFileSync(LOG, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  console.log(`Found ${entries.length} pending corrections in log.`);

  // Convert log entries into the same shape buildNotes expects
  const corrections = entries.map((e) => ({
    pair: { original: e.original, corrected: e.corrected },
    reason: e.reason,
    sourceUuid: e.sourceUuid,
  }));

  // In-batch dedupe
  const seen = new Set();
  const unique = corrections.filter((c) => {
    const k = `${c.pair.original || ''}|${c.pair.corrected}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`After in-batch dedupe: ${unique.length}`);

  // Verify Anki is up
  const ver = await ankiPost('version');
  if (ver.error) throw new Error('AnkiConnect version check failed: ' + ver.error);

  // Ensure decks exist
  const notes = buildNotes(unique);
  const decks = new Set(notes.map((n) => n.deckName));
  for (const deck of decks) {
    await ankiPost('createDeck', { deck });
  }

  // Push
  const r = await ankiPost('addNotes', { notes });
  if (r.error) throw new Error('addNotes failed: ' + r.error);
  const ids = r.result;
  const ok = ids.filter((x) => x !== null).length;
  const skipped = ids.length - ok;
  console.log(`Pushed: ${ok}/${ids.length}${skipped ? ` (${skipped} skipped — likely duplicates)` : ''}`);

  // Archive flushed entries
  fs.appendFileSync(ARCHIVE, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(LOG, '');
  console.log(`Archived to ${ARCHIVE}; active log cleared.`);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
