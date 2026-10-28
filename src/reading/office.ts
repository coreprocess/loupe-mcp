import { DOCM_MAIN_PART, DOCX_MAIN_PART } from '../uploads/detect.ts';
import { DOCUMENT_TYPES, type DocumentType } from '../uploads/types.ts';
import { bufferReader, readZipDirectory, readZipEntry, replaceZipEntry, ZipError } from '../uploads/zip.ts';
import { DocumentError } from './errors.ts';

const CONTENT_TYPES = '[Content_Types].xml';
const MAX_CONTENT_TYPES_BYTES = 1024 * 1024;

/**
 * The bytes Document Intelligence is given: a macro-enabled Word package (DOCM) rewritten into a plain
 * DOCX, since the service takes no macro-enabled packages; only its content types change, and the
 * macros stay inert. Every other file as it is.
 */
export const prepareForAnalysis = async (type: DocumentType, content: Buffer): Promise<Buffer> => {
    if (type !== DOCUMENT_TYPES.docm) return content;
    try {
        const read = bufferReader(content);
        const { entries } = await readZipDirectory(read, content.length);
        const entry = entries.find((candidate) => candidate.name === CONTENT_TYPES);
        if (!entry) throw new ZipError('no content types');
        const xml = (await readZipEntry(read, entry, MAX_CONTENT_TYPES_BYTES)).toString('utf8');
        return await replaceZipEntry(
            content,
            CONTENT_TYPES,
            Buffer.from(xml.replaceAll(DOCM_MAIN_PART, DOCX_MAIN_PART))
        );
    } catch (error) {
        if (error instanceof ZipError)
            throw new DocumentError('unreadable', `The Word package is damaged: ${error.message}`);
        throw error;
    }
};
