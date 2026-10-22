#!/usr/bin/env node
/**
 * Archive every session that belongs to one workspace.
 *
 * A workspace is a directory. Its sessions live under
 * `~/.dsh/sessions/<slug>/<session-id>/`, where the slug is the absolute path
 * with `/` turned into `-` and wrapped in `--`. Deleting the directory does not
 * delete those sessions, but the UI has no workspace left to show them under —
 * so this writes a copy you can read, grep, and hand to an agent later.
 *
 *   node scripts/export-workspace.mjs <workspace-path> [out-dir] [format] [--no-sanitize]
 *
 *   node scripts/export-workspace.mjs ~/Downloads/Test ~/Desktop/test-archive
 *   node scripts/export-workspace.mjs ~/Downloads/Test ~/Desktop/test-archive jsonl
 *   node scripts/export-workspace.mjs ~/Downloads/Test ~/Desktop/test-archive markdown --no-sanitize
 *
 * Defaults: out-dir `session-archive`, format `markdown`, redaction on.
 *
 * Why the cwd check below exists: the slug is lossy. `/a/b-c` and `/a/b/c` both
 * become `--a-b-c--`, so two different workspaces can share one session
 * directory. Every candidate is re-checked against the real cwd recorded in the
 * projection cache before it is exported.
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
const positional = argv.filter((arg) => !arg.startsWith('--'));
const [workspaceArg, outArg = 'session-archive', formatArg = 'markdown'] = positional;
const sanitize = !flags.has('--no-sanitize');

if (workspaceArg === undefined) {
	console.error('usage: node scripts/export-workspace.mjs <workspace-path> [out-dir] [format] [--no-sanitize]');
	process.exit(2);
}

const home = homedir();
const workspace = resolve(workspaceArg.replace(/^~(?=\/|$)/u, home));
const sessionsParent = join(home, '.dsh', 'sessions');
const projectionDir = join(home, '.dsh', 'storages', 'session_projcache', 'sessions');
const slug = '--' + workspace.replace(/^\//u, '').split('/').join('-') + '--';
const sessionsRoot = join(sessionsParent, slug);

/** The projection cache is small and carries the identity; prefer it. */
function projectedCwd(id) {
	try {
		const record = JSON.parse(readFileSync(join(projectionDir, id + '.json'), 'utf8'));
		const cwd = record?.record?.identity?.cwd;
		return typeof cwd === 'string' ? cwd : undefined;
	} catch {
		return undefined;
	}
}

/** Fall back to the header line of the compressed log. */
function loggedCwd(slugName, id) {
	try {
		const file = join(sessionsParent, slugName, id, 'session.v4.jsonl.zstd');
		const first = zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n')[0];
		const header = JSON.parse(first);
		return typeof header.cwd === 'string' ? header.cwd : undefined;
	} catch {
		return undefined;
	}
}

function knownWorkspaces() {
	const seen = new Set();
	for (const name of readdirSync(sessionsParent)) {
		try {
			for (const id of readdirSync(join(sessionsParent, name))) {
				if (!id.startsWith('session-')) continue;
				const cwd = projectedCwd(id) ?? loggedCwd(name, id);
				if (cwd !== undefined) {
					seen.add(cwd);
					break;
				}
			}
		} catch {
			/* an unreadable workspace is not an error here */
		}
	}
	return [...seen].sort();
}

let candidates;
try {
	candidates = readdirSync(sessionsRoot).filter((name) => name.startsWith('session-')).sort();
} catch {
	console.error('no sessions for ' + workspace);
	console.error('looked in ' + sessionsRoot);
	const known = knownWorkspaces();
	if (known.length > 0) {
		console.error('known workspaces:');
		for (const cwd of known) console.error('  ' + cwd.replace(home, '~'));
	}
	process.exit(1);
}

const ids = candidates.filter((id) => {
	const cwd = projectedCwd(id) ?? loggedCwd(slug, id);
	return cwd === undefined || resolve(cwd) === workspace;
});
const skipped = candidates.length - ids.length;

if (ids.length === 0) {
	console.error('no sessions for ' + workspace);
	process.exit(1);
}

/** The compressed log on disk is the source of truth; the projection is a view. */
function loadSession(id) {
	const file = join(sessionsRoot, id, 'session.v4.jsonl.zstd');
	const lines = zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
	return {
		header: lines.find((entry) => entry.type === 'session') ?? { id },
		events: lines.filter((entry) => entry.type !== 'session'),
	};
}

const plugin = await import(new URL('../plugins/sessionExport/lib/index.js', import.meta.url).href);

let definition;
plugin.apply(
	{
		get: (name) =>
			name === 'sessionPersistence'
				? {
						open: (id) => {
							const log = loadSession(id);
							return { header: log.header, read: () => ({ events: log.events }), close() {} };
						}
					}
				: undefined,
		tools: { register: (d) => { definition = d; } },
		commands: { register() {} },
	},
	{}
);

const outDir = resolve(outArg.replace(/^~(?=\/|$)/u, home));
mkdirSync(outDir, { recursive: true });

const result = await definition.execute(
	{ sessions: ids, format: formatArg, sanitize, output_dir: outDir, overwrite: false },
	{ signal: undefined }
);

for (const item of result.exports) {
	console.log(item.path.replace(home, '~') + '  [' + item.format + ', ' + item.bytes + ' bytes, ' + item.turns + ' turns]');
}
for (const failure of result.failed) {
	console.error('FAILED ' + failure.session_id + ': ' + failure.error);
}

console.log('');
console.log(result.exports.length + ' of ' + ids.length + ' sessions written to ' + outDir.replace(home, '~'));
if (skipped > 0) console.log(skipped + ' skipped: another workspace shares this slug');
console.log('redaction ' + (sanitize ? 'on' : 'off'));
