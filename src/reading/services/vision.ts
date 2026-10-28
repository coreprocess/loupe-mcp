import type { ServiceConfig } from '../../config/env.ts';
import type { Loggers } from '../../core/logger.ts';
import { authenticator, fetchWithRetries, misconfigured, readJson } from './http.ts';

/**
 * The vision model on Azure OpenAI (chat completions with image parts), for the page calls of
 * `accurate` (concept §6.2). Only a complete answer counts: a rejected input or an answer cut off
 * before its end yields `rejected`, and the caller takes its fallback.
 */

const API_VERSION = '2025-04-01-preview';
const CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_COMPLETION_TOKENS = 32_768;

export interface VisionImage {
    mediaType: 'image/png' | 'image/jpeg';
    data: Buffer;
}

export interface VisionRequest {
    system: string;
    /** Sent before the text: models attend more reliably to images that precede the text about them. */
    images: VisionImage[];
    text: string;
    signal: AbortSignal;
}

export type VisionOutcome = { kind: 'answer'; text: string } | { kind: 'rejected'; reason: string };

export class VisionModel {
    readonly #url: string;
    readonly #auth: () => Promise<Record<string, string>>;
    readonly #reasoningEffort: string;
    readonly #loggers: Loggers;

    constructor(service: ServiceConfig, model: string, reasoningEffort: string, loggers: Loggers) {
        this.#url = `${service.endpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${API_VERSION}`;
        this.#auth = authenticator(service, 'api-key');
        this.#reasoningEffort = reasoningEffort;
        this.#loggers = loggers;
    }

    async complete(request: VisionRequest): Promise<VisionOutcome> {
        const body = JSON.stringify({
            messages: [
                { role: 'system', content: request.system },
                {
                    role: 'user',
                    content: [
                        ...request.images.map((image) => ({
                            type: 'image_url',
                            image_url: { url: `data:${image.mediaType};base64,${image.data.toString('base64')}` },
                        })),
                        { type: 'text', text: request.text },
                    ],
                },
            ],
            reasoning_effort: this.#reasoningEffort,
            max_completion_tokens: MAX_COMPLETION_TOKENS,
        });
        const what = 'The vision model';
        const response = await fetchWithRetries(
            this.#url,
            async () => ({
                method: 'POST',
                headers: { ...(await this.#auth()), 'content-type': 'application/json' },
                body,
            }),
            { what, signal: request.signal, attemptTimeoutMs: CALL_TIMEOUT_MS, loggers: this.#loggers }
        );
        const answer = await readJson(response);
        if (!response.ok) {
            // the model refuses this input (content filter, an image it cannot take, too much context)
            if (response.status === 400 || response.status === 413) {
                const error = (answer.error ?? {}) as { code?: string; message?: string };
                const reason = `${error.code ?? response.status}: ${error.message ?? ''}`.trim();
                this.#loggers.log.warn({ reason }, 'vision model rejected a page');
                return { kind: 'rejected', reason };
            }
            throw misconfigured(what, response.status, this.#loggers);
        }
        const choice = (answer.choices as { finish_reason?: string; message?: { content?: string | null } }[])?.[0];
        if (choice?.finish_reason !== 'stop') {
            return { kind: 'rejected', reason: `answer ended with ${choice?.finish_reason ?? 'no choice'}` };
        }
        const text = choice.message?.content?.trim();
        return text ? { kind: 'answer', text } : { kind: 'rejected', reason: 'empty answer' };
    }
}
