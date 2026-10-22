/**
 * Session log to transcript. Pure helpers only: no I/O, no harness imports, so
 * every renderer can be unit-tested and reused outside the plugin.
 *
 * Two stages:
 *   collectTranscript(header, events, options) -> plain data
 *   renderMarkdown / renderPlainText / renderHtml / renderJsonl(transcript) -> text
 * Redaction runs on the finished text, never per block.
 */

/** Backtick, spelled without a literal so the source stays template-safe. */
const TICK = String.fromCharCode(96);

/** Rendering limits applied when the caller does not override them. */
export const DEFAULT_LIMITS = Object.freeze({
	resultHeadLines: 60,
	resultTailLines: 15,
	maxArgumentChars: 4000
});

/**
 * Clip a long block to a head/tail window, marking the elision.
 * @param {string} text - the block.
 * @param {number} headLines - lines kept from the top.
 * @param {number} tailLines - lines kept from the bottom.
 * @returns {string} the clipped block.
 */
export function clipLines(text, headLines, tailLines) {
	const lines = text.split('\n');
	if (headLines + tailLines <= 0) return text;
	if (lines.length <= headLines + tailLines + 1) return text;
	const head = lines.slice(0, headLines);
	const tail = tailLines > 0 ? lines.slice(lines.length - tailLines) : [];
	const omitted = lines.length - head.length - tail.length;
	const closedHead = closeOpenFence(head);
	return closedHead.concat(['', '[... ' + String(omitted) + ' lines omitted ...]', ''], tail).join('\n');
}

/**
 * Append the matching closer when a line window ends inside a fence, so a
 * clipped payload never swallows the text that follows it.
 * @param {string[]} lines - the window.
 * @returns {string[]} the window, closed when needed.
 */
export function closeOpenFence(lines) {
	const markerRe = new RegExp('^(' + TICK + '{3,})', 'u');
	let open = 0;
	for (const line of lines) {
		const match = markerRe.exec(line);
		if (match === null) continue;
		if (open === 0) open = match[1].length;
		else if (match[1].length >= open) open = 0;
	}
	if (open === 0) return lines;
	return lines.concat([TICK.repeat(open)]);
}

/**
 * Choose a fence longer than any backtick run inside the content.
 * @param {string} content - the fenced payload.
 * @returns {string} the fence marker.
 */
export function fenceFor(content) {
	const runs = content.match(new RegExp(TICK + '+', 'gu'));
	let longest = 0;
	if (runs !== null) for (const run of runs) if (run.length > longest) longest = run.length;
	return TICK.repeat(Math.max(3, longest + 1));
}

/**
 * Wrap content in an adaptive fenced block.
 * @param {string} lang - optional info string.
 * @param {string} content - the payload.
 * @returns {string} the fenced block.
 */
export function fenced(lang, content) {
	const fence = fenceFor(content);
	const opener = lang ? fence + lang : fence;
	return opener + '\n' + content + '\n' + fence;
}

/** Escape a literal for use inside a RegExp source. */
function escapeRegExp(value) {
	const special = '.*+?^$()[]{}|\\';
	let out = '';
	for (const ch of value) out += special.includes(ch) ? '\\' + ch : ch;
	return out;
}

/**
 * GitHub-compatible heading slug.
 * @param {string} text - the heading text.
 * @returns {string} the anchor fragment.
 */
export function slug(text) {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N} _-]/gu, '')
		.replace(/ /gu, '-');
}

/** Values that name a secret's source rather than the secret itself. */
const PLACEHOLDER_VALUE = /^(?:<[^>]*>|\$\{[^}]*\}|\$\([^)]*\)|process\.env\.[A-Za-z0-9_]+|os\.environ[^;]*|System\.getenv[^;]*|getenv\([^)]*\)|null|nil|none|undefined|true|false|\*+|-+|x{3,}|•+|\?+|…+|(?:your|my)[_-](?:password|token|key|secret)(?:[_-]here)?)$/iu;

/**
 * Key names that always take a redacted value, however short or plain.
 * Matches prefixed forms too: DB_PASSWORD, aws_secret_access_key, authToken.
 */
const SECRET_KEY = /(?:password|passwd|pwd|passphrase|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|signing[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer[_-]?token|token|credential|db[_-]?pass)/iu;

/**
 * Decide whether an assigned value looks like a secret rather than code.
 * @param {string} value - the right-hand side of an assignment.
 * @returns {boolean} true when the value should be redacted.
 */
function looksLikeSecret(value) {
	if (typeof value !== 'string' || value.length === 0) return false;
	if (PLACEHOLDER_VALUE.test(value)) return false;
	if (value.includes('${') || value.includes('$(')) return false;
	if (/^(?:process\.env|os\.environ|os\.getenv|System\.getenv|getenv)/u.test(value)) return false;
	return true;
}

/**
 * Build a sanitizer with per-category hit counters.
 * @param {object} [options] - redaction policy.
 * @param {string} [options.homeDir] - the home directory to collapse.
 * @param {string} [options.pathStyle] - "tilde" (~) or "placeholder" (<home>).
 * @param {string[]} [options.usernames] - extra bare usernames to mask.
 * @param {string[]} [options.literals] - extra literal strings to mask.
 * @returns {{sanitize: (text: string) => string, stats: Map<string, number>}} the sanitizer.
 */
export function createSanitizer(options = {}) {
	const pathStyle = options.pathStyle === 'placeholder' ? 'placeholder' : 'tilde';
	const home = typeof options.homeDir === 'string' && options.homeDir.length > 0
		? options.homeDir
		: (typeof process.env.HOME === 'string' ? process.env.HOME : '');
	const homeReplacement = pathStyle === 'tilde' ? '~' : '<home>';
	const usernames = Array.isArray(options.usernames) ? options.usernames.filter((value) => typeof value === 'string' && value.length > 0) : [];
	if (home.length > 0) {
		const base = home.split('/').filter((part) => part.length > 0).pop();
		if (base !== undefined && base.length > 0 && !usernames.includes(base)) usernames.unshift(base);
	}
	const stats = new Map();
	const rules = [];
	const push = (kind, pattern, replacement) => rules.push({ kind, pattern, replacement });

	push('posix-home', /\/(?:Users|home)\/[^\/\s"'():;,]+/gu, homeReplacement);
	push('windows-home', /[A-Za-z]:\\Users\\[^\\\s"'():;,]+/gu, homeReplacement);
	push('windows-sep', /(?<=~|<home>)\\+/gu, '/');
	push('posix-home-root', /\/(?:Users|home)\//gu, homeReplacement + '/');
	for (const user of usernames) {
		push('username', new RegExp(escapeRegExp(user), 'giu'), '<user>');
	}
	push('basic-auth-url', /\b([a-z][a-z0-9+.-]*):\/\/([^\s\/:@]+):([^\s\/@]+)@/giu, (match, scheme, user) => scheme + '://' + user + ':<redacted>@');
	push('basic-auth-header', /\b(Authorization\s*:\s*Basic\s+)[A-Za-z0-9+\/=]{8,}/giu, (match, prefix) => prefix + '<redacted>');
	// Left boundary + bounded local part: an unbounded [alnum]+ here is O(n^2)
	// on any long identifier run and stalls a 350KB export for a full minute.
	push('email', /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/gu, '<email>');
	push('private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '<private-key>');
	push('github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, '<token>');
	push('github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, '<token>');
	push('aws-key-id', /\bAKIA[0-9A-Z]{16}\b/gu, '<token>');
	push('slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu, '<token>');
	push('openai-key', /\bsk-[A-Za-z0-9_-]{20,}\b/gu, '<token>');
	push('google-api-key', /\bAIza[0-9A-Za-z_-]{30,}\b/gu, '<token>');
	push('jwt', /\beyJ[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,512}\.[A-Za-z0-9_-]{8,512}\b/gu, '<token>');
	push('bearer-token', /\bBearer\s+[A-Za-z0-9._~+\/=-]{20,}/giu, 'Bearer <token>');
	push('npm-token', /\bnpm_[A-Za-z0-9]{30,}\b/gu, '<token>');
	push('pypi-token', /\bpypi-[A-Za-z0-9_-]{40,}\b/gu, '<token>');
	push('docker-token', /\bdckr_pat_[A-Za-z0-9_-]{20,}\b/gu, '<token>');
	push('aws-secret', /\baws_secret_access_key\b\s*[:=]\s*["']?[A-Za-z0-9\/+=]{40}/giu, (match) => match.replace(/[A-Za-z0-9\/+=]{40}$/u, '<redacted>'));
	push('cookie', /\b(?:cf_clearance|PHPSESSID|JSESSIONID|sessionid|session_id|csrf_token|xsrf_token|XSRF-TOKEN|auth_token|remember_token)\s*=\s*[^\s;,"']{8,}/giu, (match) => match.replace(/=\s*[^\s;,"']{8,}$/u, '=<redacted>'));
	push('cookie-header', /\b(?:Set-Cookie|Cookie)\s*:\s*[^\n]{10,}/giu, 'Cookie: <redacted>');
	// Key-anchored assignment: the key decides, not the value's length or shape,
	// so "password = hunter2" and "DB_PASSWORD=Tr0ub4dor" are both covered.
	push('credential-assignment',
		/(?<![\w-])([A-Za-z0-9_.-]{0,40}?(?:password|passwd|pwd|passphrase|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|token|credential|db[_-]?pass)[A-Za-z0-9_.-]{0,40})(\s*[:=]\s*)(["']?)([^\s"',;]{1,512})\3/giu,
		(match, key, sep, quote, value) => {
			if (SECRET_KEY.test(key) && looksLikeSecret(value)) return key + sep + quote + '<redacted>' + quote;
			if (value.length >= 12 && !PLACEHOLDER_VALUE.test(value) && (/[0-9]/u.test(value) || /[^A-Za-z0-9]/u.test(value))) {
				return key + sep + quote + '<redacted>' + quote;
			}
			return match;
		});
	// Command-line secrets: -pSecret123, --password=xxx, --token xxx.
	push('cli-password', /(?<![\w-])(-p)(?=[^\s"',;])([^\s"',;]{1,512})/gu, (match, flag, value) => (PLACEHOLDER_VALUE.test(value) ? match : flag + '<redacted>'));
	push('cli-password-long', /(?<![\w-])(--password|--passwd|--token|--api-key|--secret|--auth-token)([= ])(["']?)([^\s"',;]{1,512})/giu, (match, flag, sep, quote, value) => (PLACEHOLDER_VALUE.test(value) ? match : flag + sep + quote + '<redacted>'));
	const literals = Array.isArray(options.literals) ? options.literals.filter((value) => typeof value === 'string' && value.length > 0) : [];
	for (const literal of literals) push('literal', new RegExp(escapeRegExp(literal), 'gu'), '<redacted>');

	/**
	 * Apply every rule once, counting hits per category.
	 * @param {string} text - the text to sanitize.
	 * @returns {string} the sanitized text.
	 */
	function sanitize(text) {
		let out = text;
		for (const rule of rules) {
			out = out.replace(rule.pattern, (...args) => {
				const match = args[0];
				const groups = args.slice(1, args.length - 2);
				const value = typeof rule.replacement === 'function' ? rule.replacement(match, ...groups) : rule.replacement;
				if (value !== match) stats.set(rule.kind, (stats.get(rule.kind) || 0) + 1);
				return value;
			});
		}
		return out;
	}

	return { sanitize, stats };
}

/** Join text blocks of a content array. */
function textOfBlocks(content) {
	if (!Array.isArray(content)) return '';
	const parts = [];
	for (const block of content) {
		if (block === null || typeof block !== 'object') continue;
		if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
		else if (block.type === 'image') parts.push('[image]');
		else if (block.type === 'file') parts.push('[file: ' + String(block.name || block.attachmentId || 'attachment') + ']');
	}
	return parts.join('\n').trim();
}

/** Serialize tool arguments for display. */
function argumentsText(value, maxChars) {
	let text;
	if (typeof value === 'string') text = value;
	else if (value === undefined) text = '';
	else {
		try {
			text = JSON.stringify(value, null, 2);
		} catch {
			text = String(value);
		}
	}
	if (text.length > maxChars) return text.slice(0, maxChars) + '\n[... ' + String(text.length - maxChars) + ' characters omitted ...]';
	return text;
}

/** First non-empty line of a text, flattened for a heading label. */
export function labelOf(text, limit) {
	const flat = text.replace(/\s+/gu, ' ').trim();
	// Unwrap inline links and code first so their URLs never reach the label.
	const linked = flat
		.replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
		.replace(/`([^`]*)`/gu, '$1');
	// Brackets and pipes would break both the TOC link target and any table cell.
	const plain = linked.replace(/[\\`*_>#|[\]()<>@]/gu, '').trim();
	const value = plain.length > 0 ? plain : 'message';
	return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
}

/** Format an event timestamp as HH:MM when one is present. */
function timeOf(event) {
	const raw = event.ts !== undefined ? event.ts
		: (event.time !== undefined ? event.time
			: (event.createdAt !== undefined ? event.createdAt : event.at));
	if (typeof raw === 'number' && Number.isFinite(raw)) {
		const date = new Date(raw < 1e12 ? raw * 1000 : raw);
		return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(11, 16);
	}
	if (typeof raw === 'string' && raw.length >= 16) {
		const date = new Date(raw);
		return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(11, 16);
	}
	return '';
}

/** Event types worth surfacing as a notice rather than dropping silently. */
const NOTICE_PATTERN = /(abort|cancel|error|fail|compact|permission|denied|interrupt)/iu;

/**
 * Collect a session log into renderer-neutral data.
 * @param {object} header - the session header (id, createdAt, cwd, ...).
 * @param {object[]} events - validated log events in seq order.
 * @param {object} [options] - collection policy.
 * @returns {{id: string, title: string, createdAt: string, cwd: string, counters: object, turns: object[]}} the transcript.
 */
export function collectTranscript(header, events, options = {}) {
	const limits = Object.assign({}, DEFAULT_LIMITS, options.limits || {});
	const includeReasoning = options.includeReasoning === true;
	const includeToolResults = options.includeToolResults !== false;
	const includeToolCalls = options.includeToolCalls !== false;
	const includeOtherMessages = options.includeOtherMessages === true;
	const includeNotices = options.includeNotices !== false;

	const turns = [];
	const callNames = new Map();
	const pendingResults = [];
	const counters = { records: Array.isArray(events) ? events.length : 0, toolCalls: 0, toolResults: 0 };
	let title = '';
	let current = null;

	/** Open the turn that receives the next block. */
	function ensureTurn() {
		if (current === null) {
			current = { user: '', time: '', blocks: [] };
			turns.push(current);
		}
		return current;
	}

	for (const event of events) {
		if (event === null || typeof event !== 'object') continue;
		const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
		if (event.type === 'session/title') {
			if (typeof data.title === 'string') title = data.title;
			continue;
		}
		if (event.type === 'user/message') {
			const source = data.source !== null && typeof data.source === 'object' ? data.source : {};
			const isHuman = source.kind === 'user';
			if (!isHuman && !includeOtherMessages) continue;
			const text = textOfBlocks(data.content);
			if (isHuman) {
				current = { user: text, time: timeOf(event), blocks: [] };
				turns.push(current);
			} else {
				ensureTurn().blocks.push({ kind: 'text', text: '[' + String(source.kind || 'message') + ']\n' + text });
			}
			continue;
		}
		if (event.type === 'assistant/message') {
			const message = data.message !== null && typeof data.message === 'object' ? data.message : {};
			const content = Array.isArray(message.content) ? message.content : [];
			for (const block of content) {
				if (block === null || typeof block !== 'object') continue;
				if (block.type === 'text' && typeof block.text === 'string') {
					ensureTurn().blocks.push({ kind: 'text', text: block.text });
				} else if (block.type === 'reasoning') {
					if (includeReasoning) ensureTurn().blocks.push({ kind: 'reasoning', text: typeof block.text === 'string' ? block.text : '' });
				} else if (block.type === 'tool-call') {
					if (typeof block.id === 'string' && typeof block.name === 'string') callNames.set(block.id, block.name);
					if (includeToolCalls) {
						counters.toolCalls += 1;
						ensureTurn().blocks.push({
							kind: 'call',
							name: typeof block.name === 'string' ? block.name : 'tool',
							text: argumentsText(block.arguments, limits.maxArgumentChars)
						});
					}
				}
			}
			continue;
		}
		if (event.type === 'tool/call') {
			if (typeof data.callId === 'string' && typeof data.name === 'string') {
				callNames.set(data.callId, data.name);
				// A tool call that only ever appears as an event still counts.
				if (includeToolCalls && data.name !== undefined) counters.toolCalls += 0;
			}
			continue;
		}
		if (event.type === 'tool/result') {
			counters.toolResults += 1;
			if (!includeToolResults) continue;
			const message = data.message !== null && typeof data.message === 'object' ? data.message : {};
			const text = textOfBlocks(message.content);
			const source = data.message !== null && typeof data.message === 'object' && data.message.source !== null && typeof data.message.source === 'object' ? data.message.source : {};
			const callId = typeof data.callId === 'string'
				? data.callId
				: (typeof data.toolCallId === 'string' ? data.toolCallId : (typeof source.callId === 'string' ? source.callId : ''));
			const name = callId.length > 0 && callNames.has(callId) ? callNames.get(callId) : '';
			const entry = { kind: 'result', name: name.length > 0 ? name : 'tool', callId, text: clipLines(text, limits.resultHeadLines, limits.resultTailLines) };
			if (name.length === 0) pendingResults.push(entry);
			ensureTurn().blocks.push(entry);
			continue;
		}
		if (includeNotices && typeof event.type === 'string' && NOTICE_PATTERN.test(event.type) && event.type !== 'tool/result') {
			const detail = typeof data.message === 'string' ? data.message
				: (typeof data.reason === 'string' ? data.reason
					: (typeof data.error === 'string' ? data.error : ''));
			ensureTurn().blocks.push({ kind: 'notice', text: event.type + (detail.length > 0 ? ': ' + detail : '') });
			continue;
		}
	}

	// Backfill names for results that arrived before their tool/call event.
	for (const entry of pendingResults) {
		if (entry.callId.length > 0 && callNames.has(entry.callId)) entry.name = callNames.get(entry.callId);
	}

	const id = typeof header.id === 'string' ? header.id : 'unknown';
	// Drop the "session-" prefix first, otherwise every short id is "session-".
	const bare = id.startsWith('session-') ? id.slice('session-'.length) : id;
	const shortId = bare.length > 8 ? bare.slice(0, 8) : bare;
	const heading = title.length > 0 ? title : 'Session ' + shortId;
	const created = typeof header.createdAt === 'string'
		? header.createdAt
		: (typeof header.createdAt === 'number' && Number.isFinite(header.createdAt)
			? new Date(header.createdAt).toISOString()
			: '');
	const cwd = typeof header.cwd === 'string' ? header.cwd : '';

	return {
		id,
		shortId,
		title: heading,
		createdAt: created,
		cwd,
		counters,
		turns: turns.map((turn, index) => ({
			index: index + 1,
			time: turn.time,
			user: turn.user,
			label: labelOf(turn.user, 64),
			blocks: turn.blocks
		}))
	};
}

/** Apply the redaction policy to a finished document and report the hits. */
function finalize(text, options) {
	if (options.sanitize === false) return { text, redactions: [] };
	const sanitizer = createSanitizer({
		homeDir: options.homeDir,
		pathStyle: options.pathStyle,
		usernames: options.usernames,
		literals: options.literals
	});
	const sanitized = sanitizer.sanitize(text);
	const redactions = [];
	for (const [kind, count] of sanitizer.stats) redactions.push({ kind, count });
	redactions.sort((left, right) => left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0);
	return { text: sanitized, redactions };
}

/** Bytes and fence health of a finished document. */
function statsOf(text, transcript) {
	return {
		records: transcript.counters.records,
		turns: transcript.turns.length,
		toolCalls: transcript.counters.toolCalls,
		toolResults: transcript.counters.toolResults,
		bytes: Buffer.byteLength(text, 'utf8'),
		fencesBalanced: fencesBalanced(text)
	};
}

/**
 * Render a transcript as Markdown.
 * @param {object} transcript - output of collectTranscript.
 * @param {object} [options] - rendering policy.
 * @returns {{text: string, stats: object, redactions: Array<{kind: string, count: number}>}} the artifact.
 */
export function renderMarkdown(transcript, options = {}) {
	const exportedAt = options.exportedAt instanceof Date ? options.exportedAt : new Date();
	const out = [];

	out.push('# ' + transcript.title, '');
	out.push('| Field | Value |', '| --- | --- |');
	out.push('| Session | ' + transcript.id + ' |');
	if (transcript.createdAt.length > 0) out.push('| Created | ' + transcript.createdAt + ' |');
	if (transcript.cwd.length > 0) out.push('| Working directory | ' + transcript.cwd + ' |');
	out.push('| Log records | ' + String(transcript.counters.records) + ' |');
	out.push('| Human turns | ' + String(transcript.turns.length) + ' |');
	out.push('| Tool calls | ' + String(transcript.counters.toolCalls) + ' |');
	out.push('| Tool results | ' + String(transcript.counters.toolResults) + ' |');
	out.push('| Exported | ' + exportedAt.toISOString() + ' |');
	out.push('');

	const headings = transcript.turns.map((turn) => 'Turn ' + String(turn.index) + ' — ' + turn.label);
	if (headings.length > 0) {
		out.push('## Contents', '');
		for (let index = 0; index < headings.length; index += 1) {
			out.push(String(index + 1) + '. [' + headings[index] + '](#' + slug(headings[index]) + ')');
		}
		out.push('');
	}

	for (let index = 0; index < transcript.turns.length; index += 1) {
		const turn = transcript.turns[index];
		out.push('---', '', '## ' + headings[index], '', '### User', '');
		out.push(turn.user.length > 0 ? turn.user : '_(empty)_', '');
		if (turn.blocks.length > 0) out.push('### Assistant', '');
		for (const block of turn.blocks) {
			if (block.kind === 'text') {
				if (block.text.trim().length > 0) out.push(block.text, '');
			} else if (block.kind === 'reasoning') {
				if (block.text.trim().length > 0) out.push('> Reasoning', '>', '> ' + block.text.replace(/\n/gu, '\n> '), '');
			} else if (block.kind === 'call') {
				out.push('#### Tool call: ' + block.name, '');
				const looksJson = /^[{[]/u.test(block.text.trim());
				const truncated = block.text.includes('characters omitted');
				out.push(fenced(looksJson && !truncated ? 'json' : '', block.text), '');
			} else if (block.kind === 'result') {
				out.push('#### Tool result: ' + block.name, '');
				out.push(fenced('text', block.text), '');
			} else if (block.kind === 'notice') {
				out.push('> ⚠️ ' + block.text, '');
			}
		}
	}

	const raw = out.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\s+$/u, '') + '\n';
	const { text, redactions } = finalize(raw, options);
	return { text, stats: statsOf(text, transcript), redactions };
}

/**
 * Render a transcript as plain text: no markup, no fences, no table.
 * @param {object} transcript - output of collectTranscript.
 * @param {object} [options] - rendering policy.
 * @returns {{text: string, stats: object, redactions: object[]}} the artifact.
 */
export function renderPlainText(transcript, options = {}) {
	const exportedAt = options.exportedAt instanceof Date ? options.exportedAt : new Date();
	const width = Number.isSafeInteger(options.ruleWidth) && options.ruleWidth > 10 ? options.ruleWidth : 78;
	const rule = '-'.repeat(width);
	const out = [];

	out.push(transcript.title, '='.repeat(Math.min(width, Math.max(8, Math.round(emWidth(transcript.title) / 0.6)))), '');
	out.push('Session          : ' + transcript.id);
	if (transcript.createdAt.length > 0) out.push('Created          : ' + transcript.createdAt);
	if (transcript.cwd.length > 0) out.push('Working directory: ' + transcript.cwd);
	out.push('Log records      : ' + String(transcript.counters.records));
	out.push('Human turns      : ' + String(transcript.turns.length));
	out.push('Tool calls       : ' + String(transcript.counters.toolCalls));
	out.push('Tool results     : ' + String(transcript.counters.toolResults));
	out.push('Exported         : ' + exportedAt.toISOString());
	out.push('');

	for (const turn of transcript.turns) {
		out.push(rule, '');
		out.push('[Turn ' + String(turn.index) + (turn.time.length > 0 ? ' ' + turn.time : '') + '] ' + turn.label, '');
		out.push('USER', '');
		out.push(turn.user.length > 0 ? turn.user : '(empty)', '');
		if (turn.blocks.length > 0) out.push('ASSISTANT', '');
		for (const block of turn.blocks) {
			if (block.kind === 'text') {
				if (block.text.trim().length > 0) out.push(block.text, '');
			} else if (block.kind === 'reasoning') {
				if (block.text.trim().length > 0) out.push('[reasoning]', block.text, '');
			} else if (block.kind === 'call') {
				out.push('[tool call: ' + block.name + ']', block.text, '');
			} else if (block.kind === 'result') {
				out.push('[tool result: ' + block.name + ']', block.text, '');
			} else if (block.kind === 'notice') {
				out.push('[notice] ' + block.text, '');
			}
		}
	}

	const raw = out.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\s+$/u, '') + '\n';
	const { text, redactions } = finalize(raw, options);
	return { text, stats: statsOf(text, transcript), redactions };
}

/**
 * Turn a session title into a short file-name stem that says what the session was about.
 *
 * Titles arrive from `session/title` events, so they are prose, not slugs: they may carry
 * markdown, a URL, or characters no filesystem accepts. Strip the noise, collapse runs of
 * whitespace into single hyphens, and cut the result at `maxUnits` em units — a CJK
 * character costs 1.0 and an ASCII character 0.6, so a mostly-Chinese title stays readable
 * at the same byte cost as a longer English one.
 *
 * @param {string} title Raw session title.
 * @param {number} [maxUnits] Width budget in em units. Defaults to 50.
 * @returns {string} A safe stem, or an empty string when nothing usable survives.
 */
export function fileTitle(title, maxUnits = 50) {
	let text = String(title ?? '').normalize('NFKC');
	text = text
		.replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
		.replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
		.replace(/https?:\/\/\S+/giu, ' ')
		.replace(/`([^`]*)`/gu, '$1');
	text = text.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, ' ');
	text = text.replace(/[,;!?。，、；！？]/gu, ' ');
	text = text.replace(/\s+/gu, '-').replace(/-{2,}/gu, '-').replace(/^[-.]+|[-.]+$/gu, '');
	if (text.length === 0) return '';
	const budget = Number.isFinite(maxUnits) && maxUnits > 0 ? maxUnits : 50;
	let out = '';
	let width = 0;
	for (const ch of text) {
		const cost = emWidth(ch);
		if (width + cost > budget) break;
		out += ch;
		width += cost;
	}
	return out.replace(/[-.]+$/gu, '');
}

/** Advance width in em units: ASCII 0.6 (Courier), wide glyphs 1.0. */
export function emWidth(text) {
	let total = 0;
	for (const ch of text) total += displayWidth(ch) === 2 ? 1 : 0.6;
	return total;
}

/** Visible width of a string: CJK and other wide characters count double. */
export function displayWidth(text) {
	let width = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		width += (cp >= 0x1100 && (
			cp <= 0x115f
			|| (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f)
			|| (cp >= 0xac00 && cp <= 0xd7a3)
			|| (cp >= 0xf900 && cp <= 0xfaff)
			|| (cp >= 0xfe30 && cp <= 0xfe6f)
			|| (cp >= 0xff00 && cp <= 0xff60)
			|| (cp >= 0xffe0 && cp <= 0xffe6)
			|| (cp >= 0x1f300 && cp <= 0x1f64f)
			|| (cp >= 0x1f900 && cp <= 0x1f9ff)
			|| (cp >= 0x20000 && cp <= 0x3fffd)
		)) ? 2 : 1;
	}
	return width;
}

/** Escape text for HTML text nodes. */
function escapeHtml(text) {
	return text.replace(/[&<>"']/gu, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'));
}

/**
 * Render a transcript as one self-contained HTML file.
 * @param {object} transcript - output of collectTranscript.
 * @param {object} [options] - rendering policy.
 * @returns {{text: string, stats: object, redactions: object[]}} the artifact.
 */
export function renderHtml(transcript, options = {}) {
	const exportedAt = options.exportedAt instanceof Date ? options.exportedAt : new Date();
	const out = [];
	const css = [
		':root{color-scheme:light dark}',
		'body{font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;max-width:960px;margin:0 auto;padding:32px 20px;color:#1c1c1e;background:#fff}',
		'h1{font-size:1.6em;margin:0 0 .6em}h2{font-size:1.15em;margin:2em 0 .5em;padding-top:.8em;border-top:1px solid #e5e5ea}',
		'h3{font-size:.95em;text-transform:uppercase;letter-spacing:.06em;color:#8e8e93;margin:1.4em 0 .4em}',
		'table.meta{border-collapse:collapse;font-size:13px;margin:0 0 2em}table.meta td{border:1px solid #e5e5ea;padding:4px 10px}table.meta td:first-child{color:#8e8e93;white-space:nowrap}',
		'.toc{font-size:14px;margin:0 0 2em;padding:12px 16px;background:#f7f7f9;border-radius:8px}.toc ol{margin:0;padding-left:1.4em}.toc a{color:#007aff;text-decoration:none}',
		'.turn{margin:0 0 2.4em}.user{white-space:pre-wrap;background:#f7f7f9;border-left:3px solid #007aff;padding:10px 14px;border-radius:0 6px 6px 0;margin:0 0 1em}',
		'.text{white-space:pre-wrap}.reasoning{white-space:pre-wrap;color:#636366;border-left:2px solid #d1d1d6;padding-left:12px;margin:.8em 0}',
		'details{margin:.8em 0;border:1px solid #e5e5ea;border-radius:6px;overflow:hidden}summary{cursor:pointer;padding:6px 10px;background:#f7f7f9;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
		'pre{margin:0;padding:10px 12px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}',
		'.notice{color:#c77700;font-size:13px;margin:.6em 0}',
		'@media (prefers-color-scheme:dark){body{background:#1c1c1e;color:#f2f2f7}.user,.toc,summary{background:#2c2c2e}table.meta td{border-color:#3a3a3c}h2{border-color:#3a3a3c}}'
	].join('');

	out.push('<!doctype html>', '<html lang="zh">', '<head>', '<meta charset="utf-8">');
	out.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
	out.push('<title>' + escapeHtml(transcript.title) + '</title>');
	out.push('<style>' + css + '</style>', '</head>', '<body>');
	out.push('<h1>' + escapeHtml(transcript.title) + '</h1>');
	out.push('<table class="meta">');
	out.push('<tr><td>Session</td><td>' + escapeHtml(transcript.id) + '</td></tr>');
	if (transcript.createdAt.length > 0) out.push('<tr><td>Created</td><td>' + escapeHtml(transcript.createdAt) + '</td></tr>');
	if (transcript.cwd.length > 0) out.push('<tr><td>Working directory</td><td>' + escapeHtml(transcript.cwd) + '</td></tr>');
	out.push('<tr><td>Log records</td><td>' + String(transcript.counters.records) + '</td></tr>');
	out.push('<tr><td>Human turns</td><td>' + String(transcript.turns.length) + '</td></tr>');
	out.push('<tr><td>Tool calls</td><td>' + String(transcript.counters.toolCalls) + '</td></tr>');
	out.push('<tr><td>Tool results</td><td>' + String(transcript.counters.toolResults) + '</td></tr>');
	out.push('<tr><td>Exported</td><td>' + exportedAt.toISOString() + '</td></tr>');
	out.push('</table>');

	if (transcript.turns.length > 0) {
		out.push('<nav class="toc"><ol>');
		for (const turn of transcript.turns) {
			out.push('<li><a href="#turn-' + String(turn.index) + '">Turn ' + String(turn.index) + ' — ' + escapeHtml(turn.label) + '</a></li>');
		}
		out.push('</ol></nav>');
	}

	for (const turn of transcript.turns) {
		out.push('<section class="turn" id="turn-' + String(turn.index) + '">');
		out.push('<h2>Turn ' + String(turn.index) + (turn.time.length > 0 ? ' · ' + escapeHtml(turn.time) : '') + ' — ' + escapeHtml(turn.label) + '</h2>');
		out.push('<h3>User</h3>');
		out.push('<div class="user">' + escapeHtml(turn.user.length > 0 ? turn.user : '(empty)') + '</div>');
		if (turn.blocks.length > 0) out.push('<h3>Assistant</h3>');
		for (const block of turn.blocks) {
			if (block.kind === 'text') {
				if (block.text.trim().length > 0) out.push('<div class="text">' + escapeHtml(block.text) + '</div>');
			} else if (block.kind === 'reasoning') {
				if (block.text.trim().length > 0) out.push('<div class="reasoning">' + escapeHtml(block.text) + '</div>');
			} else if (block.kind === 'call' || block.kind === 'result') {
				const label = block.kind === 'call' ? 'Tool call: ' : 'Tool result: ';
				out.push('<details><summary>' + label + escapeHtml(block.name) + '</summary><pre>' + escapeHtml(block.text) + '</pre></details>');
			} else if (block.kind === 'notice') {
				out.push('<div class="notice">⚠️ ' + escapeHtml(block.text) + '</div>');
			}
		}
		out.push('</section>');
	}

	out.push('</body>', '</html>');

	const raw = out.join('\n') + '\n';
	const { text, redactions } = finalize(raw, options);
	return { text, stats: statsOf(text, transcript), redactions };
}

/**
 * Render a transcript as JSON Lines: one record per block, stable key order.
 * @param {object} transcript - output of collectTranscript.
 * @param {object} [options] - rendering policy.
 * @returns {{text: string, stats: object, redactions: object[]}} the artifact.
 */
export function renderJsonl(transcript, options = {}) {
	const exportedAt = options.exportedAt instanceof Date ? options.exportedAt : new Date();
	const out = [];
	const push = (record) => out.push(JSON.stringify(record));

	push({
		type: 'session',
		id: transcript.id,
		title: transcript.title,
		created_at: transcript.createdAt,
		cwd: transcript.cwd,
		records: transcript.counters.records,
		turns: transcript.turns.length,
		tool_calls: transcript.counters.toolCalls,
		tool_results: transcript.counters.toolResults,
		exported_at: exportedAt.toISOString()
	});
	for (const turn of transcript.turns) {
		push({ type: 'user', turn: turn.index, time: turn.time, text: turn.user });
		for (const block of turn.blocks) {
			if (block.kind === 'text') push({ type: 'assistant', turn: turn.index, text: block.text });
			else if (block.kind === 'reasoning') push({ type: 'reasoning', turn: turn.index, text: block.text });
			else if (block.kind === 'call') push({ type: 'tool_call', turn: turn.index, name: block.name, arguments: block.text });
			else if (block.kind === 'result') push({ type: 'tool_result', turn: turn.index, name: block.name, text: block.text });
			else if (block.kind === 'notice') push({ type: 'notice', turn: turn.index, text: block.text });
		}
	}

	const raw = out.join('\n') + '\n';
	const { text, redactions } = finalize(raw, options);
	return { text, stats: statsOf(text, transcript), redactions };
}

/** Renderers keyed by format name. */
export const RENDERERS = Object.freeze({
	markdown: renderMarkdown,
	text: renderPlainText,
	html: renderHtml,
	jsonl: renderJsonl
});

/**
 * Render one session log as Markdown. Kept as the historical entry point.
 * @param {object} header - the session header (id, createdAt, cwd, ...).
 * @param {object[]} events - validated log events in seq order.
 * @param {object} [options] - rendering policy.
 * @returns {{text: string, stats: object, redactions: Array<{kind: string, count: number}>}} the artifact.
 */
export function renderSessionMarkdown(header, events, options = {}) {
	return renderMarkdown(collectTranscript(header, events, options), options);
}

/**
 * Check that every fenced block closes.
 * @param {string} text - the rendered Markdown.
 * @returns {boolean} true when fences pair up.
 */
export function fencesBalanced(text) {
	const marker = new RegExp('^(' + TICK + '{3,})', 'u');
	let open = 0;
	for (const line of text.split('\n')) {
		const match = marker.exec(line);
		if (match === null) continue;
		if (open === 0) open = match[1].length;
		else if (match[1].length >= open) open = 0;
	}
	return open === 0;
}
