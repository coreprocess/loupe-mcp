import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Mocks of Azure Document Intelligence (layout analysis as a long-running operation) and Azure
 * OpenAI (Responses API) on one local HTTP server. The transcript has one page per selected page
 * (`pages` query, or one page); the vision model answers with the page number it was asked about.
 */

export interface AnalyzeCall {
    query: URLSearchParams;
    bytes: number;
    headers: IncomingMessage['headers'];
}

export interface VisionCall {
    page: number;
    images: number;
    text: string;
    instructions: string;
    body: Record<string, unknown>;
}

export interface MockBehavior {
    /** Answers 429 with Retry-After to this many analyze requests first. */
    throttleAnalyze: number;
    /** Refuses every analysis with 400 InvalidRequest. */
    refuseAnalyze: boolean;
    /** Fails the operation with this error code. */
    failOperation: string | undefined;
    /** Operations stay `running` this many polls. */
    runningPolls: number;
    /** Pages the vision model rejects with a content filter error. */
    rejectPages: Set<number>;
    /** Pages whose answer is cut off. */
    truncatePages: Set<number>;
    /** Pages the model refuses in its answer. */
    refusePages: Set<number>;
    /** Pages whose first response the service fails itself. */
    failOncePages: Set<number>;
    /** Delays every vision answer. */
    visionDelayMs: number;
    /** Status answered to every request, e.g. 401 for a wrong key. */
    forceStatus: number | undefined;
}

const expand = (spec: string | null): number[] => {
    if (!spec) return [1];
    return spec.split(',').flatMap((part) => {
        const [from, to = from] = part.split('-').map(Number) as [number, number?];
        return Array.from({ length: (to as number) - from + 1 }, (_, i) => from + i);
    });
};

const readBody = async (req: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
};

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
};

export class MockServices {
    readonly analyzeCalls: AnalyzeCall[] = [];
    readonly visionCalls: VisionCall[] = [];
    readonly behavior: MockBehavior = MockServices.defaults();
    #server: Server | undefined;
    #operations = new Map<string, { pages: number[]; polls: number }>();
    #url = '';

    static defaults(): MockBehavior {
        return {
            throttleAnalyze: 0,
            refuseAnalyze: false,
            failOperation: undefined,
            runningPolls: 0,
            rejectPages: new Set(),
            truncatePages: new Set(),
            refusePages: new Set(),
            failOncePages: new Set(),
            visionDelayMs: 0,
            forceStatus: undefined,
        };
    }

    get url(): string {
        return this.#url;
    }

    reset(): void {
        Object.assign(this.behavior, MockServices.defaults());
        this.analyzeCalls.length = 0;
        this.visionCalls.length = 0;
    }

    async start(): Promise<void> {
        this.#server = createServer((req, res) => void this.#handle(req, res));
        await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
        this.#url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    }

    async stop(): Promise<void> {
        this.#server?.closeAllConnections();
        await new Promise((resolve) => this.#server?.close(resolve));
    }

    async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? '/', this.#url);
        const body = await readBody(req);
        if (this.behavior.forceStatus) {
            send(res, this.behavior.forceStatus, { error: { code: 'Forced', message: 'forced' } });
            return;
        }
        if (req.method === 'POST' && url.pathname.endsWith('/prebuilt-layout:analyze')) {
            this.analyzeCalls.push({ query: url.searchParams, bytes: body.length, headers: req.headers });
            if (this.behavior.throttleAnalyze > 0) {
                this.behavior.throttleAnalyze--;
                send(res, 429, { error: { code: '429' } }, { 'retry-after': '0' });
                return;
            }
            if (this.behavior.refuseAnalyze) {
                send(res, 400, {
                    error: {
                        code: 'InvalidRequest',
                        message: 'Invalid request.',
                        innererror: { code: 'InvalidContent' },
                    },
                });
                return;
            }
            const id = String(this.#operations.size + 1);
            this.#operations.set(id, { pages: expand(url.searchParams.get('pages')), polls: 0 });
            res.writeHead(202, {
                'operation-location': `${this.#url}/documentintelligence/documentModels/prebuilt-layout/analyzeResults/${id}?api-version=2024-11-30`,
            });
            res.end();
            return;
        }
        const operation = /\/analyzeResults\/(\w+)$/.exec(url.pathname)?.[1];
        if (req.method === 'GET' && operation) {
            const entry = this.#operations.get(operation);
            if (!entry) {
                send(res, 404, { error: { code: 'NotFound' } });
                return;
            }
            if (entry.polls++ < this.behavior.runningPolls) {
                send(res, 200, { status: 'running' });
                return;
            }
            if (this.behavior.failOperation) {
                send(res, 200, { status: 'failed', error: { code: this.behavior.failOperation, message: 'failed' } });
                return;
            }
            const content = entry.pages
                .map((page) => `# Heading ${page}\n\nOCR text of page ${page}\n\n<!-- PageNumber="${page}" -->`)
                .join('\n\n<!-- PageBreak -->\n\n');
            send(res, 200, {
                status: 'succeeded',
                analyzeResult: { content, pages: entry.pages.map((pageNumber) => ({ pageNumber })) },
            });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/openai/v1/responses') {
            const request = JSON.parse(body.toString('utf8')) as {
                instructions?: string;
                input: { role: string; content: { type: string; text?: string; detail?: string }[] }[];
            };
            const parts = request.input.find((item) => item.role === 'user')?.content ?? [];
            const text = parts.find((part) => part.type === 'input_text')?.text ?? '';
            const page = Number(/## Page number\n\n(\d+)/.exec(text)?.[1] ?? 0);
            this.visionCalls.push({
                page,
                images: parts.filter((part) => part.type === 'input_image').length,
                text,
                instructions: request.instructions ?? '',
                body: request as unknown as Record<string, unknown>,
            });
            if (this.behavior.visionDelayMs)
                await new Promise((resolve) => setTimeout(resolve, this.behavior.visionDelayMs));
            if (this.behavior.rejectPages.has(page)) {
                send(res, 400, { error: { code: 'content_filter', message: 'filtered' } });
                return;
            }
            if (this.behavior.failOncePages.delete(page)) {
                send(res, 200, { status: 'failed', error: { code: 'server_error', message: 'failed' }, output: [] });
                return;
            }
            if (this.behavior.truncatePages.has(page)) {
                send(res, 200, {
                    status: 'incomplete',
                    incomplete_details: { reason: 'max_output_tokens' },
                    output: [],
                });
                return;
            }
            if (this.behavior.refusePages.has(page)) {
                send(res, 200, {
                    status: 'completed',
                    output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }],
                });
                return;
            }
            send(res, 200, {
                status: 'completed',
                output: [
                    { type: 'reasoning', summary: [] },
                    { type: 'message', content: [{ type: 'output_text', text: `<p>Vision page ${page}</p>` }] },
                ],
            });
            return;
        }
        send(res, 404, { error: { code: 'NotFound' } });
    }
}
