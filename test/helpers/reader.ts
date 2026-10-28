import { loadConfig } from '../../src/config/env.ts';
import { nullLoggers } from '../../src/core/logger.ts';
import { Semaphore } from '../../src/core/semaphore.ts';
import { PDF_READER_ENTRY, PdfReaderHost } from '../../src/reading/pdf/host.ts';
import { DocumentReader } from '../../src/reading/reader.ts';
import { DocumentIntelligence } from '../../src/reading/services/document-intelligence.ts';
import { VisionModel } from '../../src/reading/services/vision.ts';
import type { MockServices } from './mock-services.ts';

/** A document reader against the mock services and the real pdf.js process. */
export const createReader = (mock: MockServices, env: Record<string, string> = {}) => {
    const config = loadConfig({
        LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT: mock.url,
        LOUPE_DOCUMENT_INTELLIGENCE_KEY: 'k',
        LOUPE_OPENAI_ENDPOINT: mock.url,
        LOUPE_OPENAI_KEY: 'k',
        ...env,
    });
    const loggers = nullLoggers();
    const reader = new DocumentReader({
        documentIntelligence: new DocumentIntelligence(config.documentIntelligence, loggers),
        vision: new VisionModel(config.openai, config.vision.model, config.vision.reasoningEffort, loggers),
        pdfReader: new PdfReaderHost(
            {
                entry: PDF_READER_ENTRY,
                openTimeoutMs: 30_000,
                idleTimeoutMs: 30_000,
                totalTimeoutMs: 60_000,
                maxConcurrent: 2,
                maxHeapMb: 512,
            },
            loggers.log
        ),
        visionSlots: new Semaphore(config.limits.visionConcurrency),
        limits: config.limits,
        loggers,
    });
    return { reader, config, loggers };
};
