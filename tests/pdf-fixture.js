// Small, deterministic PDFs with real objects/xref tables, not mocked parser output.
// All source bytes are ASCII; CJK text is represented by hexadecimal glyph codes.
export function makePdf({
    pages = ['First line\nSecond line', 'Next page'],
    cjk = false,
    cmap = false,
    encrypted = false,
    script = false,
} = {}) {
    const objects = [];
    const add = (body) => (objects.push(body), objects.length);
    const stream = (body) => `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
    const catalog = add(''),
        pageTree = add('');
    let font;
    if (cjk || cmap) {
        const descriptor = add(
            '<< /Type /FontDescriptor /FontName /Fixture /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>'
        );
        const descendant = add(
            `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /Fixture /CIDSystemInfo << /Registry (Adobe) /Ordering (${cmap ? 'GB1' : 'Identity'}) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 >>`
        );
        let unicode = '';
        if (!cmap) {
            const codes = [...new Set(pages.join(''))]
                .filter((c) => c !== '\n')
                .map((c) => c.charCodeAt(0).toString(16).padStart(4, '0'));
            const mapping = add(
                stream(
                    `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Fixture def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n${codes.length} beginbfchar\n${codes.map((c) => `<${c}> <${c}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`
                )
            );
            unicode = `/ToUnicode ${mapping} 0 R`;
        }
        font = add(
            `<< /Type /Font /Subtype /Type0 /BaseFont /Fixture /Encoding /${cmap ? 'UniGB-UCS2-H' : 'Identity-H'} /DescendantFonts [${descendant} 0 R] ${unicode} >>`
        );
    } else font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const children = [];
    for (const text of pages) {
        const lines = text
            .split('\n')
            .map((line, index) => {
                const glyphs =
                    cjk || cmap
                        ? `<${[...line].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`
                        : `(${line.replace(/[\\()]/g, '\\$&')})`;
                return `${index ? '0 -18 Td ' : ''}${glyphs} Tj`;
            })
            .join('\n');
        const content = add(stream(`BT /F1 12 Tf 20 750 Td\n${lines}\nET`));
        children.push(
            add(
                `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`
            )
        );
    }
    objects[pageTree - 1] =
        `<< /Type /Pages /Count ${children.length} /Kids [${children.map((id) => `${id} 0 R`).join(' ')}] >>`;
    const action = script ? add('<< /S /JavaScript /JS (globalThis.__pdfExecuted = true) >>') : null;
    objects[catalog - 1] =
        `<< /Type /Catalog /Pages ${pageTree} 0 R ${action ? `/OpenAction ${action} 0 R` : ''} >>`;
    const encryption = encrypted
        ? add(
              `<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> >>`
          )
        : null;
    let source = '%PDF-1.7\n',
        offsets = [0];
    objects.forEach((body, index) => {
        offsets.push(source.length);
        source += `${index + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = source.length;
    source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join(
            ''
        )}trailer\n<< /Size ${offsets.length} /Root ${catalog} 0 R ${encryption ? `/Encrypt ${encryption} 0 R /ID [<${'12'.repeat(16)}> <${'12'.repeat(16)}>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(source).buffer;
}
