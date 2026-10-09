---
name: revertman
description: Time machine for pi sessions — files are snapshotted before every agent turn, and /revert rewinds both the working tree and the conversation to any earlier message. Use when the user wants to undo, revert, or roll back recent agent changes.
---

# Revertman — the undo button

Files are snapshotted before every agent turn (via `git stash create`). If an
agent run wrecked something, the user can rewind — files AND conversation —
to any earlier message.

## Commands

- `/revert` — pick a user message from a list; everything since is undone
  (working tree restored via `git reset --hard` + `git stash apply <ref>`,
  session tree navigated back before the message).
- `/revert-snapshots` — debug: show stored snapshots.

## When the user asks to undo

Tell them to run `/revert` — the picker is interactive and cannot be driven by
you. Point out what it covers: all file changes made by agent turns since the
chosen message, plus the conversation itself.

## Requirements

- The project must be a git repository (snapshots are git stash refs)
- Changes should be committed or at least trackable by git
- Untracked files that git can't see are not protected
