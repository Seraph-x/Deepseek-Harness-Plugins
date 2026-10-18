# DeepSeek Harness Plugins

A small monorepo of plugins for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH). Each plugin is an independent package under `plugins/`, with its own manifest, bundle patch, client half, locale, and icon — so every one of them installs, updates, and toggles on its own.

## Plugins

| Package | What it does |
| --- | --- |
| [`dsh-session-manager`](plugins/session-manager) | Session management: delete a session for real (files, projection cache, workspace bookkeeping, live in-memory agent) with a restorable trash, batch archive/unarchive/delete, and a configurable policy for the sessions a workspace leaves behind when it is deleted. |

## Install

From a local checkout:

```
plugin_manager install_bundle  target=/absolute/path/to/Deepseek-Harness-Plugins/plugins/session-manager
```

Straight from GitHub (pnpm git subdirectory spec):

```
plugin_manager install_bundle  target=github:Seraph-x/Deepseek-Harness-Plugins#path:/plugins/session-manager
```

After changing plugin code: reload the Host half (`plugin_manager` `set_plugin`, target `include:<patch id>`, disable then enable) and refresh the page for the client half.

## Layout

```
plugins/<name>/
  package.json        # name, exports, dsh.bundle.patch, dsh.client
  cordis.patch.yml    # add-only insert row(s) into the loader graph
  lib/index.js        # Host half: services, HTTP routes, loader listeners
  lib/client.js       # Browser half: slot registrations (window.__ModuleLoader__)
  locale/en.json      # plugin-manager title + description
  locale/zh.json
  icon.svg
  README.md
```

A plugin package may expose several loader rows through extra `exports` entries (a `dsh-purge`-style split), but this repo keeps one package per plugin so each one stays independently versioned.

## Development

```bash
pnpm install          # links the workspace packages
pnpm --filter dsh-session-manager test   # if the package defines tests
```

## License

MIT
