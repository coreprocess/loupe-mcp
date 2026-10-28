import { DefaultAzureCredential } from '@azure/identity';
import { Agent, fetch, type RequestInit, type Response } from 'undici';
import type { ServiceConfig } from '../../config/env.ts';
import type { Loggers } from '../../core/logger.ts';
import { sleep } from '../../core/sleep.ts';
import { DocumentError } from '../errors.ts';

/**
 * HTTP to the Azure AI services: authentication, and retries of throttling and outages within a
 * time budget (concept §6.4). A vision call can take minutes before its first byte, so the
 * connection's own header and body timeouts are long; every call carries its own deadline instead.
 */

const dispatcher = new Agent({ headersTimeout: 15 * 60_000, bodyTimeout: 15 * 60_000, connections: 64 });

const COGNITIVE_SERVICES_SCOPE = 'https://cognitiveservices.azure.com/.default';
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60_000;
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Retries of throttling and server errors stop after this much time per call. */
export const RETRY_BUDGET_MS = 10 * 60_000;

let credential: DefaultAzureCredential | undefined;

/** Headers that authenticate at an Azure AI service: its API key, or a token of the managed identity. */
export const authenticator = (service: ServiceConfig, keyHeader: string) => {
    let cached: { token: string; refreshAt: number } | undefined;
    return async (): Promise<Record<string, string>> => {
        if (service.key) return { [keyHeader]: service.key };
        if (!cached || Date.now() > cached.refreshAt) {
            credential ??= new DefaultAzureCredential();
            const token = await credential.getToken(COGNITIVE_SERVICES_SCOPE);
            cached = { token: token.token, refreshAt: token.expiresOnTimestamp - TOKEN_REFRESH_MARGIN_MS };
        }
        return { authorization: `Bearer ${cached.token}` };
    };
};

/** The wait a throttled or failed response asks for, or an exponential backoff with jitter. */
const backoffMs = (response: Response | undefined, attempt: number): number => {
    const retryAfterMs = Number(response?.headers.get('retry-after-ms'));
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs, MAX_BACKOFF_MS);
    const retryAfter = Number(response?.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
    return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS) * (0.5 + Math.random() / 2);
};

export interface RetryOptions {
    /** What the call is, for messages and logs. */
    what: string;
    signal: AbortSignal;
    /** Deadline of one attempt. */
    attemptTimeoutMs: number;
    loggers: Loggers;
}

/**
 * Sends a request until the answer is neither throttling nor a server error, within the retry
 * budget; then the document fails with `service_unavailable`. An abort of `signal` (cancellation,
 * shutdown) propagates as itself.
 */
export const fetchWithRetries = async (
    url: string,
    init: () => Promise<RequestInit>,
    options: RetryOptions
): Promise<Response> => {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
        options.signal.throwIfAborted();
        let response: Response | undefined;
        let failure: unknown;
        try {
            const request = await init();
            response = await fetch(url, {
                ...request,
                dispatcher,
                signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.attemptTimeoutMs)]),
            });
            if (!TRANSIENT_STATUSES.has(response.status)) return response;
            failure = `HTTP ${response.status}`;
            await response.body?.cancel();
        } catch (error) {
            options.signal.throwIfAborted();
            failure = error;
        }
        const wait = backoffMs(response, attempt);
        if (Date.now() + wait - started > RETRY_BUDGET_MS) {
            options.loggers.log.warn({ what: options.what, err: failure }, 'service unavailable, retries exhausted');
            throw new DocumentError('service_unavailable', `${options.what} stayed unavailable through every retry`);
        }
        options.loggers.log.info({ what: options.what, attempt, wait, err: failure }, 'retrying service call');
        await sleep(wait, options.signal);
    }
};

/** A JSON body as an object; an unparseable body is an empty one. */
export const readJson = async (response: Response): Promise<Record<string, unknown>> => {
    const text = await response.text();
    try {
        const value: unknown = JSON.parse(text);
        return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    } catch {
        return {};
    }
};

/** A service refusing Loupe's own credentials or deployment: no document can be read until an operator acts. */
export const misconfigured = (what: string, status: number, loggers: Loggers): DocumentError => {
    loggers.log.error({ what, status }, 'service refused the configured credentials or deployment');
    return new DocumentError('service_unavailable', `${what} refused the request (HTTP ${status})`);
};
