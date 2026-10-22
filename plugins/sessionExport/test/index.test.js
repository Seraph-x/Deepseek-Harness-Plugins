import test from 'node:test';
import assert from 'node:assert/strict';

import { fileNameFor, parseCommandInput } from '../lib/index.js';

test('command parser defaults to no arguments', () => {
	assert.deepEqual(parseCommandInput(''), {});
	assert.deepEqual(parseCommandInput('   '), {});
});

test('command parser reads a bare output path', () => {
	assert.deepEqual(parseCommandInput('out/session.md'), { output_path: 'out/session.md' });
	assert.deepEqual(parseCommandInput('--out=out/session.md'), { output_path: 'out/session.md' });
});

test('command parser maps every format flag', () => {
	const table = [
		['--pdf', 'pdf'],
		['--txt', 'text'],
		['--text', 'text'],
		['--md', 'markdown'],
		['--markdown', 'markdown'],
		['--html', 'html'],
		['--jsonl', 'jsonl'],
		['--format=pdf', 'pdf'],
		['--format=text', 'text']
	];
	for (const [flag, format] of table) {
		assert.equal(parseCommandInput(flag).format, format, flag);
	}
});

test('command parser maps content switches', () => {
	assert.equal(parseCommandInput('--no-tools').include_tool_results, false);
	assert.equal(parseCommandInput('--no-results').include_tool_results, false);
	assert.equal(parseCommandInput('--no-calls').include_tool_calls, false);
	assert.equal(parseCommandInput('--reasoning').include_reasoning, true);
	assert.equal(parseCommandInput('--no-notices').include_notices, false);
	assert.equal(parseCommandInput('--no-sanitize').sanitize, false);
	assert.equal(parseCommandInput('--overwrite').overwrite, true);
	assert.equal(parseCommandInput('-f').overwrite, true);
});

test('command parser treats a path as a directory when exporting everything', () => {
	assert.deepEqual(parseCommandInput('--all dumps'), { all: true, output_dir: 'dumps' });
	assert.deepEqual(parseCommandInput('--dir=dumps --pdf'), { format: 'pdf', output_dir: 'dumps' });
});

test('command parser combines flags in one line', () => {
	const parsed = parseCommandInput('--pdf --no-tools --reasoning --out=dumps/s1.pdf');
	assert.equal(parsed.format, 'pdf');
	assert.equal(parsed.include_tool_results, false);
	assert.equal(parsed.include_reasoning, true);
	assert.equal(parsed.output_path, 'dumps/s1.pdf');
});

test('file name template expands every placeholder', () => {
	const values = { id: 'session-abcdef123456', short: 'abcdef12', date: '2026-01-02', time: '03-04', format: 'pdf', ext: 'pdf' };
	assert.equal(fileNameFor('session-{short}.{ext}', values), 'session-abcdef12.pdf');
	assert.equal(fileNameFor('{date}-{time}-{format}-{id}.{ext}', values), '2026-01-02-03-04-pdf-session-abcdef123456.pdf');
	assert.equal(fileNameFor('plain', values), 'plain.pdf');
	assert.equal(fileNameFor('keep.md', values), 'keep.md');
});

test('file name template expands the title token', () => {
	const values = { id: 'session-abc', short: 'abc12345', title: '安装-dsh-purge-插件', date: '2026-10-22', time: '093000', format: 'pdf', ext: 'pdf' };
	assert.equal(fileNameFor('{title}.{ext}', values), '安装-dsh-purge-插件.pdf');
	assert.equal(fileNameFor('{title}-{short}.{ext}', values), '安装-dsh-purge-插件-abc12345.pdf');
	assert.equal(fileNameFor('{date}-{title}.{ext}', values), '2026-10-22-安装-dsh-purge-插件.pdf');
});

test('command parser reads a name template', () => {
	assert.deepEqual(parseCommandInput('--name={title}-{short}.{ext} --pdf'), { file_name: '{title}-{short}.{ext}', format: 'pdf' });
});

test('the bare preset means a PDF of the conversation alone', () => {
	const expected = { format: 'pdf', include_tool_results: false, include_tool_calls: false, include_notices: false, sanitize: false };
	assert.deepEqual(parseCommandInput('--bare'), expected);
	assert.deepEqual(parseCommandInput('--raw'), expected);
	assert.deepEqual(parseCommandInput('-p -q -r'), expected);
	assert.deepEqual(parseCommandInput('-pqr'), expected);
});

test('short flags work on their own and combine', () => {
	assert.deepEqual(parseCommandInput('-p'), { format: 'pdf' });
	assert.deepEqual(parseCommandInput('-t'), { format: 'text' });
	assert.deepEqual(parseCommandInput('-q'), { include_tool_results: false, include_tool_calls: false, include_notices: false });
	assert.deepEqual(parseCommandInput('-r'), { sanitize: false });
	assert.deepEqual(parseCommandInput('-a'), { all: true });
	assert.deepEqual(parseCommandInput('-f'), { overwrite: true });
	assert.deepEqual(parseCommandInput('--chat'), { include_tool_results: false, include_tool_calls: false, include_notices: false });
	assert.deepEqual(parseCommandInput('-o=/tmp/x.pdf'), { output_path: '/tmp/x.pdf' });
});

test('a later format flag overrides the preset', () => {
	assert.equal(parseCommandInput('--bare --md').format, 'markdown');
	assert.equal(parseCommandInput('-pqr -t').format, 'text');
});

test('long options are not split into short flags', () => {
	assert.deepEqual(parseCommandInput('--pdf'), { format: 'pdf' });
	assert.deepEqual(parseCommandInput('--html'), { format: 'html' });
	assert.deepEqual(parseCommandInput('--jsonl'), { format: 'jsonl' });
});
