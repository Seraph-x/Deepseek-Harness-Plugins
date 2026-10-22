import test from 'node:test';
import assert from 'node:assert/strict';

import { PDF_LAYOUT, renderPdf, unitsOf, wrapLine } from '../lib/render-pdf.js';

/** Read the offset stored in the last startxref entry. */
function startxrefOffset(buffer) {
	const text = buffer.toString('latin1');
	const at = text.lastIndexOf('startxref');
	assert.notEqual(at, -1, 'no startxref section');
	return Number(text.slice(at + 9).trim().split(/\s+/u)[0]);
}

test('pdf starts with the version header and ends with EOF', () => {
	const { buffer } = renderPdf('hello world');
	assert.equal(buffer.subarray(0, 8).toString('latin1'), '%PDF-1.4');
	assert.match(buffer.toString('latin1').trimEnd(), /%%EOF$/u);
});

test('pdf xref table sits at the advertised offset', () => {
	const { buffer } = renderPdf('hello world');
	const offset = startxrefOffset(buffer);
	assert.equal(buffer.subarray(offset, offset + 4).toString('latin1'), 'xref');
});

test('pdf page objects match the reported page count', () => {
	const { buffer, pages } = renderPdf(Array.from({ length: 400 }, (_, index) => 'line ' + String(index)).join('\n'));
	assert.ok(pages > 1, 'long input must paginate, got ' + String(pages));
	const objects = (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/gu) || []).length;
	assert.equal(objects, pages);
});

test('pdf keeps CJK text as UTF-16BE hex', () => {
	const { buffer } = renderPdf('你好世界');
	// U+4F60 U+597D -> 4F60 597D in UTF-16BE.
	assert.match(buffer.toString('latin1'), /4F60597D/u);
});

test('pdf keeps ASCII text as plain hex', () => {
	const { buffer } = renderPdf('abc');
	assert.match(buffer.toString('latin1'), /616263/u);
});

test('pdf routes non-ASCII punctuation to the CID font', () => {
	// Courier is single byte: an em dash sent through it would lose its high byte.
	const { buffer } = renderPdf('a\u2014b\u2026c\u300cd\u300de');
	const text = buffer.toString('latin1');
	assert.match(text, /2014/u, 'em dash must be UTF-16BE encoded');
	assert.match(text, /2026/u, 'ellipsis must be UTF-16BE encoded');
	assert.match(text, /300C/u, 'corner bracket must be UTF-16BE encoded');
});

test('pdf always emits at least one page', () => {
	const { buffer, pages } = renderPdf('');
	assert.equal(pages, 1);
	assert.ok(buffer.length > 400);
});

test('pdf embeds a usable page geometry', () => {
	const { buffer } = renderPdf('x');
	const text = buffer.toString('latin1');
	assert.match(text, /\/MediaBox \[0 0 595\.28 841\.89\]/u);
	assert.match(text, /\/BaseFont \/Courier/u);
	assert.match(text, /\/BaseFont \/STSong-Light/u);
});

test('unitsOf counts ASCII narrow and CJK wide', () => {
	// em units: Courier is 0.6 wide per glyph, CJK is 1.0.
	assert.ok(Math.abs(unitsOf('abc') - 1.8) < 1e-9);
	assert.equal(unitsOf('你好'), 2);
	assert.ok(Math.abs(unitsOf('a你') - 1.6) < 1e-9);
});

test('wrapLine never exceeds the column budget', () => {
	const wrapped = wrapLine('x'.repeat(200), 80);
	assert.ok(wrapped.length > 1);
	for (const line of wrapped) assert.ok(unitsOf(line) <= 80, 'overflow: ' + String(unitsOf(line)));
});

test('wrapLine breaks on spaces when one is available', () => {
	const wrapped = wrapLine('alpha beta gamma delta epsilon zeta eta theta', 20);
	assert.ok(wrapped.length > 1);
	for (const line of wrapped) assert.ok(unitsOf(line) <= 20);
	assert.ok(wrapped.every((line) => !line.startsWith(' ')), 'leading space kept');
});

test('wrapLine honours the page budget used by renderPdf', () => {
	// renderPdf derives the budget as usable width divided by the font size, in em units.
	const budget = (595.28 - PDF_LAYOUT.margin * 2) / PDF_LAYOUT.fontSize;
	const wrapped = wrapLine('y'.repeat(500), budget);
	assert.ok(wrapped.length > 1);
	for (const line of wrapped) assert.ok(unitsOf(line) <= budget, 'overflow: ' + String(unitsOf(line)));
});
