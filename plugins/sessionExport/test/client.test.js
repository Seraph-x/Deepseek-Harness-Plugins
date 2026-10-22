import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Load `lib/client.js` the way the browser does: the file registers a module
 * factory on `window.__ModuleLoader__` and never imports anything itself.
 * React is a stub because nothing here renders.
 */
function loadClient() {
	let spec;
	const fakeReact = {
		createElement: () => null,
		useState: (initial) => [initial, () => {}],
		useEffect: () => {},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
	};
	const fakeWindow = {
		__ModuleLoader__: {
			load(next) {
				spec = next;
			},
		},
		localStorage: { getItem: () => null },
	};
	const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
	new Function('window', 'navigator', source)(fakeWindow, { language: 'en-US' });
	assert.ok(spec !== undefined, 'client.js must register a module factory');
	assert.equal(spec.id, 'dsh-session-export');
	return spec.factory((id) => {
		if (id === 'react') return fakeReact;
		throw new Error('unexpected require: ' + id);
	});
}

const client = loadClient();
const { parseExports, fileAddress, splitPath, bytesText, makeT } = client._internals;

/** The address grammar from `@deepseek-ai/dsh-util-workspace-path`, re-stated. */
function parseAddress(address) {
	const prefix = 'dsh-resource://file/';
	if (!address.startsWith(prefix)) return null;
	const [scope, ...rest] = address.slice(prefix.length).split('/');
	if (scope !== 'session') return null;
	const [id, ...segments] = rest;
	return { sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') };
}

const LINE = '/Users/alice/Documents/report.pdf [pdf] 123456 bytes, 80 turns, 0 tool calls, 0 results, 113 pages; no redactions';

test('reads the path, format and size out of one host summary line', () => {
	const files = parseExports(LINE);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, '/Users/alice/Documents/report.pdf');
	assert.equal(files[0].name, 'report.pdf');
	assert.equal(files[0].dir, '/Users/alice/Documents');
	assert.equal(files[0].format, 'pdf');
	assert.equal(files[0].bytes, 123456);
	assert.match(files[0].detail, /113 pages/u);
});

test('keeps every file of a batch and drops the failure lines', () => {
	const text = [
		'/Users/alice/a.md [markdown] 10 bytes, 1 turns, 0 tool calls, 0 results; no redactions',
		'FAILED session-nope: missing session-nope',
		'/Users/alice/b.txt [text] 20 bytes, 2 turns, 0 tool calls, 0 results; no redactions',
	].join('\n');
	assert.deepEqual(parseExports(text).map((file) => file.path), ['/Users/alice/a.md', '/Users/alice/b.txt']);
});

test('ignores a relative path, which the file provider cannot address', () => {
	const text = 'out/a.md [markdown] 10 bytes, 1 turns, 0 tool calls, 0 results; no redactions';
	assert.equal(parseExports(text).length, 0);
});

test('keeps spaces inside the path', () => {
	const files = parseExports('/Users/alice/My Documents/q3 report.pdf [pdf] 1 bytes, 0 turns, 0 tool calls, 0 results; no redactions');
	assert.equal(files[0].path, '/Users/alice/My Documents/q3 report.pdf');
	assert.equal(files[0].name, 'q3 report.pdf');
	assert.equal(files[0].dir, '/Users/alice/My Documents');
});

test('keeps a Windows path and splits it on either separator', () => {
	const files = parseExports('C:\\Users\\bob\\a.pdf [pdf] 5 bytes, 0 turns, 0 tool calls, 0 results; no redactions');
	assert.equal(files.length, 1);
	assert.equal(files[0].path, 'C:\\Users\\bob\\a.pdf');
	assert.equal(files[0].name, 'a.pdf');
	assert.deepEqual(splitPath('C:\\Users\\bob\\a.pdf'), { dir: 'C:/Users/bob', name: 'a.pdf' });
});

test('ignores anything that is not an export line', () => {
	assert.deepEqual(parseExports(''), []);
	assert.deepEqual(parseExports('Nothing exported.'), []);
	assert.deepEqual(parseExports(undefined), []);
	assert.deepEqual(parseExports('hello [pdf] 1 bytes, 0 turns'), []);
});

test('builds a session file address and preserves the leading slash', () => {
	const address = fileAddress('session-abc', '/Users/alice/a.pdf');
	assert.equal(address, 'dsh-resource://file/session/session-abc//Users/alice/a.pdf');
	assert.deepEqual(parseAddress(address), { sessionId: 'session-abc', path: '/Users/alice/a.pdf' });
});

test('encodes each address segment and normalizes Windows separators', () => {
	const address = fileAddress('s', 'C:\\Users\\bob\\a b.pdf');
	assert.equal(address, 'dsh-resource://file/session/s/C%3A/Users/bob/a%20b.pdf');
	assert.deepEqual(parseAddress(address), { sessionId: 's', path: 'C:/Users/bob/a b.pdf' });
});

test('round-trips a path with characters that need encoding', () => {
	const original = '/Users/alice/导出 #1 (final).pdf';
	assert.deepEqual(parseAddress(fileAddress('sid', original)), { sessionId: 'sid', path: original });
});

test('formats byte counts', () => {
	assert.equal(bytesText(512), '512 B');
	assert.equal(bytesText(2048), '2.0 KB');
	assert.equal(bytesText(3 * 1024 * 1024), '3.0 MB');
	assert.equal(bytesText(Number.NaN), '');
});

test('falls back to English copy when no locale is bound', () => {
	const t = makeT(null);
	assert.equal(t('card.preview'), 'Preview');
	assert.equal(t('card.exported', { count: '3' }), 'Exported 3');
});

test('exposes the plugin contract the loader expects', () => {
	assert.equal(client.name, 'dsh-session-export');
	assert.deepEqual(client.inject, ['slots', 'locale']);
	assert.equal(typeof client.apply, 'function');
});
