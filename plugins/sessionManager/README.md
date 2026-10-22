# dsh-session-manager

DSH can archive a session, but it **never deletes** one: `sessionPersistence` has no `delete`, `sessionController` has no `delete`, and `workspaceRegistry` only offers archive/pin. This plugin fills in "session management": real deletion (with a restorable trash), batch archive / unarchive, batch delete, and what happens to a workspace's sessions when you delete that workspace.

> The old name `dsh-plugin-session-delete` (v1) is now `dsh-session-manager` (v2). Trash entries deleted by v1 (`.session-delete.json`) can still be read and restored.

## What it looks like in use

**Delete**: the `...` menu on a sidebar session row gains **Delete session** at the very bottom (red text plus a 14px trash icon, with the same row height and padding as system items such as "Pin session", a separator line, and placed after "Copy session ID").
Click it → a frame-level confirm dialog (`shell.overlay`, outside the menu, so it survives the menu closing) → choose one of two:

- **Move to trash**: `~/.dsh/.session-trash/<timestamp>__<sessionId>/`, with a `.session-manager.json` inside (original path, workspace, title, size, restore command).
- **Delete permanently**: equivalent to `rm -rf`, not undoable.

A result toast follows the deletion; in trash mode the toast carries an **Undo** button that calls the restore endpoint directly.

**Restore**: Settings → **Session manager** → the Trash tab (detailed below).

## Settings page: Session manager

The settings panel gains one more page, **Session manager** (`settings.section`, order 600), with three tabs:

- **Sessions**: every session the host knows about (`/sessions`), with running/archived badges, owning workspace, and time. A search box plus four filter chips (All / Unarchived / Archived / Ungrouped) and select-all. Once selected you can **archive / unarchive / move to trash / delete permanently** — bulk goes through `/batch/archive` and `/batch/delete`, executed one by one with each success or failure reported back; both delete actions require **a second click to confirm** (the button label becomes "Delete permanently?").
- **Trash**: every deleted session (title, deletion time, size, sessionId), each with **Restore / Delete permanently**, and **Empty trash** at the bottom (two-step confirmation).
- **Settings**: two policy radio groups — what happens to a workspace's sessions when that workspace is deleted (leave it to the system / archive / delete), and whether this plugin's deletions go to the trash or are permanent by default. Every change is written to disk immediately, and the config file path is shown at the bottom of the page.

What restore does: move the directory back to its original location → remove the leftover `.session-manager.json` → `Workspace.attachSession(id)` to reattach it to its original workspace → the client's `sessions.refresh()` to re-pull the baseline. The sidebar row comes back immediately, with no page reload.

## Session policy when a workspace is deleted

The sidebar has no workspace-level menu slot, so this policy lives on the host side: the plugin subscribes to `domain/changed` and remembers each workspace's id / path / title / session list; when a `deleted` entry appears in the `workspace` domain's `workspaces` table, it takes that workspace's snapshot and handles its sessions according to the config:

| `workspaceDeleteMode` | Behavior |
| --- | --- |
| `system` (default) | Do nothing; the sessions land in "Ungrouped" in the sidebar, matching native behavior |
| `archive` | Archive everything (`archiveSession(id, { stopActivity: true })`), so they move to "Archived" and can be unarchived in bulk at any time |
| `delete` | Delete everything, through the trash or permanent deletion selected by `deleteMode` |

Config file `~/.dsh/session-manager.config.json` (also editable from the settings page):

```json
{ "workspaceDeleteMode": "system", "deleteMode": "trash" }
```

Precedence: built-in defaults < loader entry `config` < config file.

## One deletion does four things

| Target | Location | Method |
| --- | --- | --- |
| The live session in memory | `store` of SessionStore / AgentService | `detachEntered(entry)`, which fires `session/disposed` |
| Session files | `$DSH_HOME/sessions/<cwd-encoded>/<sessionId>/` | Move to trash or delete |
| Projection cache | `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json` | Delete |
| Workspace bookkeeping | the in-memory `workspace.json` | `Workspace.detachSession(id)` + `unpinSession` + `unarchiveSession` |

Deleting the disk files without detaching the bookkeeping leaves that sidebar row hanging forever; detaching the bookkeeping without deleting the files leaves the data on disk orphaned. So we do both.

**Why detach from memory too**: `sessionController.list()` (`dsh-api-session-controller/lib/types/list.js:108`) returns "sessions that are attached **and** persisted"; the implementation does `const live = this.ctx.sessions.get(id); if (live !== undefined) items.push(...)`. An agent's owner is the agents service's own ctx (`const ownerCtx = this.ctx` inside `resume()` at `dsh-agent/lib/index.js:467`), so refreshing the page or dropping the connection never releases it — delete only the files and `list()` keeps emitting that row, the sidebar files it under "Ungrouped", and it looks like "the session wasn't deleted, it just moved out of the workspace".

The correct entry point is `SessionStore.detachEntered(entry)` (`dsh-session/lib/index.js:1887`): `store.delete(id)` + emit `session/disposed`; the controller listens for it and emits `api-session/removed`, the client manager receives that and applies `{kind:'remove'}`, and **the row disappears at once, with no page reload needed**. Same for `AgentService.detachEntered` (`:541`). Neither method is in the service catalog, so all of it is wrapped in `try/catch` plus feature detection: even if a host upgrade renames them, the deletion flow will not crash — it just detaches one layer less.

## Why restore has to be two steps

`Workspace.attachSession(id)` reads the session header and checks `header.cwd === workspace.path`. If the file is not on disk it throws `session persistence holds no such session` outright. So the order is fixed: **rename back to the original location first, then attach**.

That sidebar row has a second condition: the client sessions store must have a summary in `list.byId[id]`. The host's `session.list()` scans the disk every time, so after restoring, calling `ctx.sessions.refresh()` (internally `remote.session.list({})`) is enough to get the new summary. The workspace side needs nothing — `attachSession` goes through a storage table.update, which fires `domain/changed`, and the `useWorkspaces` snapshot updates itself.

When an old entry has no `workspaceId`, we locate the workspace by normalizing the `workspaceBucket` from `.session-manager.json` and the paths from `registry.list()` and comparing **alphanumerics only**.

## Composition

- `lib/index.js` — the host half. `inject: ['webServer']`, registers ten same-origin routes (`delete` / `trash` / `restore` / `trash/purge` / `live` / `evict` / `config` / `sessions` / `batch/delete` / `batch/archive`), plus one `domain/changed` listener (the workspace-deletion policy).
  - Guards (shared by every route): loopback only, method must match, must carry `x-dsh-session-manager: 1`, cross-origin `Origin` rejected, id must be a bare identifier (`/` `\` `..` forbidden).
  - Session is running: best-effort `cancel` first, then `evictLiveAgent` (`sessions.detachEntered` → `agents.detachEntered` → agent scope dispose), and only then touch the files; after deleting, check again whether the directory was written back by a live handle, and if so report `partial` + `residual`.
  - `{ "dryRun": true }` only reports what would be deleted (paths, byte counts, whether busy) and touches nothing.
- `lib/client.js` — the browser half. `window.__ModuleLoader__.load(...)`, `inject: ['slots', 'locale']`.
  - `sidebar.workspaces.session.menu.item` (order 500), `settings.section` (id `session-manager`, order 600), `shell.overlay` (order 500).
  - When the session being deleted is the one currently open, call `uiWorkspace.openWorkspace(...)` first to look elsewhere and then refresh, so the panel does not sit on a session that no longer exists.
  - Requires no Harness Client package at all; styles are fully inline and use only `--dsw-alias-*` tokens, so a host upgrade cannot break the slot entry.
  - If the slot does not pass in the props of the inject factories (`t` / `refresh`, etc.), each one has a module-level fallback, so nothing throws.
- `locale/*.json` — the title/description on the plugin management page; UI copy goes through `ctx.locale.register` + `bind` and follows the current language (en / zh).

## Route contract

```bash
# Delete (dryRun only reports)
curl -s -X POST http://127.0.0.1:53199/dsh-session-manager/delete \
  -H 'content-type: application/json' -H 'x-dsh-session-manager: 1' \
  -d '{"sessionId":"session-xxxx","mode":"trash","displayTitle":"Title","dryRun":true}'

# Trash listing
curl -s http://127.0.0.1:53199/dsh-session-manager/trash -H 'x-dsh-session-manager: 1'

# Restore (trashId or sessionId, pick one)
curl -s -X POST http://127.0.0.1:53199/dsh-session-manager/restore \
  -H 'content-type: application/json' -H 'x-dsh-session-manager: 1' \
  -d '{"trashId":"2026-10-18T11-25-39-134Z__session-xxxx"}'

# Permanently purge one entry / empty the whole trash
curl -s -X POST http://127.0.0.1:53199/dsh-session-manager/trash/purge \
  -H 'content-type: application/json' -H 'x-dsh-session-manager: 1' \
  -d '{"trashId":"2026-10-18T11-25-39-134Z__session-xxxx"}'

# Diagnostics: which live sessions / agents are held in memory right now; with sessionId, also whether session.list() still lists it
curl -s 'http://127.0.0.1:53199/dsh-session-manager/live?sessionId=session-xxxx' -H 'x-dsh-session-manager: 1'

# Session inventory (input for batch operations): title / cwd / running / archived / pinned / workspace
curl -s http://127.0.0.1:53199/dsh-session-manager/sessions -H 'x-dsh-session-manager: 1'

# Batch delete (mode defaults to the config; 200 entries max)
curl -s -X POST http://127.0.0.1:53199/dsh-session-manager/batch/delete \
  -H 'content-type: application/json' -H 'x-dsh-session-manager: 1' \
  -d '{"sessionIds":["session-a","session-b"],"mode":"trash"}'

# Batch archive / unarchive
curl -s -X POST http://127.0.0.1:53199/dsh-session-manager/batch/archive \
  -H 'content-type: application/json' -H 'x-dsh-session-manager: 1' \
  -d '{"sessionIds":["session-a"],"archived":true}'

# Read / update config
curl -s http://127.0.0.1:53199/dsh-session-manager/config -H 'x-dsh-session-manager: 1'
curl -s -X POST http://127.0.0.1:53199/dsh-session-manager/config \
  -H 'content-type: application/json' -H 'x-dsh-session-manager: 1' \
  -d '{"workspaceDeleteMode":"archive","deleteMode":"purge"}'

# Detach a single session from memory (touches no disk; the delete flow already does this internally)
curl -s -X POST http://127.0.0.1:53199/dsh-session-manager/evict \
  -H 'content-type: application/json' -H 'x-dsh-session-manager: 1' \
  -d '{"sessionId":"session-xxxx"}'
```

Delete response example:

```json
{ "ok": true, "code": "deleted", "sessionId": "session-xxxx", "mode": "trash",
  "trashId": "2026-10-18T11-37-45-611Z__session-xxxx",
  "evicted": { "attempted": true, "live": false,
               "steps": [{ "step": "sessions.detachEntered", "ok": true },
                         { "step": "agents.detachEntered", "ok": true },
                         { "step": "agent.scope.rawDispose", "ok": true }] },
  "removed": [{ "path": "...", "how": "trashed", "destination": "..." }],
  "removedCache": ["..."], "detachedWorkspaces": ["85410a3d-..."],
  "clearedBookkeeping": ["unpinSession", "unarchiveSession"], "residual": [] }
```

Restore response example (`attachedTo` is the workspace id; when it cannot be reattached it is `{ failed: "<reason>" }`):

```json
{ "ok": true, "code": "restored", "sessionId": "session-xxxx",
  "path": "/Users/.../sessions/--Users-...--/session-xxxx",
  "attachedTo": "85410a3d-6c08-45a2-901f-75f72f1b5ae9", "unarchived": false }
```

Error codes: `not-found` / `trash-miss` / `destination-exists` / `trash-corrupt` / `session-busy` / `partial` / `invalid-session-id` / `invalid-trash-id` / `missing-intent-header` / `forbidden`.

## Manual operation (works without the plugin)

```bash
# Restore one: move it back to its original location, remove the leftover meta, then restart dsh (or let it re-attach)
mv ~/.dsh/.session-trash/2026-10-18T11-25-39-134Z__session-xxxx \
   ~/.dsh/sessions/--Users-...--/session-xxxx
rm ~/.dsh/sessions/--Users-...--/session-xxxx/.session-manager.json
```

## Install / update

```
# From a local checkout
plugin_manager install_bundle  target=/absolute/path/to/Deepseek-Harness-Plugins/plugins/sessionManager

# Straight from GitHub (pnpm git subdirectory spec)
plugin_manager install_bundle  target=github:Seraph-x/Deepseek-Harness-Plugins#path:/plugins/sessionManager
```

After changing code: the host half needs a reload (`plugin_manager set_plugin` with the loader entry id `include:session-manager` as the target, off then on); the browser half only needs a page refresh (`dsh-client-hmr` usually reloads it automatically).
