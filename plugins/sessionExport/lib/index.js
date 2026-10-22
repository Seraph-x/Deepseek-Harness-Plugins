import { mkdir, readdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { collectTranscript, renderPlainText, RENDERERS } from './render.js';
import { renderPdf } from './render-pdf.js';

/** Stable Loader identity. */
export const name = 'session-export';

/** Services used by the export tool and command. */
export const inject = ['tools', 'commands'];

/** Output formats and their file extension. */
const FORMATS = Object.freeze({
	markdown: 'md',
	text: 'txt',
	html: 'html',
	jsonl: 'jsonl',
	pdf: 'pdf'
});

/** Defaults applied when neither the call nor the plugin config overrides them. */
const DEFAULTS = Object.freeze({
	format: 'markdown',
	includeToolResults: true,
	includeToolCalls: true,
	includeReasoning: false,
	includeNotices: true,
	sanitize: true,
	pathStyle: 'tilde',
	resultHeadLines: 60,
	resultTailLines: 15,
	maxArgumentChars: 4000,
	ruleWidth: 78,
	fileName: 'session-{short}.{ext}',
	overwrite: false
});

/** Tool parameters: a plain JSON Schema, validated by the tool registry. */
const PARAMETERS = {
	type: 'object',
	additionalProperties: false,
	properties: {
		session_id: {
			type: 'string',
			description: 'Session id to export. Defaults to the current session.'
		},
		sessions: {
			type: 'array',
			items: { type: 'string' },
			description: 'Several session ids to export in one call. Use with output_dir.'
		},
		format: {
			type: 'string',
			enum: ['markdown', 'text', 'html', 'jsonl', 'pdf'],
			description: 'Output format. "text" is plain unmarked-up text; "pdf" typesets that same text. Defaults to markdown.'
		},
		output_path: {
			type: 'string',
			description: 'Destination file for a single session. Relative paths resolve against the session working directory. A missing extension is added from the format.'
		},
		output_dir: {
			type: 'string',
			description: 'Destination directory. Required when exporting several sessions; the file name comes from the fileName template.'
		},
		overwrite: {
			type: 'boolean',
			description: 'Overwrite an existing file. Defaults to false, which appends -1, -2, ... instead.'
		},
		sanitize: {
			type: 'boolean',
			description: 'Redact home paths, user names, e-mail addresses, and credentials. Defaults to true.'
		},
		include_tool_results: {
			type: 'boolean',
			description: 'Include tool results (head and tail lines). Defaults to true.'
		},
		include_tool_calls: {
			type: 'boolean',
			description: 'Include tool call arguments. Defaults to true.'
		},
		include_reasoning: {
			type: 'boolean',
			description: 'Include reasoning blocks. Defaults to false.'
		},
		include_notices: {
			type: 'boolean',
			description: 'Include abort, error, compaction and permission notices. Defaults to true.'
		},
		result_head_lines: {
			type: 'integer',
			description: 'Lines kept from the top of each tool result. Defaults to 60.'
		},
		result_tail_lines: {
			type: 'integer',
			description: 'Lines kept from the bottom of each tool result. Defaults to 15.'
		}
	},
	required: []
};

/** Per-file result shape, shared by the array items and the summary. */
const EXPORT_ITEM = {
	type: 'object',
	additionalProperties: false,
	required: ['session_id', 'path', 'format', 'bytes', 'records', 'turns', 'tool_calls', 'tool_results', 'fences_balanced', 'redactions'],
	properties: {
		session_id: { type: 'string' },
		path: { type: 'string' },
		format: { type: 'string' },
		bytes: { type: 'integer' },
		records: { type: 'integer' },
		turns: { type: 'integer' },
		tool_calls: { type: 'integer' },
		tool_results: { type: 'integer' },
		fences_balanced: { type: 'boolean' },
		pages: { type: 'integer' },
		redactions: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['kind', 'count'],
				properties: {
					kind: { type: 'string' },
					count: { type: 'integer' }
				}
			}
		}
	}
};

/** Tool output schema. */
const OUTPUT = {
	type: 'object',
	additionalProperties: false,
	required: ['exports', 'failed'],
	properties: {
		exports: { type: 'array', items: EXPORT_ITEM },
		failed: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['session_id', 'error'],
				properties: {
					session_id: { type: 'string' },
					error: { type: 'string' }
				}
			}
		}
	}
};

/** Merge plugin config, call arguments, and defaults into one policy. */
function policyOf(config, args) {
	const merged = Object.assign({}, DEFAULTS, config || {});
	const format = typeof args.format === 'string' && Object.hasOwn(FORMATS, args.format)
		? args.format
		: (typeof merged.format === 'string' && Object.hasOwn(FORMATS, merged.format) ? merged.format : 'markdown');
	return {
		format,
		includeToolResults: typeof args.include_tool_results === 'boolean' ? args.include_tool_results : merged.includeToolResults,
		includeToolCalls: typeof args.include_tool_calls === 'boolean' ? args.include_tool_calls : merged.includeToolCalls,
		includeReasoning: typeof args.include_reasoning === 'boolean' ? args.include_reasoning : merged.includeReasoning,
		includeNotices: typeof args.include_notices === 'boolean' ? args.include_notices : merged.includeNotices,
		sanitize: typeof args.sanitize === 'boolean' ? args.sanitize : merged.sanitize,
		pathStyle: merged.pathStyle,
		usernames: Array.isArray(merged.usernames) ? merged.usernames : [],
		literals: Array.isArray(merged.literals) ? merged.literals : [],
		fileName: typeof args.file_name === 'string' && args.file_name.length > 0 ? args.file_name : merged.fileName,
		overwrite: typeof args.overwrite === 'boolean' ? args.overwrite : merged.overwrite,
		ruleWidth: merged.ruleWidth,
		limits: {
			resultHeadLines: Number.isSafeInteger(args.result_head_lines) ? args.result_head_lines : merged.resultHeadLines,
			resultTailLines: Number.isSafeInteger(args.result_tail_lines) ? args.result_tail_lines : merged.resultTailLines,
			maxArgumentChars: merged.maxArgumentChars
		}
	};
}

/** Resolve the working directory the way other file tools do. */
async function resolveCwd(ctx, exec) {
	const workingDirectory = ctx.get('workingDirectory');
	if (workingDirectory !== undefined && workingDirectory !== null && exec && exec.agent) {
		try {
			const cwd = await workingDirectory.ensure(exec.agent, exec.signal);
			if (typeof cwd === 'string' && cwd.length > 0) return cwd;
		} catch {
			/* fall through to the home directory */
		}
	}
	return homedir();
}

/** Read one session log through a persistence read handle. */
async function readLog(ctx, sessionId, signal) {
	const persistence = ctx.get('sessionPersistence');
	if (persistence === undefined || persistence === null) throw new Error('session export needs the sessionPersistence service, which this deployment does not mount');
	const sessions = ctx.get('sessions');
	if (sessions !== undefined && sessions !== null) {
		const live = sessions.get(sessionId);
		if (live !== undefined) await sessions.flush(live);
	}
	const options = signal === undefined ? {} : { signal };
	const handle = await persistence.open(sessionId, 'read', options);
	try {
		const result = await handle.read(0, undefined, options);
		return { header: handle.header, events: result.events };
	} finally {
		await handle.close();
	}
}

/** Every session id present in the projection cache, newest file first. */
async function allSessionIds() {
	const dir = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
	let names;
	try {
		names = await readdir(dir);
	} catch (error) {
		throw new Error('cannot list sessions: ' + (error instanceof Error ? error.message : String(error)));
	}
	return names
		.filter((entry) => entry.startsWith('session-') && entry.endsWith('.json'))
		.map((entry) => entry.slice(0, entry.length - '.json'.length))
		.sort();
}

/** Fill a file-name template. */
export function fileNameFor(template, values) {
	const name = String(template)
		.replace(/\{id\}/gu, values.id)
		.replace(/\{short\}/gu, values.short)
		.replace(/\{date\}/gu, values.date)
		.replace(/\{time\}/gu, values.time)
		.replace(/\{format\}/gu, values.format)
		.replace(/\{ext\}/gu, values.ext);
	return extname(name).length > 0 ? name : name + '.' + values.ext;
}

/** Append -1, -2, ... until the path is free, unless overwriting is allowed. */
async function freePath(target, overwrite) {
	if (overwrite) return target;
	const ext = extname(target);
	const base = target.slice(0, target.length - ext.length);
	let candidate = target;
	for (let index = 1; index < 1000; index += 1) {
		try {
			await access(candidate, constants.F_OK);
		} catch {
			return candidate;
		}
		candidate = base + '-' + String(index) + ext;
	}
	return target;
}

/** Render one transcript in the requested format. */
function renderArtifact(transcript, policy, options) {
	if (policy.format === 'pdf') {
		// The PDF body is the text renderer's output, so both carry the same content.
		const plain = renderPlainText(transcript, options);
		const pdf = renderPdf(plain.text, { title: transcript.title });
		return {
			binary: pdf.buffer,
			bytes: pdf.buffer.length,
			pages: pdf.pages,
			stats: Object.assign({}, plain.stats, { bytes: pdf.buffer.length, fencesBalanced: true }),
			redactions: plain.redactions
		};
	}
	const renderer = RENDERERS[policy.format];
	const rendered = renderer(transcript, options);
	return { text: rendered.text, bytes: rendered.stats.bytes, stats: rendered.stats, redactions: rendered.redactions };
}

/** Export one session log and write it to disk. */
async function exportOne(ctx, config, args, exec, sessionId, policy, cwd) {
	const signal = exec ? exec.signal : undefined;
	const { header, events } = await readLog(ctx, sessionId, signal);
	const transcript = collectTranscript(header, events, policy);
	const options = Object.assign({}, policy, { homeDir: homedir(), exportedAt: new Date() });
	const artifact = renderArtifact(transcript, policy, options);

	const ext = FORMATS[policy.format];
	const short = typeof transcript.shortId === 'string' && transcript.shortId.length > 0 ? transcript.shortId : sessionId;
	const stamp = new Date();
	const name = fileNameFor(policy.fileName, {
		id: sessionId,
		short,
		date: stamp.toISOString().slice(0, 10),
		time: stamp.toISOString().slice(11, 19).replace(/:/gu, ''),
		format: policy.format,
		ext
	});
	let target;
	const requestedPath = typeof args.output_path === 'string' ? args.output_path.trim() : '';
	const requestedDir = typeof args.output_dir === 'string' ? args.output_dir.trim() : '';
	if (requestedPath.length > 0 && requestedDir.length === 0) {
		const absolute = isAbsolute(requestedPath) ? requestedPath : resolve(cwd, requestedPath);
		target = extname(absolute).length > 0 ? absolute : absolute + '.' + ext;
	} else {
		const dir = requestedDir.length > 0 ? (isAbsolute(requestedDir) ? requestedDir : resolve(cwd, requestedDir)) : cwd;
		target = join(dir, name);
	}
	target = await freePath(target, policy.overwrite);
	await mkdir(dirname(target), { recursive: true });
	if (artifact.binary !== undefined) await writeFile(target, artifact.binary);
	else await writeFile(target, artifact.text, 'utf8');

	const item = {
		session_id: sessionId,
		path: target,
		format: policy.format,
		bytes: artifact.bytes,
		records: artifact.stats.records,
		turns: artifact.stats.turns,
		tool_calls: artifact.stats.toolCalls,
		tool_results: artifact.stats.toolResults,
		fences_balanced: artifact.stats.fencesBalanced,
		redactions: artifact.redactions
	};
	if (artifact.pages !== undefined) item.pages = artifact.pages;
	return item;
}

/** Export one or many sessions, collecting per-session failures. */
async function exportSessions(ctx, config, args, exec) {
	const policy = policyOf(config, args);
	const cwd = await resolveCwd(ctx, exec);

	let ids = [];
	if (Array.isArray(args.sessions)) ids = args.sessions.filter((value) => typeof value === 'string' && value.length > 0);
	if (typeof args.session_id === 'string' && args.session_id.trim().length > 0) ids.unshift(args.session_id.trim());
	if (args.all === true) ids = ids.concat(await allSessionIds());
	ids = Array.from(new Set(ids));
	if (ids.length === 0) {
		const current = exec && exec.agent && exec.agent.session ? String(exec.agent.session.id) : '';
		if (current.length === 0) throw new Error('export needs a session_id when it is called outside a session');
		ids = [current];
	}

	const exports = [];
	const failed = [];
	for (const sessionId of ids) {
		try {
			exports.push(await exportOne(ctx, config, args, exec, sessionId, policy, cwd));
		} catch (error) {
			failed.push({ session_id: sessionId, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { exports, failed };
}

/** One-line-per-file summary of a completed export. */
function summarize(value) {
	const lines = [];
	for (const item of value.exports) {
		const redacted = item.redactions.length === 0
			? 'no redactions'
			: item.redactions.map((entry) => entry.kind + ' x' + String(entry.count)).join(', ');
		const pages = item.pages === undefined ? '' : ', ' + String(item.pages) + ' pages';
		lines.push(item.path + ' [' + item.format + '] ' + String(item.bytes) + ' bytes, ' + String(item.turns) + ' turns, '
			+ String(item.tool_calls) + ' tool calls, ' + String(item.tool_results) + ' results' + pages
			+ '; ' + redacted
			+ (item.fences_balanced ? '' : '; WARNING: unbalanced code fences'));
	}
	for (const failure of value.failed) lines.push('FAILED ' + failure.session_id + ': ' + failure.error);
	if (lines.length === 0) lines.push('Nothing exported.');
	return lines.join('\n');
}

/** Parse the /export-session argument string into tool arguments. */
export function parseCommandInput(raw) {
	const args = {};
	let path = '';
	for (const token of String(raw).split(/\s+/u)) {
		if (token.length === 0) continue;
		if (token === '--no-tools' || token === '--no-results') args.include_tool_results = false;
		else if (token === '--no-calls') args.include_tool_calls = false;
		else if (token === '--reasoning') args.include_reasoning = true;
		else if (token === '--no-notices') args.include_notices = false;
		else if (token === '--no-sanitize') args.sanitize = false;
		else if (token === '--overwrite' || token === '-f') args.overwrite = true;
		else if (token === '--all') args.all = true;
		else if (token === '--pdf') args.format = 'pdf';
		else if (token === '--txt' || token === '--text') args.format = 'text';
		else if (token === '--md' || token === '--markdown') args.format = 'markdown';
		else if (token === '--html') args.format = 'html';
		else if (token === '--jsonl') args.format = 'jsonl';
		else if (token.startsWith('--format=')) args.format = token.slice('--format='.length);
		else if (token.startsWith('--out=')) path = token.slice('--out='.length);
		else if (token.startsWith('--dir=')) args.output_dir = token.slice('--dir='.length);
		else if (!token.startsWith('-')) path = token;
	}
	if (path.length > 0) {
		if (args.all === true) args.output_dir = path;
		else args.output_path = path;
	}
	return args;
}

/**
 * Register the export tool and the /export-session command.
 * @param {object} ctx - host context carrying the tool and command registries.
 * @param {object} [config] - plugin configuration.
 */
export function apply(ctx, config = {}) {
	ctx.tools.register({
		name: 'export_session',
		description: 'Export a DSH session log as a transcript file with optional redaction of home paths, user names, e-mail addresses, and credentials. '
			+ 'Formats: markdown, text (plain), html, jsonl, pdf (the same plain text, typeset). Writes the file and returns its path.',
		parameters: PARAMETERS,
		output: {
			schema: OUTPUT,
			render: (_args, value) => [{ type: 'text', text: summarize(value) }]
		},
		async execute(args, exec) {
			return exportSessions(ctx, config, args || {}, exec);
		}
	});

	ctx.commands.register({
		definitionId: 'dsh-session-export',
		name: 'export-session',
		description: 'Export this session as a sanitized transcript (markdown by default; --pdf, --txt, --html, --jsonl)',
		input: { hint: '[path] [--pdf|--txt|--html|--jsonl] [--all] [--no-tools] [--reasoning] [--no-sanitize] [--overwrite]' },
		async handler(invocation) {
			const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : '';
			try {
				const value = await exportSessions(ctx, config, parseCommandInput(raw), {
					agent: invocation.agent,
					signal: invocation.signal
				});
				return {
					kind: value.exports.length > 0 ? 'success' : 'error',
					text: summarize(value)
				};
			} catch (error) {
				return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
			}
		}
	});
}
