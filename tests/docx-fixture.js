import { strToU8, zipSync } from 'fflate';

export const paragraph = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
export function docxFixture(body = paragraph('Hello 文档'), extra = {}) {
    const parts = {
        '[Content_Types].xml':
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        '_rels/.rels':
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`,
        'word/styles.xml':
            '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>',
        ...extra,
    };
    return zipSync(
        Object.fromEntries(
            Object.entries(parts).map(([name, value]) => [
                name,
                typeof value === 'string' ? strToU8(value) : value,
            ])
        )
    );
}
