import { describe, expect, it, vi } from 'vitest';
import { strToU8, unzipSync, Zip, ZipDeflate, zipSync } from 'fflate';
// Node's Mammoth entry takes Buffer; production Vite resolves its browser entry.
vi.mock('mammoth', async (original) => {
    const { default: mammoth } = await original();
    return {
        default: {
            convertToHtml: ({ arrayBuffer }, options) =>
                mammoth.convertToHtml({ buffer: Buffer.from(arrayBuffer) }, options),
        },
    };
});
import { docxHtmlToText, extractDocxText } from '../src/runtime/input/docx-parser.js';
import { DOCX_MAX_BYTES, DOCX_MAX_TEXT } from '../src/runtime/input/docx-limits.js';
import { docxFixture, paragraph } from './docx-fixture.js';
const buffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

describe('local DOCX extraction', () => {
    it('reads streaming ZIP data descriptors used by document generators', async () => {
        const chunks = [];
        const zip = new Zip((error, data) => {
            if (error) throw error;
            chunks.push(data);
        });
        for (const [name, bytes] of Object.entries(unzipSync(docxFixture()))) {
            const entry = new ZipDeflate(name);
            zip.add(entry);
            entry.push(bytes, true);
        }
        zip.end();
        const streamed = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
            streamed.set(chunk, offset);
            offset += chunk.length;
        }
        await expect(extractDocxText(streamed.buffer)).resolves.toBe('Hello 文档');
    });
    it('extracts real DOCX headings, Unicode paragraphs, lists and tables in order', async () => {
        const body =
            '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>项目报告</w:t></w:r></w:p>' +
            paragraph('正文 &amp; details') +
            '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>' +
            '<w:tbl><w:tr><w:tc>' +
            paragraph('Name') +
            '</w:tc><w:tc>' +
            paragraph('Value') +
            '</w:tc></w:tr>' +
            '<w:tr><w:tc>' +
            paragraph('成本') +
            '</w:tc><w:tc>' +
            paragraph('42') +
            '</w:tc></w:tr></w:tbl>';
        const text = await extractDocxText(
            buffer(
                docxFixture(body, {
                    'word/numbering.xml':
                        '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
                })
            )
        );
        expect(text).toBe(
            '# 项目报告\n\n正文 & details\n\n- 第一项\n\n| Name | Value |\n| --- | --- |\n| 成本 | 42 |'
        );
    });

    it('keeps nested lists, merged cells and multiline cells readable', () => {
        const text = docxHtmlToText(
            '<ol start="3"><li><p>Top</p><ul><li>Nested</li></ul></li><li>Next</li></ol>' +
                '<table><tr><th rowspan="2">Group</th><th colspan="2">Amounts</th></tr><tr><td>A<br>B</td><td>2 | 3</td></tr></table>'
        );
        expect(text).toContain('3. Top\n\n   - Nested\n4. Next');
        expect(text).toContain('| Group | Amounts |  |\n| --- | --- | --- |\n|  | A / B | 2 \\| 3 |');
    });

    it('treats markup and unsafe links as text without mounting DOM or reading media', async () => {
        const network = vi.spyOn(globalThis, 'fetch');
        const create = vi.spyOn(document, 'createElement');
        try {
            expect(
                docxHtmlToText(
                    '<p>&lt;script&gt;literal&lt;/script&gt; <a href="javascript:alert(1)">Link</a><img src="https://private.invalid/image"/></p><script>bad()</script>'
                )
            ).toBe('\\<script\\>literal\\</script\\> Link');
            const text = await extractDocxText(
                buffer(
                    docxFixture(paragraph('Safe text'), {
                        'word/media/unused.png': new Uint8Array(1024),
                        'word/vbaProject.bin': new Uint8Array(20),
                    })
                )
            );
            expect(text).toBe('Safe text');
            expect(network).not.toHaveBeenCalled();
            expect(create).not.toHaveBeenCalled();
        } finally {
            network.mockRestore();
            create.mockRestore();
        }
    });

    it('rejects non-DOCX archives, empty documents, corrupt and encrypted files', async () => {
        await expect(extractDocxText(buffer(zipSync({ 'hello.txt': strToU8('not Word') })))).rejects.toThrow(
            'docx_invalid'
        );
        await expect(extractDocxText(new ArrayBuffer(0))).rejects.toThrow('docx_invalid');
        await expect(extractDocxText(buffer(strToU8('encrypted or legacy document')))).rejects.toThrow(
            'docx_invalid'
        );
        await expect(extractDocxText(buffer(docxFixture('')))).rejects.toThrow('docx_empty');
    });

    it('rejects huge files, oversized XML expansion, deep trees and long output without truncation', async () => {
        await expect(extractDocxText(new ArrayBuffer(DOCX_MAX_BYTES + 1))).rejects.toThrow('docx_too_large');
        const bomb = docxFixture(paragraph('Hi'));
        const view = new DataView(bomb.buffer);
        for (let i = 0; i < bomb.length - 46; i++) {
            if (view.getUint32(i, true) === 0x02014b50) {
                view.setUint32(i + 24, 64 * 1024 * 1024, true);
                break;
            }
        }
        await expect(extractDocxText(buffer(bomb))).rejects.toThrow('docx_too_complex');
        expect(() => docxHtmlToText('<div>'.repeat(110) + 'deep' + '</div>'.repeat(110))).toThrow(
            'docx_too_complex'
        );
        await expect(
            extractDocxText(buffer(docxFixture(paragraph('x'.repeat(DOCX_MAX_TEXT + 1)))))
        ).rejects.toThrow('docx_text_too_large');
    });

    it('rejects forged ZIP sizes instead of silently truncating XML', async () => {
        const forged = docxFixture(paragraph('x'.repeat(10_000)));
        const view = new DataView(forged.buffer);
        for (let i = 0; i < forged.length - 46; i++) {
            if (view.getUint32(i, true) === 0x02014b50) {
                view.setUint32(i + 24, 1, true);
                break;
            }
        }
        await expect(extractDocxText(buffer(forged))).rejects.toThrow('docx_too_complex');
    });
});
