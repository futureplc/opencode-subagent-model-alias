#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/.." && pwd)
SKILL_NAME=subagent-model-alias-smoke-test
SOURCE="$REPO_ROOT/skills/$SKILL_NAME/SKILL.md"
DEST_DIR="${HOME:?HOME must be set}/.config/opencode/skills/$SKILL_NAME"

mkdir -p "$DEST_DIR"
cp "$SOURCE" "$DEST_DIR/SKILL.md"

printf 'Installed %s to %s\n' "$SKILL_NAME" "$DEST_DIR/SKILL.md"
