// Shared utilities for fluency note extraction, classification, and Anki push.

import fs from 'node:fs';

const ANKI = 'http://localhost:8765';

export async function ankiPost(action, params = {}) {
  const res = await fetch(ANKI, {
    method: 'POST',
    body: JSON.stringify({ action, version: 6, params }),
  });
  return res.json();
}

// Heuristic: reject placeholder/template content (e.g., format examples in
// docs that look like real fluency notes). Examples to skip:
//   o:"<original>", c:"<corrected>"  — angle-bracket placeholders
//   o:"X", c:"Y"                     — single-letter generic placeholders
//   o:"foo", c:"bar"                 — classic placeholder words
export function isPlaceholderPair(o, c) {
  if (typeof o !== 'string' || typeof c !== 'string') return true;
  const oo = o.trim(), cc = c.trim();
  if (!oo || !cc) return true;
  // Angle-bracketed placeholders like <original>, <corrected>, <something>
  if (/<\w[\w-]*>/.test(oo) || /<\w[\w-]*>/.test(cc)) return true;
  // Single-letter placeholders (X, Y, A, B…)
  if (/^[A-Z]$/.test(oo) && /^[A-Z]$/.test(cc)) return true;
  // Classic generic placeholder words used in docs
  const placeholders = new Set(['foo', 'bar', 'baz', 'placeholder', 'example', 'template', 'something']);
  if (placeholders.has(oo.toLowerCase()) && placeholders.has(cc.toLowerCase())) return true;
  return false;
}

// Extract every `<!--fluency:{...}-->` machine-data block from a piece of text.
// Returns an array of {original, corrected, reason}.
// This is the CURRENT (post-2026-05-11 PM) primary format; the human-visible
// `(Fluency note: ...)` block is for reading only.
// Placeholder/template entries are filtered out — see isPlaceholderPair().
export function extractFluencyDataBlocks(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const re = /<!--\s*fluency:\s*(\{[\s\S]*?\})\s*-->/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      if (typeof data.o === 'string' && typeof data.c === 'string') {
        if (isPlaceholderPair(data.o, data.c)) continue;
        out.push({
          original: data.o,
          corrected: data.c,
          reason: typeof data.r === 'string' ? data.r : '',
        });
      }
    } catch {
      // malformed JSON in fluency block — skip
    }
  }
  return out;
}

// Extract every `(Fluency note ...)` block from a piece of text using paren balancing.
export function extractFluencyNotes(text) {
  if (!text || typeof text !== 'string') return [];
  const notes = [];
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf('(Fluency note', i);
    if (idx === -1) break;
    let depth = 0;
    let j = idx;
    while (j < text.length) {
      const ch = text[j];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
    if (depth === 0) {
      notes.push(text.slice(idx, j));
      i = j;
    } else {
      i = idx + 1;
    }
  }
  return notes;
}

// Parse a single note's body into structured corrections.
// Handles three formats:
//   Strikethrough (current, post-2026-05-11 PM): (Fluency note: "<text with ~~X~~ Y diffs>" — reason)
//   Verbose pair (brief intermediate):           (Fluency note — you wrote: "X" → "Y" — reason)
//   Old (pre-2026-05-11):                        (Fluency note: "<corrected>" — <reason>)
export function parseNote(note) {
  const inner = note.replace(/^\(Fluency note\b\s*[—:-]?\s*/, '').replace(/\)\s*$/, '');

  // Verbose pair format: explicit "wrote:" markers
  const pairRe = /(?:you\s+)?wrote:\s*[""]([^""]+)[""][\s—–-]*(?:→|->|to)?\s*[""]([^""]+)[""]/gi;
  const pairs = [];
  let m;
  while ((m = pairRe.exec(inner))) {
    pairs.push({ original: m[1].trim(), corrected: m[2].trim() });
  }
  if (pairs.length > 0) {
    const trailing = inner.slice(pairRe.lastIndex).replace(/^[\s—–-]+/, '').trim();
    const reason = trailing.replace(/[—–-]+$/, '').trim();
    return { format: 'verbose-pair', pairs, reason };
  }

  // Strikethrough format: quoted sentence containing ~~X~~ Y patterns
  const quotedRe = /^[""]([\s\S]+?)[""][\s—–-]*([\s\S]*)$/;
  const qm = inner.match(quotedRe);
  if (qm && qm[1].includes('~~')) {
    const diffed = qm[1];
    const reason = qm[2].trim().replace(/[—–-]+$/, '').trim();
    const { original, corrected } = applyStrikethroughDiff(diffed);
    if (original !== corrected) {
      return {
        format: 'strikethrough',
        pairs: [{ original, corrected }],
        reason,
      };
    }
  }

  // Old format: corrected sentence + reason, no original
  if (qm) {
    return {
      format: 'old',
      pairs: [{ original: null, corrected: qm[1].trim() }],
      reason: qm[2].trim().replace(/[—–-]+$/, '').trim(),
    };
  }

  return null;
}

// Walk through a sentence containing ~~wrong~~ right markers and produce
// both the original and corrected versions.
// Conventions:
//   ~~X~~ right            → single-token correction (right runs until next whitespace boundary)
//   ~~X~~ {right phrase}   → multi-token correction (braces delimit the corrected span)
export function applyStrikethroughDiff(text) {
  let original = '';
  let corrected = '';
  let i = 0;
  while (i < text.length) {
    const openIdx = text.indexOf('~~', i);
    if (openIdx === -1) {
      original += text.slice(i);
      corrected += text.slice(i);
      break;
    }
    // Shared text before the strikethrough
    original += text.slice(i, openIdx);
    corrected += text.slice(i, openIdx);

    const closeIdx = text.indexOf('~~', openIdx + 2);
    if (closeIdx === -1) {
      // Malformed: no closing ~~. Treat rest as plain.
      original += text.slice(openIdx);
      corrected += text.slice(openIdx);
      break;
    }
    const wrong = text.slice(openIdx + 2, closeIdx);
    let cursor = closeIdx + 2;

    // Skip exactly one space after closing ~~
    if (text[cursor] === ' ') cursor++;

    let right;
    if (text[cursor] === '{') {
      // Brace-delimited multi-word right side
      const closeBrace = text.indexOf('}', cursor + 1);
      if (closeBrace === -1) {
        right = text.slice(cursor + 1);
        cursor = text.length;
      } else {
        right = text.slice(cursor + 1, closeBrace);
        cursor = closeBrace + 1;
      }
    } else {
      // Single token: read until whitespace or punctuation that ends a word
      const tail = text.slice(cursor);
      const tokenMatch = tail.match(/^[^\s~]+/);
      right = tokenMatch ? tokenMatch[0] : '';
      cursor += right.length;
    }

    original += wrong;
    corrected += right;
    i = cursor;
  }
  return { original: original.trim(), corrected: corrected.trim() };
}

// Classify a correction pair as Spelling or Grammar.
// Rule: Spelling cards are ONLY for true word-pair corrections — both original
// and corrected are a single token. Anything multi-word (even if the reason
// mentions "typo") is Grammar. This keeps Spelling cards compact (word→word)
// and routes mixed sentence-level corrections to Grammar where the full
// context is useful.
export function classify(pair, reason) {
  if (pair.original && pair.corrected) {
    const oWords = pair.original.trim().split(/\s+/).filter(Boolean);
    const cWords = pair.corrected.trim().split(/\s+/).filter(Boolean);
    if (oWords.length === 1 && cWords.length === 1) {
      return 'Spelling';
    }
  } else if (pair.corrected) {
    // Legacy: no original captured. Fall back to corrected word count.
    const cWords = pair.corrected.trim().split(/\s+/).filter(Boolean);
    if (cWords.length === 1) return 'Spelling';
  }
  return 'Grammar';
}

// Build Anki note objects from a list of {pair, reason, sourceUuid, sourceFile}.
// Spelling cards are compact word-pair layout; Grammar cards are sentence-pair
// with a word-level diff. Placeholder entries are filtered out.
export function buildNotes(corrections, commonTags = ['English', 'PersonalErrors']) {
  return corrections.filter((entry) => !isPlaceholderPair(entry.pair?.original, entry.pair?.corrected)).map((entry) => {
    const { pair, reason, sourceUuid } = entry;
    const category = classify(pair, reason);
    const deckName = category === 'Spelling'
      ? 'English::Personal Errors::Spelling'
      : 'English::Personal Errors::Grammar';

    let front, back, extraTags = [];
    if (category === 'Spelling' && pair.original) {
      // Compact word-pair card: just the wrong word → the right word + reason.
      // No "Spot the issue" prefix and no diff section — overkill for one word.
      front = `<span style="font-size:1.4em">${htmlEscape(pair.original)}</span>`;
      back = `<span style="font-size:1.4em;color:#27ae60;font-weight:bold">${htmlEscape(pair.corrected)}</span>${reason ? `<br><br><i>${htmlEscape(reason)}</i>` : ''}`;
    } else if (pair.original) {
      // Grammar sentence-pair card with full diff visualization.
      const diff = renderWordDiff(pair.original, pair.corrected);
      front = `<i>Spot the issue:</i><br><br>${htmlEscape(pair.original)}`;
      back = [
        `<b>Corrected:</b><br>${htmlEscape(pair.corrected)}`,
        `<b>What changed:</b><br>${diff}`,
        reason ? `<i>${htmlEscape(reason)}</i>` : null,
      ].filter(Boolean).join('<br><br>');
    } else {
      // Degraded shape (only when fuzzy match also failed to recover original)
      extraTags.push('no-original');
      front = `<i>What's the natural English?</i>${reason ? `<br><br>${htmlEscape(reason)}` : ''}`;
      back = `<b>${htmlEscape(pair.corrected)}</b>`;
    }

    return {
      deckName,
      modelName: 'Basic',
      fields: { Front: front, Back: back },
      tags: [...commonTags, category, ...extraTags, ...(sourceUuid ? [`src-${sourceUuid.slice(0, 8)}`] : [])],
      options: { allowDuplicate: true },
    };
  });
}

// Render a word-level diff using markdown-strikethrough-equivalent HTML.
// Uses a simple Myers-style LCS over tokens for compactness.
export function renderWordDiff(original, corrected) {
  const a = original.split(/(\s+)/);
  const b = corrected.split(/(\s+)/);
  // LCS table
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  // Backtrack to produce ops
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ type: 'eq', token: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: 'add', token: b[j - 1] });
      j--;
    } else {
      ops.unshift({ type: 'del', token: a[i - 1] });
      i--;
    }
  }
  return ops.map((o) => {
    if (o.type === 'eq') return htmlEscape(o.token);
    if (o.type === 'del') return `<span style="color:#c0392b;text-decoration:line-through">${htmlEscape(o.token)}</span>`;
    return `<span style="color:#27ae60;font-weight:bold">${htmlEscape(o.token)}</span>`;
  }).join('');
}

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Load a transcript as a Map of uuid -> entry for parent walking.
export function loadTranscriptIndex(filePath) {
  const byUuid = new Map();
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.uuid) byUuid.set(e.uuid, e);
    } catch {}
  }
  return byUuid;
}

// Heuristic: distinguish real user typing from synthetic injections (skill content,
// tool results, slash command expansions).
function isSyntheticUserMessage(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 5) return true;
  if (t.startsWith('Base directory for this skill:')) return true;
  if (t.startsWith('Launching skill:')) return true;
  if (t.startsWith('<command-name>')) return true;
  if (t.startsWith('<local-command-stdout>')) return true;
  if (t.startsWith('Tool ran without output')) return true;
  if (t.startsWith('Caveat: The messages below were generated')) return true;
  if (t.startsWith('[Image:') || t.startsWith('[Pasted text')) return true;
  if (/^\s*\[(Image|Pasted [^\]]+)\][\s\S]*\]\s*$/.test(t)) return true;
  return false;
}

// Walk up parent UUIDs to find the most recent REAL user typing — skipping
// tool_result entries and skill/command injections.
export function findPrecedingUserText(entry, byUuid) {
  let parentUuid = entry?.parentUuid;
  let safety = 200;
  while (parentUuid && safety-- > 0) {
    const parent = byUuid.get(parentUuid);
    if (!parent) return null;

    if (parent.message?.role === 'user') {
      const content = parent.message.content;
      let text = null;

      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        const hasToolResult = content.some((b) => b?.type === 'tool_result');
        if (hasToolResult) {
          parentUuid = parent.parentUuid;
          continue;
        }
        text = content
          .filter((b) => b?.type === 'text')
          .map((b) => b.text || '')
          .filter(Boolean)
          .join('\n');
      }

      if (text && !isSyntheticUserMessage(text)) {
        return text;
      }
    }
    parentUuid = parent.parentUuid;
  }
  return null;
}

// Fuzzy-match a corrected sentence against a user message to find the
// original substring the user actually wrote. Returns a string or null.
export function findOriginalSubstring(corrected, userMessage) {
  if (!userMessage || !corrected) return null;

  // Strip ALL paired XML-like tag blocks (system-reminder, command-*, etc.)
  // then strip leftover unpaired tags. Repeat until stable to handle nesting.
  let cleaned = userMessage;
  let prev = '';
  while (prev !== cleaned) {
    prev = cleaned;
    cleaned = cleaned.replace(/<(\w[\w-]*)[^>]*>[\s\S]*?<\/\1>/g, '');
  }
  cleaned = cleaned.replace(/<\/?\w[\w-]*[^>]*>/g, '').trim();

  if (!cleaned) return null;

  const correctedTokens = corrected.toLowerCase().match(/\b\w+\b/g) || [];
  const userTokens = cleaned.toLowerCase().match(/\b\w+\b/g) || [];
  if (correctedTokens.length === 0 || userTokens.length === 0) return null;

  // If corrected length is similar to whole user message, treat user message as the original
  if (correctedTokens.length >= userTokens.length * 0.5) {
    return cleaned;
  }

  // Sliding-window Jaccard over tokens
  const winSize = correctedTokens.length;
  const setCorrected = new Set(correctedTokens);
  let bestScore = 0;
  let bestStart = -1;
  for (let i = 0; i + winSize <= userTokens.length; i++) {
    const win = userTokens.slice(i, i + winSize);
    const setWin = new Set(win);
    let inter = 0;
    for (const t of setCorrected) if (setWin.has(t)) inter++;
    const uni = new Set([...setCorrected, ...setWin]).size;
    const score = uni === 0 ? 0 : inter / uni;
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  if (bestScore < 0.25) {
    // No strong inline match — fall back to whole user message
    return cleaned;
  }

  // Reconstruct substring from cleaned message
  const wordRe = /\S+/g;
  const tokens = [];
  let m;
  while ((m = wordRe.exec(cleaned)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length });
  }
  if (bestStart >= tokens.length) return cleaned;
  const endIdx = Math.min(bestStart + winSize - 1, tokens.length - 1);
  return cleaned.slice(tokens[bestStart].start, tokens[endIdx].end);
}

// Process a JSONL transcript file into a list of correction entries,
// using parent-UUID walking + fuzzy match to recover originals when the
// fluency note itself only has the corrected version.
export function extractFromTranscript(filePath) {
  const out = [];
  const byUuid = loadTranscriptIndex(filePath);

  for (const entry of byUuid.values()) {
    if (entry?.message?.role !== 'assistant') continue;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;

    // Lazily resolve user text only when we find a fluency note
    let userText = null;
    let userTextResolved = false;

    for (const block of content) {
      if (block?.type !== 'text') continue;

      // PRIMARY: machine-data blocks (current format)
      const dataBlocks = extractFluencyDataBlocks(block.text);
      if (dataBlocks.length > 0) {
        for (const d of dataBlocks) {
          out.push({
            pair: { original: d.original, corrected: d.corrected },
            reason: d.reason,
            sourceUuid: entry.uuid,
            sourceFile: filePath,
            raw: 'machine-block',
            format: 'machine-block',
          });
        }
        continue; // skip legacy parsing if we found machine blocks
      }

      // LEGACY fallback: parse `(Fluency note ...)` blocks for old transcripts.
      const notes = extractFluencyNotes(block.text);
      if (notes.length === 0) continue;

      if (!userTextResolved) {
        userText = findPrecedingUserText(entry, byUuid);
        userTextResolved = true;
      }

      for (const note of notes) {
        const parsed = parseNote(note);
        if (!parsed) continue;
        for (const pair of parsed.pairs) {
          let original = pair.original;
          if (!original) {
            original = findOriginalSubstring(pair.corrected, userText);
          }
          out.push({
            pair: { original, corrected: pair.corrected },
            reason: parsed.reason,
            sourceUuid: entry.uuid,
            sourceFile: filePath,
            raw: note,
            format: parsed.format,
          });
        }
      }
    }
  }
  return out;
}
