# Revertman for pi

*The undo button. Every agent turn gets a snapshot — rewind files and
conversation to any message you want.*

A [pi](https://pi.dev) extension that snapshots your file state before each
agent turn and gives you a `/revert` command: pick an earlier user message,
undo all file changes since then, and rewind the conversation tree with it.

```bash
pi install git:github.com/monstrous-dev/revertman
```

## What you get

- **Automatic snapshots** — before each assistant turn, the working tree is
  captured as a git stash ref. No action required from you.
- **`/revert`** — pick a user message from a list; files are restored
  (`git reset --hard` + `git stash apply <ref>`) and the session tree
  navigates back to before that message.
- **`/revert-snapshots`** — debug view of stored snapshots.
- **Ships a skill** — installs a `revertman` skill so the LLM knows when to
  point you at `/revert`.

## Requirements

- [pi](https://pi.dev)
- The project must be a **git repository** — snapshots are git stash refs
- Changes should be committed or at least trackable by git (untracked files
  git can't see are not protected)

## Install

```bash
pi install git:github.com/monstrous-dev/revertman
```

Try it without installing:

```bash
pi -e git:github.com/monstrous-dev/revertman
```

## Updates

```bash
pi update --extensions          # reconcile all packages
pi update git:github.com/monstrous-dev/revertman   # just Revertman
```

Installed without a ref you track `main`; releases are git tags. Pin one:

```bash
pi install git:github.com/monstrous-dev/revertman@v0.1.0
```

## How it works

1. Before each agent turn, Revertman creates a git stash ref of the working
   tree.
2. On `/revert`, it shows your user messages with snapshot status.
3. Picking one restores files via `git reset --hard` + `git stash apply`,
   then rewinds the conversation tree to before the selected message.

All state lives in git — nothing is sent anywhere.

## Security

Revertman only touches git plumbing in your own repository. Review the source
— it's one small file.

## License

[MIT](LICENSE)
