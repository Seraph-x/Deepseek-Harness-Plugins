import test from 'node:test';
import assert from 'node:assert/strict';

import {
	collectTranscript,
	createSanitizer,
	emWidth,
	fileTitle,
	fencesBalanced,
	labelOf,
	renderHtml,
	renderJsonl,
	renderMarkdown,
	renderPlainText,
	renderSessionMarkdown,
	slug
} from '../lib/render.js';

/** A tiny two-turn session used by most assertions. */
function sampleEvents() {
	return [
		{ type: 'session/title', data: { title: 'Sample session' } },
		{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '看看 [这个](http://x) 和 a|b' }] } },
		{
			type: 'assistant/message',
			data: {
				message: {
					content: [
						{ type: 'text', text: '好的，这是回复。' },
						{ type: 'tool-call', id: 'c1', name: 'bash', arguments: { command: 'ls -la' } }
					]
				}
			}
		},
		{ type: 'tool/result', data: { callId: 'c1', message: { content: [{ type: 'text', text: 'total 0' }] } } },
		{ type: 'turn/aborted', data: { reason: 'user cancelled' } },
		{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } },
		{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '继续完成。' }] } } }
	];
}

test('sanitizer stays linear on a long identifier run', () => {
	const sanitizer = createSanitizer({ homeDir: '/Users/alice' });
	const started = Date.now();
	sanitizer.sanitize('x'.repeat(200_000));
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 500, 'redaction must stay linear, took ' + String(elapsed) + 'ms');
});

test('sanitizer redacts short and plain passwords', () => {
	const sanitizer = createSanitizer({ homeDir: '/Users/alice' });
	const cases = [
		'password = hunter2',
		'password = mypassword',
		'password = abc12345',
		'PASSWORD: "hunter2"',
		'token = xyz',
		'db_pass=short1',
		'export DB_PASSWORD=Tr0ub4dor',
		'mysql -u root -pSecret123',
		'Authorization: Basic YWxpY2U6aHVudGVyMg==',
		'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
	];
	for (const input of cases) {
		assert.match(sanitizer.sanitize(input), /<redacted>|<token>/, 'not redacted: ' + input);
	}
});

test('sanitizer leaves placeholders and code alone', () => {
	const sanitizer = createSanitizer({ homeDir: '/Users/alice' });
	const cases = [
		'password = process.env.DB_PASS',
		'token: ${TOKEN}',
		'api_key = null',
		'password = <your-password>'
	];
	for (const input of cases) {
		assert.doesNotMatch(sanitizer.sanitize(input), /<redacted>/, 'wrongly redacted: ' + input);
	}
});

test('sanitizer collapses home paths in both path styles', () => {
	const tilde = createSanitizer({ homeDir: '/Users/alice' });
	assert.equal(tilde.sanitize('/Users/alice/notes.txt'), '~/notes.txt');
	assert.equal(tilde.sanitize('C:\\Users\\bob\\secret.txt'), '~/secret.txt');
	const placeholder = createSanitizer({ homeDir: '/Users/alice', pathStyle: 'placeholder' });
	assert.equal(placeholder.sanitize('/Users/alice/notes.txt'), '<home>/notes.txt');
});

test('sanitizer keeps e-mail detection working', () => {
	const sanitizer = createSanitizer({ homeDir: '/Users/alice' });
	assert.equal(sanitizer.sanitize('write to bob@corp.com now'), 'write to <email> now');
	assert.equal(sanitizer.sanitize('first.last+tag@sub.example.co.uk'), '<email>');
	assert.equal(sanitizer.sanitize('a@b'), 'a@b');
	assert.equal(sanitizer.sanitize('no-at-here'), 'no-at-here');
});

test('labelOf strips markdown that would break the TOC link', () => {
	assert.equal(labelOf('看看 [这个](http://x) 和 a|b', 64), '看看 这个 和 ab');
	assert.equal(labelOf('see `code` here', 64), 'see code here');
	assert.equal(labelOf('', 64), 'message');
	assert.ok(labelOf('x'.repeat(200), 64).length <= 64);
});

test('markdown TOC entries stay well formed', () => {
	const rendered = renderSessionMarkdown({ id: 'session-abcdef123456', createdAt: '2026-01-01T00:00:00Z' }, sampleEvents(), { sanitize: false });
	const entry = rendered.text.split('\n').find((line) => line.startsWith('1. ['));
	assert.ok(entry !== undefined, 'no TOC entry');
	assert.equal(entry.indexOf('[', 4), -1, 'nested bracket in TOC entry: ' + entry);
	assert.equal((entry.match(/\(/gu) || []).length, 1, 'nested paren in TOC entry: ' + entry);
});

test('markdown marks unbalanced fences and reports the flag', () => {
	const rendered = renderSessionMarkdown({ id: 's1' }, sampleEvents(), { sanitize: false });
	assert.equal(rendered.stats.fencesBalanced, true);
	assert.equal(fencesBalanced('```\nopen'), false);
});

test('transcript records notices and turn timestamps', () => {
	const transcript = collectTranscript({ id: 's1' }, sampleEvents(), {});
	assert.equal(transcript.turns.length, 2);
	assert.equal(transcript.counters.toolCalls, 1);
	assert.equal(transcript.counters.toolResults, 1);
	const notice = transcript.turns[0].blocks.find((block) => block.kind === 'notice');
	assert.ok(notice !== undefined, 'abort notice dropped');
	assert.match(notice.text, /turn\/aborted/u);
});

test('tool result names are backfilled when the call arrives later', () => {
	const events = [
		{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } },
		{ type: 'tool/result', data: { callId: 'c9', message: { content: [{ type: 'text', text: 'out' }] } } },
		{ type: 'tool/call', data: { callId: 'c9', name: 'read_file' } }
	];
	const transcript = collectTranscript({ id: 's1' }, events, {});
	const result = transcript.turns[0].blocks.find((block) => block.kind === 'result');
	assert.equal(result.name, 'read_file');
});

test('plain text carries the same turns and drops markdown syntax', () => {
	const rendered = renderPlainText(collectTranscript({ id: 's1' }, sampleEvents(), {}), { sanitize: false });
	assert.match(rendered.text, /\[Turn 1\]/u);
	assert.match(rendered.text, /USER/u);
	assert.match(rendered.text, /ASSISTANT/u);
	assert.doesNotMatch(rendered.text, /^###/mu);
	assert.doesNotMatch(rendered.text, /\[.*\]\(#/u);
});

test('plain text title rule matches the title width', () => {
	const transcript = collectTranscript({ id: 's1', createdAt: '2026-01-01T00:00:00Z' }, [], {});
	const rendered = renderPlainText(transcript, { sanitize: false });
	const lines = rendered.text.split('\n');
	const rule = lines[1];
	assert.match(rule, /^=+$/u);
	assert.equal(rule.length, Math.round(emWidth(lines[0]) / 0.6));
});

test('html is self contained and escapes markup', () => {
	const rendered = renderHtml(collectTranscript({ id: 's1' }, sampleEvents(), {}), { sanitize: false });
	assert.match(rendered.text, /^<!doctype html>/u);
	assert.match(rendered.text, /<style>/u);
	assert.match(rendered.text, /&quot;command&quot;/u);
	assert.match(rendered.text, /\u597d\u7684/u);
	assert.doesNotMatch(rendered.text, /<script/iu);
});

test('jsonl emits one record per block', () => {
	const rendered = renderJsonl(collectTranscript({ id: 's1' }, sampleEvents(), {}), { sanitize: false });
	const lines = rendered.text.trim().split('\n');
	assert.ok(lines.length >= 5);
	for (const line of lines) {
		const record = JSON.parse(line);
		assert.equal(typeof record.type, 'string');
	}
	assert.equal(JSON.parse(lines[0]).type, 'session');
});

test('all formats honour the sanitize switch', () => {
	const events = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'mail bob@corp.com' }] } }];
	const transcript = collectTranscript({ id: 's1' }, events, {});
	for (const renderer of [renderMarkdown, renderPlainText, renderHtml, renderJsonl]) {
		const cleaned = renderer(transcript, { sanitize: true, homeDir: '/Users/alice' });
		assert.doesNotMatch(cleaned.text, /bob@corp\.com/u);
		assert.ok(cleaned.redactions.some((entry) => entry.kind === 'email'));
	}
});

test('short id drops the session prefix', () => {
	assert.equal(collectTranscript({ id: 'session-abcdef123456' }, [], {}).shortId, 'abcdef12');
	assert.equal(collectTranscript({ id: 'plain' }, [], {}).shortId, 'plain');
});

test('slug keeps CJK and drops punctuation', () => {
	assert.equal(slug('Turn 1 — 继续'), 'turn-1--继续');
});

test('file title turns prose into a short safe stem', () => {
	assert.equal(fileTitle('安装 dsh-purge 插件'), '安装-dsh-purge-插件');
	assert.equal(fileTitle('Morning greeting to AI assistant'), 'Morning-greeting-to-AI-assistant');
	assert.equal(fileTitle('看看 [这个](http://x) 和 a|b'), '看看-这个-和-a-b');
	assert.equal(fileTitle('安装这个插件https://github.com/YuJ'), '安装这个插件');
	assert.equal(fileTitle('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
});

test('file title is trimmed to a width budget and never ends on a separator', () => {
	const long = fileTitle('x'.repeat(200));
	assert.ok(emWidth(long) <= 50, 'ASCII budget is 50 em');
	assert.doesNotMatch(long, /-$/u);
	const cjk = fileTitle('中文标题'.repeat(40));
	assert.ok(emWidth(cjk) <= 50, 'CJK budget is 50 em');
	assert.ok(cjk.length > 0);
	assert.equal(fileTitle('', 50), '');
	assert.equal(fileTitle('   ', 50), '');
	assert.equal(fileTitle('///', 50), '');
});

test('file title drops trailing dots so Windows accepts the name', () => {
	assert.equal(fileTitle('done.'), 'done');
	assert.equal(fileTitle('v1.2.'), 'v1.2');
});
