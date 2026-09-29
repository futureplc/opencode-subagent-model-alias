#!/bin/sh
set -eu

SKILL_NAME=subagent-model-alias-smoke-test
SKILL_DIR="${HOME:?HOME must be set}/.config/opencode/skills/$SKILL_NAME"
SKILL_FILE="$SKILL_DIR/SKILL.md"

if [ ! -f "$SKILL_FILE" ]; then
  printf 'Smoke-test skill is not installed at %s\n' "$SKILL_FILE"
  exit 0
fi

rm "$SKILL_FILE"
if rmdir "$SKILL_DIR" 2>/dev/null; then
  printf 'Uninstalled %s from %s\n' "$SKILL_NAME" "$SKILL_DIR"
else
  printf 'Removed %s; left the non-empty directory at %s\n' "$SKILL_FILE" "$SKILL_DIR"
fi
