import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { nullLoggers } from '../../src/core/logger.ts';
import { DocumentError } from '../../src/reading/errors.ts';
import { AnalysisRefusedError, DocumentIntelligence } from '../../src/reading/services/document-intelligence.ts';
import { VisionModel } from '../../src/reading/services/vision.ts';
import { MockServices } from '../helpers/mock-services.ts';

const mock = new MockServices();
const signal = () => AbortSignal.timeout(60_000);
const options = (extra: Partial<Parameters<DocumentIntelligence['analyzeLayout']>[1]> = {}) => ({
    highResolution: false,
    locale: undefined,
    pages: undefined,
    signal: signal(),
    ...extra,
});

describe('service clients', () => {
    let documents: DocumentIntelligence;
    let vision: VisionModel;

    before(async () => {
        await mock.start();
        documents = new DocumentIntelligence({ endpoint: mock.url, key: 'di-key' }, nullLoggers());
        vision = new VisionModel({ endpoint: mock.url, key: 'openai-key' }, 'vision', 'low', nullLoggers());
    });
    after(() => mock.stop());
    beforeEach(() => mock.reset());

    it('analyzes a file as the request body with the requested options', async () => {
        const pages = await documents.analyzeLayout(
            Buffer.from('%PDF-1.7'),
            options({ highResolution: true, locale: 'de', pages: '2-3' })
        );
        assert.deepEqual(
            pages.map((page) => page.number),
            [2, 3]
        );
        assert.match(pages[0]?.markdown ?? '', /OCR text of page 2/);
        assert.doesNotMatch(pages[0]?.markdown ?? '', /PageNumber/);
        const call = mock.analyzeCalls[0];
        assert.equal(call?.bytes, 8);
        assert.equal(call?.headers['ocp-apim-subscription-key'], 'di-key');
        assert.equal(call?.headers['content-type'], 'application/octet-stream');
        assert.equal(call?.query.get('features'), 'ocrHighResolution');
        assert.equal(call?.query.get('locale'), 'de');
        assert.equal(call?.query.get('outputContentFormat'), 'markdown');
    });

    it('retries throttling and waits for a running operation', async () => {
        mock.behavior.throttleAnalyze = 2;
        mock.behavior.runningPolls = 1;
        const pages = await documents.analyzeLayout(Buffer.from('x'), options());
        assert.equal(pages.length, 1);
        assert.equal(mock.analyzeCalls.length, 3);
        assert.equal(mock.analyzeCalls[0]?.query.has('features'), false);
    });

    it('reports a refusal of the file as a verdict', async () => {
        mock.behavior.refuseAnalyze = true;
        await assert.rejects(documents.analyzeLayout(Buffer.from('x'), options()), AnalysisRefusedError);
        mock.reset();
        mock.behavior.failOperation = 'InvalidContent';
        await assert.rejects(documents.analyzeLayout(Buffer.from('x'), options()), /InvalidContent/);
    });

    it('reports refused credentials as unavailable, not as a verdict on the file', async () => {
        mock.behavior.forceStatus = 401;
        await assert.rejects(
            documents.analyzeLayout(Buffer.from('x'), options()),
            (error: unknown) =>
                error instanceof DocumentError &&
                error.code === 'service_unavailable' &&
                !(error instanceof AnalysisRefusedError)
        );
    });

    it('stops at once when the job is cancelled', async () => {
        mock.behavior.runningPolls = 1000;
        const controller = new AbortController();
        const analysis = documents.analyzeLayout(Buffer.from('x'), options({ signal: controller.signal }));
        setTimeout(() => controller.abort(new Error('cancelled')), 50);
        await assert.rejects(analysis, /cancelled/);
    });

    it('sends images before the text and accepts only complete answers', async () => {
        const answer = await vision.complete({
            system: 'system prompt',
            images: [{ mediaType: 'image/png', data: Buffer.from('png') }],
            text: '## Page number\n\n4',
            signal: signal(),
        });
        assert.deepEqual(answer, { kind: 'answer', text: '<p>Vision page 4</p>' });
        const call = mock.visionCalls[0];
        assert.equal(call?.images, 1);
        assert.equal(call?.system, 'system prompt');
        assert.equal(call?.body.reasoning_effort, 'low');

        mock.behavior.truncatePages.add(5);
        const cut = await vision.complete({ system: '', images: [], text: '## Page number\n\n5', signal: signal() });
        assert.equal(cut.kind, 'rejected');
        mock.behavior.rejectPages.add(6);
        const filtered = await vision.complete({
            system: '',
            images: [],
            text: '## Page number\n\n6',
            signal: signal(),
        });
        assert.deepEqual(filtered.kind, 'rejected');
    });
});
