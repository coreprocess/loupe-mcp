import type { ServiceConfig } from '../../config/env.ts';
import type { Loggers } from '../../core/logger.ts';
import { authenticator, fetchWithRetries, misconfigured, readJson } from './http.ts';

/**
 * The vision model on Azure OpenAI through the Responses API (v1), stateless (`store: false`), for
 * the page calls of `accurate` (concept §6.2). Images go with detail `original`: the model reads them
 * at the size sent, so the sender bounds their size. Only a completed answer counts: a rejected
 * input, a refusal or an answer cut off before its end yields `rejected`, and the caller takes its
 * fallback.
 */

const CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_TOKENS = 32_768;
/** A response the service failed itself is asked again this often before the page takes its fallback. */
const FAILED_RESPONSE_ATTEMPTS = 3;

export interface VisionImage {
    mediaType: 'image/png' | 'image/jpeg';
    data: Buffer;
}

export interface VisionRequest {
    instructions: string;
    /** Sent before the text: models attend more reliably to images that precede the text about them. */
    images: VisionImage[];
    text: string;
    /** Requests sharing the instructions share this key, so the service routes them to a warm prompt cache. */
    cacheKey: string;
    signal: AbortSignal;
}

export type VisionOutcome = { kind: 'answer'; text: string } | { kind: 'rejected'; reason: string };

interface ResponsesAnswer {
    status?: string;
    error?: { code?: string; message?: string } | null;
    incomplete_details?: { reason?: string } | null;
    output?: { type?: string; content?: { type?: string; text?: string; refusal?: string }[] }[];
}

export class VisionModel {
    readonly #url: string;
    readonly #model: string;
    readonly #auth: () => Promise<Record<string, string>>;
    readonly #reasoningEffort: string;
    readonly #loggers: Loggers;

    constructor(service: ServiceConfig, model: string, reasoningEffort: string, loggers: Loggers) {
        this.#url = `${service.endpoint}/openai/v1/responses`;
        this.#model = model;
        this.#auth = authenticator(service, 'api-key');
        this.#reasoningEffort = reasoningEffort;
        this.#loggers = loggers;
    }

    async complete(request: VisionRequest): Promise<VisionOutcome> {
        const body = JSON.stringify({
            model: this.#model,
            store: false,
            instructions: request.instructions,
            input: [
                {
                    role: 'user',
                    content: [
                        ...request.images.map((image) => ({
                            type: 'input_image',
                            image_url: `data:${image.mediaType};base64,${image.data.toString('base64')}`,
                            detail: 'original',
                        })),
                        { type: 'input_text', text: request.text },
                    ],
                },
            ],
            reasoning: { effort: this.#reasoningEffort },
            max_output_tokens: MAX_OUTPUT_TOKENS,
            prompt_cache_key: request.cacheKey,
        });
        const what = 'The vision model';
        for (let attempt = 1; ; attempt++) {
            const response = await fetchWithRetries(
                this.#url,
                async () => ({
                    method: 'POST',
                    headers: { ...(await this.#auth()), 'content-type': 'application/json' },
                    body,
                }),
                { what, signal: request.signal, attemptTimeoutMs: CALL_TIMEOUT_MS, loggers: this.#loggers }
            );
            const answer = (await readJson(response)) as ResponsesAnswer;
            if (!response.ok) {
                // the model refuses this input (content filter, an image it cannot take, too much context)
                if (response.status === 400 || response.status === 413) {
                    return this.#rejected(
                        `${answer.error?.code ?? response.status}: ${answer.error?.message ?? ''}`.trim()
                    );
                }
                throw misconfigured(what, response.status, this.#loggers);
            }
            if (answer.status === 'failed' && attempt < FAILED_RESPONSE_ATTEMPTS) {
                this.#loggers.log.info({ attempt, error: answer.error?.code }, 'vision response failed, asking again');
                continue;
            }
            return this.#outcome(answer);
        }
    }

    #outcome(answer: ResponsesAnswer): VisionOutcome {
        if (answer.status !== 'completed') {
            const reason = answer.incomplete_details?.reason ?? answer.error?.code ?? 'no reason';
            return this.#rejected(`response ${answer.status ?? 'without status'}: ${reason}`);
        }
        const parts = (answer.output ?? []).flatMap((item) => (item.type === 'message' ? (item.content ?? []) : []));
        if (parts.some((part) => part.type === 'refusal')) return this.#rejected('refusal');
        const text = parts
            .filter((part) => part.type === 'output_text')
            .map((part) => part.text ?? '')
            .join('')
            .trim();
        return text ? { kind: 'answer', text } : this.#rejected('empty answer');
    }

    #rejected(reason: string): VisionOutcome {
        this.#loggers.log.warn({ reason }, 'vision model delivered no page');
        return { kind: 'rejected', reason };
    }
}
