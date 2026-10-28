import { strToU8, zipSync } from 'fflate';

const CONTENT_TYPES = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    docm: 'application/vnd.ms-word.document.macroEnabled.main+xml',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
};

const MAIN_PART = {
    docx: '/word/document.xml',
    docm: '/word/document.xml',
    xlsx: '/xl/workbook.xml',
    pptx: '/ppt/presentation.xml',
};

/** A minimal Office package of the given kind: content types and a main part. */
export const makeOffice = (kind: keyof typeof CONTENT_TYPES, extra: Record<string, Uint8Array> = {}): Buffer => {
    const types = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="${MAIN_PART[kind]}" ContentType="${CONTENT_TYPES[kind]}"/></Types>`;
    return Buffer.from(
        zipSync({
            '[Content_Types].xml': strToU8(types),
            [MAIN_PART[kind].slice(1)]: strToU8('<document>Hello</document>'),
            ...extra,
        })
    );
};

/** A valid minimal Word document (WordprocessingML with its relationships), one paragraph per line. */
export const makeWord = (kind: 'docx' | 'docm', lines: string[]): Buffer => {
    const types = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${CONTENT_TYPES[kind]}"/></Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
    const paragraphs = lines.map((line) => `<w:p><w:r><w:t xml:space="preserve">${line}</w:t></w:r></w:p>`).join('');
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`;
    return Buffer.from(
        zipSync({
            '[Content_Types].xml': strToU8(types),
            '_rels/.rels': strToU8(rels),
            'word/document.xml': strToU8(document),
        })
    );
};
