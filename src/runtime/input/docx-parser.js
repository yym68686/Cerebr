import mammoth from 'mammoth';
import { parseDocument } from 'htmlparser2';
import { Unzip, UnzipInflate, unzipSync, zipSync } from 'fflate';
import { DOCX_MAX_BYTES } from './docx-limits.js';

const fail = (code) => {
    throw new Error(code);
};
const MAX_XML_BYTES = 32 * 1024 * 1024;

// Read only bounded XML parts, never embedded media or external resources. Repack
// them so Mammoth cannot decompress entries that bypass our size checks.
function textOnlyArchive(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length > DOCX_MAX_BYTES) fail('docx_too_large');
    if (bytes.length < 22 || new DataView(buffer).getUint32(0, true) !== 0x04034b50) fail('docx_invalid');
    let count = 0,
        total = 0;
    const seen = new Set(),
        expected = new Map();
    unzipSync(bytes, {
        filter: (entry) => {
            if (++count > 2048 || seen.has(entry.name)) fail('docx_too_complex');
            seen.add(entry.name);
            if (!/\.(xml|rels)$/i.test(entry.name)) return false;
            if (
                entry.name.startsWith('/') ||
                entry.name.includes('\\') ||
                entry.name.split('/').includes('..')
            )
                fail('docx_invalid');
            total += entry.originalSize;
            if (!Number.isSafeInteger(total) || total > MAX_XML_BYTES || entry.size > DOCX_MAX_BYTES)
                fail('docx_too_complex');
            expected.set(entry.name, entry.originalSize);
            return false;
        },
    });
    if (!expected.has('[Content_Types].xml') || !expected.has('word/document.xml')) fail('docx_invalid');
    // Stream small compressed chunks so a forged ZIP size cannot cause an
    // unbounded allocation or silently truncate an inflated XML part.
    const entries = Object.create(null),
        localNames = new Set();
    let expanded = 0;
    const unzip = new Unzip((file) => {
        if (localNames.has(file.name) || localNames.size >= 2048) fail('docx_invalid');
        localNames.add(file.name);
        if (!expected.has(file.name)) return;
        const parts = [];
        let length = 0;
        file.ondata = (error, data, final) => {
            if (error) throw error;
            length += data.length;
            expanded += data.length;
            if (expanded > MAX_XML_BYTES || length > expected.get(file.name)) fail('docx_too_complex');
            parts.push(data);
            if (final) {
                if (length !== expected.get(file.name)) fail('docx_invalid');
                const content = new Uint8Array(length);
                let offset = 0;
                for (const part of parts) {
                    content.set(part, offset);
                    offset += part.length;
                }
                entries[file.name] = content;
            }
        };
        file.start();
    });
    unzip.register(UnzipInflate);
    for (let offset = 0; offset < bytes.length; offset += 4096)
        unzip.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
    if (Object.keys(entries).length !== expected.size) fail('docx_invalid');
    return zipSync(entries, { level: 0 }).buffer;
}

const escaped = (text) => text.replace(/\\/g, '\\\\').replace(/([`*_\[\]<>|])/g, '\\$1');
const compact = (text) =>
    text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

// Parse into a non-DOM tree in the worker. No HTML is mounted, no URLs are
// followed, and only text plus a small allowlist of structural tags is retained.
export function docxHtmlToText(html) {
    if (html.length > MAX_XML_BYTES) fail('docx_too_complex');
    const render = (node, depth = 0) => {
        if (depth > 100) fail('docx_too_complex');
        if (node.type === 'text') return escaped(node.data);
        if (['script', 'style', 'iframe', 'object', 'img'].includes(node.name)) return '';
        const children = () => (node.children || []).map((child) => render(child, depth + 1)).join('');
        if (/^h[1-6]$/.test(node.name))
            return `\n\n${'#'.repeat(Number(node.name[1]))} ${compact(children())}\n\n`;
        if (node.name === 'br') return '\n';
        if (node.name === 'ul' || node.name === 'ol') {
            let index = Number(node.attribs?.start) || 1;
            const list = (node.children || [])
                .filter((child) => child.name === 'li')
                .map((child) => {
                    const marker = node.name === 'ol' ? `${index++}. ` : '- ';
                    return (
                        marker +
                        compact(render(child, depth + 1)).replace(/\n/g, `\n${' '.repeat(marker.length)}`)
                    );
                });
            return `\n\n${list.join('\n')}\n\n`;
        }
        if (node.name === 'table') {
            const rows = [];
            const collect = (parent) => {
                for (const child of parent.children || []) {
                    if (child.name === 'tr') rows.push(child);
                    else if (['thead', 'tbody', 'tfoot'].includes(child.name)) collect(child);
                }
            };
            collect(node);
            const spans = [],
                grid = [];
            for (const row of rows) {
                const cells = [];
                let column = 0;
                const skipSpans = () => {
                    while (spans[column] > 0) {
                        cells[column] = '';
                        spans[column++]--;
                    }
                };
                for (const cell of row.children.filter((child) => ['td', 'th'].includes(child.name))) {
                    skipSpans();
                    const colspan = Number(cell.attribs.colspan || 1),
                        rowspan = Number(cell.attribs.rowspan || 1);
                    if (![colspan, rowspan].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 100))
                        fail('docx_too_complex');
                    cells[column] = compact(render(cell, depth + 1)).replace(/\n+/g, ' / ');
                    for (let i = 0; i < colspan; i++) {
                        cells[column + i] ||= '';
                        spans[column + i] = rowspan - 1;
                    }
                    column += colspan;
                    if (column > 100) fail('docx_too_complex');
                }
                skipSpans();
                grid.push(cells);
            }
            const width = Math.max(0, ...grid.map((row) => row.length));
            if (!width) return '';
            const line = (row) => `| ${Array.from({ length: width }, (_, i) => row[i] || '').join(' | ')} |`;
            return `\n\n${[line(grid[0]), line(Array(width).fill('---')), ...grid.slice(1).map(line)].join('\n')}\n\n`;
        }
        const text = children();
        return ['p', 'div', 'blockquote'].includes(node.name) ? `\n\n${text}\n\n` : text;
    };
    return compact(render(parseDocument(html)));
}

export async function extractDocxText(buffer) {
    const archive = textOnlyArchive(buffer);
    const result = await mammoth.convertToHtml(
        { arrayBuffer: archive },
        {
            externalFileAccess: false,
            includeEmbeddedStyleMap: false,
            convertImage: () => [],
        }
    );
    const text = docxHtmlToText(result.value);
    if (!text.trim()) fail('docx_empty');
    return text;
}
