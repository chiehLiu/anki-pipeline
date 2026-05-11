#!/usr/bin/env node
// Backfill: extract every fluency note from this project's transcripts and push to Anki.
// Usage: node ~/.claude/scripts/fluency_backfill.mjs [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { extractFromTranscript, buildNotes, ankiPost } from './fluency_lib.mjs';

const PROJECT_DIR = path.join(
  process.env.HOME,
  '.claude/projects/-Users-chieh-liu-Dev-web-member',
);
const DRY = process.argv.includes('--dry-run');
const RESET = process.argv.includes('--reset');

async function main() {
  // 1. Collect all fluency corrections
  const files = fs
    .readdirSync(PROJECT_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(PROJECT_DIR, f));

  console.log(`Scanning ${files.length} transcripts...`);
  const all = [];
  for (const file of files) {
    const items = extractFromTranscript(file);
    if (items.length) {
      all.push(...items);
      console.log(`  ${path.basename(file)}: ${items.length} corrections`);
    }
  }
  console.log(`\nTotal corrections found: ${all.length}`);

  // 2. Dedupe by (original + corrected) pair
  const seen = new Set();
  const unique = all.filter((c) => {
    const key = `${c.pair.original || ''}|${c.pair.corrected}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`After dedupe: ${unique.length}`);

  // 3. Build Anki notes
  const notes = buildNotes(unique);
  const byDeck = notes.reduce((acc, n) => {
    acc[n.deckName] = (acc[n.deckName] || 0) + 1;
    return acc;
  }, {});
  console.log('\nDistribution:');
  for (const [deck, count] of Object.entries(byDeck)) {
    console.log(`  ${deck}: ${count}`);
  }

  if (DRY) {
    console.log('\n[dry run] Sample card:');
    console.log(JSON.stringify(notes[0], null, 2));
    return;
  }

  // 4. Push to Anki
  const ver = await ankiPost('version');
  if (ver.error) throw new Error('AnkiConnect version check failed: ' + ver.error);
  console.log(`\nAnkiConnect v${ver.result} responding.`);

  // Optionally wipe existing cards in the personal-error decks before re-pushing
  if (RESET) {
    for (const deckName of Object.keys(byDeck)) {
      const findRes = await ankiPost('findNotes', { query: `deck:"${deckName}"` });
      const noteIds = findRes.result || [];
      if (noteIds.length > 0) {
        await ankiPost('deleteNotes', { notes: noteIds });
        console.log(`Deleted ${noteIds.length} existing notes from ${deckName}`);
      }
    }
  }

  // Create decks
  for (const deckName of Object.keys(byDeck)) {
    const r = await ankiPost('createDeck', { deck: deckName });
    if (r.error) throw new Error(`createDeck ${deckName}: ${r.error}`);
  }

  // Push all
  const r = await ankiPost('addNotes', { notes });
  if (r.error) throw new Error('addNotes failed: ' + r.error);
  const ids = r.result;
  const ok = ids.filter((x) => x !== null).length;
  const failed = ids.length - ok;
  console.log(`\nPushed: ${ok}/${ids.length}${failed ? ` (${failed} skipped — likely duplicates)` : ''}`);

  // Stats: how many got recovered originals vs degraded
  const withOriginal = unique.filter((c) => c.pair.original).length;
  const noOriginal = unique.length - withOriginal;
  console.log(`Recovered originals: ${withOriginal}/${unique.length}${noOriginal ? ` (${noOriginal} degraded "no-original" tag)` : ''}`);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
