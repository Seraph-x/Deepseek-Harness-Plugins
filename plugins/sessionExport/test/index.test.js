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
