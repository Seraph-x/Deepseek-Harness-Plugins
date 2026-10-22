/**
 * Plain text to PDF. Pure Node, no dependencies, no font embedding.
 *
 * The document body is exactly the text handed in — the PDF is a typeset view
 * of the same content the text renderer produces, nothing more. Layout adds
 * only a page footer with the page number.
 *
 * Fonts: Courier (a PDF standard-14 font, always available) for ASCII, and the
 * predefined Adobe-GB1 CID font STSong-Light for everything else. STSong-Light
 * is not embedded, so CJK glyphs come from the reader's system font — this is
 * the standard trade-off that keeps the file small and the plugin dependency
 * free. macOS Preview, Chrome, Firefox and Edge all substitute correctly.
 */

/** A4 in PostScript points. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

/** Layout defaults. */
export const PDF_LAYOUT = Object.freeze({
	fontSize: 9,
	lineHeight: 12.6,
	margin: 42,
	footerSize: 7.5,
	maxUnitsPerLine: 0
});

/**
 * True when Courier (a single-byte, WinAnsi standard-14 font) can draw the
 * code point. Everything else — CJK, em dashes, ellipses, curly quotes,
 * emoji — has to go through the CID font, otherwise the single-byte encoder
 * would silently truncate the code point to its low byte.
 */
function isAscii(codePoint) {
	return codePoint >= 0x20 && codePoint <= 0x7e;
}

/**
 * Advance width of one character in em units. Courier glyphs are 0.6 wide;
 * the CID font has no /W array, so its default width is a full em.
 */
function unitOf(ch) {
	return isAscii(ch.codePointAt(0)) ? 0.6 : 1;
}

/** Total advance width of a string in em units. */
export function unitsOf(text) {
	let total = 0;
	for (const ch of text) total += unitOf(ch);
	return total;
}

/**
 * Break one logical line into display lines that fit maxUnits.
 * @param {string} line - the logical line, without newline.
 * @param {number} maxUnits - available width in em units.
 * @returns {string[]} the display lines.
 */
export function wrapLine(line, maxUnits) {
	if (line.length === 0) return [''];
	const out = [];
	let current = '';
	let width = 0;
	for (const ch of line) {
		const unit = unitOf(ch);
		if (width + unit > maxUnits && current.length > 0) {
			// Prefer breaking after a space so ASCII prose stays readable.
			const spaceAt = current.lastIndexOf(' ');
			if (spaceAt > 0 && spaceAt > current.length * 0.5) {
				out.push(current.slice(0, spaceAt));
				current = current.slice(spaceAt + 1);
				width = unitsOf(current);
			} else {
				out.push(current);
				current = '';
				width = 0;
			}
		}
		current += ch;
		width += unit;
	}
	out.push(current);
	return out;
}

/** UTF-16BE hex string, the code space of UniGB-UCS2-H. */
function hexOf(text) {
	let out = '';
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		if (cp > 0xffff) {
			const offset = cp - 0x10000;
			out += (0xd800 + (offset >> 10)).toString(16).padStart(4, '0');
			out += (0xdc00 + (offset & 0x3ff)).toString(16).padStart(4, '0');
		} else {
			out += cp.toString(16).padStart(4, '0');
		}
	}
	return out.toUpperCase();
}

/** Hex string of the raw bytes, for the Courier run. */
function asciiHex(text) {
	let out = '';
	for (let index = 0; index < text.length; index += 1) {
		out += (text.charCodeAt(index) & 0xff).toString(16).padStart(2, '0');
	}
	return out.toUpperCase();
}

/** Split a display line into runs of ASCII and runs of everything else. */
function runsOf(line) {
	const runs = [];
	let current = '';
	let ascii = null;
	for (const ch of line) {
		const next = isAscii(ch.codePointAt(0));
		if (ascii === null) ascii = next;
		if (next !== ascii) {
			runs.push({ ascii, text: current });
			current = '';
			ascii = next;
		}
		current += ch;
	}
	if (current.length > 0) runs.push({ ascii: ascii === true, text: current });
	return runs;
}

/** Minimal PDF writer that tracks byte offsets for the xref table. */
class PdfWriter {
	constructor() {
		this.parts = [];
		this.size = 0;
		this.offsets = new Map();
	}

	/** Append raw bytes, tracking the running offset. */
	raw(text) {
		const buffer = Buffer.from(text, 'latin1');
		this.parts.push(buffer);
		this.size += buffer.length;
	}

	/** Append one indirect object. */
	object(id, body) {
		this.offsets.set(id, this.size);
		this.raw(String(id) + ' 0 obj\n' + body + '\nendobj\n');
	}

	/** Append a stream object with an exact /Length. */
	stream(id, dictionary, content) {
		const bytes = Buffer.from(content, 'latin1');
		this.offsets.set(id, this.size);
		this.raw(String(id) + ' 0 obj\n<< ' + dictionary + ' /Length ' + String(bytes.length) + ' >>\nstream\n');
		this.parts.push(bytes);
		this.size += bytes.length;
		this.raw('\nendstream\nendobj\n');
	}

	/** Serialize with the cross-reference table and trailer. */
	finish(rootId, maxId) {
		const xrefOffset = this.size;
		let xref = 'xref\n0 ' + String(maxId + 1) + '\n';
		xref += '0000000000 65535 f \n';
		for (let id = 1; id <= maxId; id += 1) {
			const offset = this.offsets.get(id);
			xref += String(offset === undefined ? 0 : offset).padStart(10, '0') + ' 00000 n \n';
		}
		xref += 'trailer\n<< /Size ' + String(maxId + 1) + ' /Root ' + String(rootId) + ' 0 R >>\nstartxref\n' + String(xrefOffset) + '\n%%EOF\n';
		this.raw(xref);
		return Buffer.concat(this.parts);
	}
}

/**
 * Typeset plain text as a PDF.
 * @param {string} text - the document body, already sanitized.
 * @param {object} [options] - layout overrides.
 * @param {number} [options.fontSize] - body size in points.
 * @param {number} [options.lineHeight] - leading in points.
 * @param {number} [options.margin] - page margin in points.
 * @param {string} [options.title] - document title for the info dictionary.
 * @param {boolean} [options.pageNumbers] - draw "n / total" in the footer. Defaults to true.
 * @returns {{buffer: Buffer, pages: number, lines: number}} the PDF artifact.
 */
export function renderPdf(text, options = {}) {
	const fontSize = Number.isFinite(options.fontSize) && options.fontSize > 0 ? options.fontSize : PDF_LAYOUT.fontSize;
	const lineHeight = Number.isFinite(options.lineHeight) && options.lineHeight > 0 ? options.lineHeight : PDF_LAYOUT.lineHeight;
	const margin = Number.isFinite(options.margin) && options.margin >= 0 ? options.margin : PDF_LAYOUT.margin;
	const footerSize = PDF_LAYOUT.footerSize;
	const pageNumbers = options.pageNumbers !== false;

	const usableWidth = PAGE_WIDTH - margin * 2;
	const maxUnits = options.maxUnitsPerLine > 0 ? options.maxUnitsPerLine : usableWidth / fontSize;
	const bodyHeight = PAGE_HEIGHT - margin * 2;
	const linesPerPage = Math.max(1, Math.floor(bodyHeight / lineHeight));

	const logical = text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').replace(/\t/gu, '    ').split('\n');
	const display = [];
	for (const line of logical) {
		for (const piece of wrapLine(line, maxUnits)) display.push(piece);
	}

	const pages = [];
	for (let index = 0; index < display.length; index += linesPerPage) {
		pages.push(display.slice(index, index + linesPerPage));
	}
	if (pages.length === 0) pages.push(['']);

	const writer = new PdfWriter();
	// Header plus a binary marker so transport never treats the file as text.
	writer.raw('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');
	const catalogId = 1;
	const pagesId = 2;
	const courierId = 3;
	const cjkId = 4;
	const cidFontId = 5;
	const descriptorId = 6;
	const firstPageId = 7;

	writer.object(catalogId, '<< /Type /Catalog /Pages ' + String(pagesId) + ' 0 R >>');

	const kids = [];
	for (let index = 0; index < pages.length; index += 1) {
		kids.push(String(firstPageId + index * 2) + ' 0 R');
	}
	writer.object(pagesId, '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + String(pages.length) + ' >>');

	writer.object(courierId, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
	writer.object(cjkId, '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [' + String(cidFontId) + ' 0 R] >>');
	writer.object(cidFontId, '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light '
		+ '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> '
		+ '/FontDescriptor ' + String(descriptorId) + ' 0 R /DW 1000 >>');
	writer.object(descriptorId, '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 '
		+ '/FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>');

	for (let index = 0; index < pages.length; index += 1) {
		const pageId = firstPageId + index * 2;
		const contentId = pageId + 1;
		const page = pages[index];
		const body = [];

		body.push('BT');
		let y = PAGE_HEIGHT - margin - fontSize;
		for (const line of page) {
			if (line.length > 0) {
				let x = margin;
				for (const run of runsOf(line)) {
					const fontRef = run.ascii ? '/F1' : '/F2';
					const hex = run.ascii ? asciiHex(run.text) : hexOf(run.text);
					body.push(fontRef + ' ' + String(fontSize) + ' Tf');
					body.push('1 0 0 1 ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' Tm');
					body.push('<' + hex + '> Tj');
					x += unitsOf(run.text) * fontSize;
				}
			}
			y -= lineHeight;
		}
		body.push('ET');

		if (pageNumbers) {
			const label = String(index + 1) + ' / ' + String(pages.length);
			const width = unitsOf(label) * footerSize;
			body.push('BT', '/F1 ' + String(footerSize) + ' Tf', '0.5 g');
			body.push('1 0 0 1 ' + (PAGE_WIDTH - margin - width).toFixed(2) + ' ' + (margin - footerSize).toFixed(2) + ' Tm');
			body.push('<' + asciiHex(label) + '> Tj', '0 g', 'ET');
		}

		writer.object(pageId, '<< /Type /Page /Parent ' + String(pagesId) + ' 0 R '
			+ '/MediaBox [0 0 ' + PAGE_WIDTH.toFixed(2) + ' ' + PAGE_HEIGHT.toFixed(2) + '] '
			+ '/Resources << /Font << /F1 ' + String(courierId) + ' 0 R /F2 ' + String(cjkId) + ' 0 R >> >> '
			+ '/Contents ' + String(contentId) + ' 0 R >>');
		writer.stream(contentId, '', body.join('\n'));
	}

	const maxId = firstPageId + pages.length * 2 - 1;
	const title = typeof options.title === 'string' && options.title.length > 0 ? options.title : 'Session export';
	const buffer = writer.finish(catalogId, maxId);

	return { buffer, pages: pages.length, lines: display.length, title };
}
