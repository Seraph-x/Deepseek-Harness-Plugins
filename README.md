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
| [`dsh-session-export`](plugins/sessionExport) | Host + Web UI | Turn a session log into Markdown, plain text, HTML, JSONL, or PDF, with home paths, user names, e-mail addresses, and credentials redacted. The result card copies the exported path on click and opens it in the right sidebar. |

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
- **Batch operations.** A *Session manager* settings page lists every
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
- **Names that say what the session was.** Files are named after the session
  title — `安装-dsh-purge-插件.pdf`, not `session-1a2b3c4d.pdf` — trimmed to a
  filesystem-safe stem of at most 50 em units. Name templates cover the cases
  where that is not enough.
- **Batch and safe writes.** Export one session or many, with per-session
  failures reported separately; existing files are never clobbered unless you
  ask.
- **Zero dependencies.** Only Node builtins. The PDF writer is hand-rolled —
  Courier plus STSong-Light, no font embedding, so CJK renders through the
  reader's own fonts.
- **The result is a place, not a paragraph.** In the Web UI the command's
  result card lists every file it wrote: click a row to copy its path, press
  `Preview` to open it in the right sidebar, where PDFs, Markdown, images,
  Office files, and spreadsheets render in place. The host half still prints
  the same text for the terminal.

Two entry points: the `export_session` tool and the `/export-session` command.
The command takes short flags that combine, so the common case is one word —
`/export-session --bare` is a PDF of the conversation alone, unsanitized;
`-pqr` spells the same thing out.

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

## Archiving a workspace

Deleting a workspace directory does not delete its sessions — the logs live
under `~/.dsh/sessions/<slug>/` and survive the directory — but the UI has no
workspace left to list them under. `scripts/export-workspace.mjs` writes a
readable copy first:

    node scripts/export-workspace.mjs ~/Downloads/Test ~/Desktop/test-archive

One Markdown file per session, named after the session title, with the tool
calls and results intact — that is the part you need when you come back to ask
an agent why something broke. Add `--no-sanitize` to keep real paths, or a
third argument (`jsonl`, `text`, `html`, `pdf`) to change the format.

The slug is lossy: `/a/b-c` and `/a/b/c` collapse to the same session
directory, so the script re-checks each candidate against the real `cwd`
recorded in the projection cache and skips the ones that belong elsewhere.

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
