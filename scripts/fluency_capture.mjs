#!/usr/bin/env node
// Stop hook: extract any new fluency notes from the just-completed turn,
// append them to ~/.claude/fluency_log.jsonl for later flushing to Anki.
//
// Hook input is JSON on stdin. The key field we need is `transcript_path`.

import fs from 'node:fs';
import path from 'node:path';
import { extractFluencyNotes, parseNote } from './fluency_lib.mjs';

const LOG = path.join(process.env.HOME, '.claude/fluency_log.jsonl');
const CURSOR_DIR = path.join(process.env.HOME, '.claude/.fluency_cursors');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 500);
  });
}

async function main() {
  let hookInput;
  try {
    const raw = await readStdin();
    hookInput = raw ? JSON.parse(raw) : {};
  } catch {
    process.exit(0);
  }

  const transcript = hookInput.transcript_path;
  if (!transcript || !fs.existsSync(transcript)) process.exit(0);

  const sessionId = hookInput.session_id || path.basename(transcript, '.jsonl');
  fs.mkdirSync(CURSOR_DIR, { recursive: true });
  const cursorFile = path.join(CURSOR_DIR, `${sessionId}.cursor`);
  const lastSeenIdx = fs.existsSync(cursorFile)
    ? parseInt(fs.readFileSync(cursorFile, 'utf8'), 10) || 0
    : 0;

  const lines = fs.readFileSync(transcript, 'utf8').split('\n');
  const newEntries = [];

  for (let i = lastSeenIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.message?.role !== 'assistant') continue;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'text') continue;
      const notes = extractFluencyNotes(block.text);
      for (const note of notes) {
        const parsed = parseNote(note);
        if (!parsed) continue;
        for (const pair of parsed.pairs) {
          newEntries.push({
            ts: new Date().toISOString(),
            sessionId,
            sourceUuid: entry.uuid || entry.message?.id,
            original: pair.original,
            corrected: pair.corrected,
            reason: parsed.reason,
            format: parsed.format,
          });
        }
      }
    }
  }

  if (newEntries.length > 0) {
    const lines = newEntries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(LOG, lines);
  }

  fs.writeFileSync(cursorFile, String(lines.length));
  process.exit(0);
}

main().catch(() => process.exit(0));
