# DeepSeek Harness Plugins

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) that fill
gaps in the session lifecycle: managing sessions the host will not delete, and
getting a session out as a document you can read, diff, or hand to someone else.

One package per plugin under `plugins/`, each with its own manifest and bundle
patch, so every plugin installs, updates, and toggles on its own.

## Plugins

| Package | Form | What it does |
| --- | --- | --- |
| [`dsh-session-manager`](plugins/sessionManager) | Host + Web UI | Delete a session for real, with a restorable trash. Batch archive, unarchive, and delete. Decides what happens to the sessions a deleted workspace leaves behind. |
| [`dsh-session-export`](plugins/sessionExport) | Host only | Turn a session log into Markdown, plain text, HTML, JSONL, or PDF, with home paths, user names, e-mail addresses, and credentials redacted. |

### dsh-session-manager

DSH archives sessions but never deletes them — `sessionPersistence`,
`sessionController`, and `workspaceRegistry` expose no `delete`. This plugin
adds the missing half.

- **Delete for real.** A session row menu gains *Delete session*: move it to
  `~/.dsh/.session-trash/<timestamp>__<sessionId>/`, or remove it outright.
  Deleting also clears the projection cache, workspace bookkeeping, and any live
  agent held in memory.
- **Restorable trash.** Every trashed session keeps its original path,
  workspace, title, and size, so restore puts the row back in the sidebar
  without a page reload.
- **Batch operations.** A *Session management* settings page lists every
  session the host knows, with search, filters, and select-all. Archive,
  unarchive, trash, or delete in bulk; each action reports per-session success
  and failure, and both delete paths need a second click.
- **Workspace policy.** When a workspace is deleted, its sessions can go to
  *Ungrouped* (system default), be archived, or be deleted — configurable at
  `~/.dsh/session-manager.config.json` or in the settings page.

### dsh-session-export

- **Five formats.** `markdown`, `text`, `html`, `jsonl`, `pdf`. PDF carries
  exactly the content the text renderer produces.
- **Redaction by default.** Home paths, user names, e-mail addresses, cloud and
  forge tokens, JWTs, cookies, private keys, `Authorization` headers, and any
  assignment whose key looks secret. The result reports per-category hit counts,
  so a sweep is verifiable instead of assumed.
- **Batch and safe writes.** Export one session or many, with per-session
  failures reported separately; existing files are never clobbered unless you
  ask.
- **Zero dependencies.** Only Node builtins. The PDF writer is hand-rolled —
  Courier plus STSong-Light, no font embedding, so CJK renders through the
  reader's own fonts.

Two entry points: the `export_session` tool and the `/export-session` command.

## Install

From a local checkout:

```
plugin_manager install_bundle  target=/absolute/path/to/Deepseek-Harness-Plugins/plugins/sessionManager
plugin_manager install_bundle  target=/absolute/path/to/Deepseek-Harness-Plugins/plugins/sessionExport
```

Straight from GitHub (pnpm git subdirectory spec):

```
plugin_manager install_bundle  target=github:Seraph-x/Deepseek-Harness-Plugins#path:/plugins/sessionManager
plugin_manager install_bundle  target=github:Seraph-x/Deepseek-Harness-Plugins#path:/plugins/sessionExport
```

Restart the host after installing a bundle. After changing plugin code, reload
the Host half with `plugin_manager` (`set_plugin`, target `include:<patch id>`,
disable then enable) and refresh the page for the client half.

## Layout

A Host-only plugin needs two files; a plugin with a Web UI adds the browser
half, locale, and icon:

```
plugins/<name>/
  package.json        # name, exports, dsh.bundle.patch, dsh.client
  cordis.patch.yml    # add-only insert row(s) into the loader graph
  lib/index.js        # Host half: services, HTTP routes, loader listeners
  lib/client.js       # Browser half: slot registrations — only with a UI
  locale/en.json      # plugin-manager title + description — only with a UI
  locale/zh.json
  icon.svg
  test/               # node:test suites — only where the logic is pure
  README.md
```

A package may expose several loader rows through extra `exports` entries (a
`dsh-purge`-style split), but this repo keeps one package per plugin so each one
stays independently versioned.

Directory names are camelCase. Package names are lowercase with hyphens because
npm forbids capitals.

## Development

```bash
pnpm install                             # links the workspace packages
pnpm --filter dsh-session-manager test
pnpm --filter dsh-session-export test
```

The export plugin's suite runs on Node's built-in runner — no test framework to
install:

```bash
cd plugins/sessionExport && node --test test/
```

## Requirements

- DSH with the `sessionPersistence`, `sessions`, `tools`, and `commands`
  services mounted (both plugins read sessions through them).
- Node 20 or newer.
- No third-party runtime dependencies.

## License

MIT
