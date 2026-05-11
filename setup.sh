#!/usr/bin/env bash
# Install the Anki personal learning pipeline scripts into ~/.claude/.
# Manual steps remain afterward — see README.md.

set -euo pipefail

DOTCLAUDE="${HOME}/.claude"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing from: $REPO_DIR"
echo "Target:          $DOTCLAUDE"
echo ""

mkdir -p "$DOTCLAUDE/scripts" \
         "$DOTCLAUDE/skills/flush-fluency" \
         "$DOTCLAUDE/.fluency_cursors"

cp "$REPO_DIR/scripts/fluency_lib.mjs"       "$DOTCLAUDE/scripts/"
cp "$REPO_DIR/scripts/fluency_capture.mjs"   "$DOTCLAUDE/scripts/"
cp "$REPO_DIR/scripts/fluency_flush.mjs"     "$DOTCLAUDE/scripts/"
cp "$REPO_DIR/scripts/fluency_backfill.mjs"  "$DOTCLAUDE/scripts/"
cp "$REPO_DIR/skills/flush-fluency/SKILL.md" "$DOTCLAUDE/skills/flush-fluency/"

echo "✓ Scripts copied to $DOTCLAUDE/scripts/"
echo "✓ Skill copied to   $DOTCLAUDE/skills/flush-fluency/"
echo ""
echo "Manual steps remaining (see README.md for snippets):"
echo "  1. Append the fluency rule to $DOTCLAUDE/CLAUDE.md"
echo "  2. Merge the Stop hook block into $DOTCLAUDE/settings.json"
echo "  3. Restart Claude Code"
echo "  4. Install Anki + AnkiConnect (code 2055492159) if not already"
echo ""
echo "Verify AnkiConnect when Anki is open:"
echo "  curl -s localhost:8765 -X POST -d '{\"action\":\"version\",\"version\":6}'"
