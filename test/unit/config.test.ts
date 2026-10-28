import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../../src/config/env.ts';
import { LoupeError } from '../../src/core/errors.ts';

const SERVICES = {
    LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT: 'https://documents.example.com/',
    LOUPE_OPENAI_ENDPOINT: 'https://openai.example.com',
};

const expectConfigError = (env: Record<string, string>, variable: RegExp): void => {
    assert.throws(
        () => loadConfig(env),
        (error: unknown) =>
            error instanceof LoupeError && error.code === 'config_invalid' && variable.test(error.message)
    );
};

const HTTP = {
    ...SERVICES,
    LOUPE_TRANSPORT: 'http',
    LOUPE_PUBLIC_URL: 'https://loupe.example.com',
    LOUPE_AUTH_TENANT_ID: '11111111-2222-3333-4444-555555555555',
    LOUPE_AUTH_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    LOUPE_STORE_ACCOUNT_URL: 'https://store.example.com',
    LOUPE_SIGNING_KEY: 'k'.repeat(32),
};

describe('configuration', () => {
    it('applies the documented defaults in stdio mode', () => {
        const config = loadConfig(SERVICES);
        assert.equal(config.transport, 'stdio');
        assert.equal(config.auth.mode, 'none');
        assert.equal(config.store.kind, 'filesystem');
        assert.equal(config.retentionMs, 2 * 86_400_000);
        assert.equal(config.urlTtlMs, 3_600_000);
        assert.equal(config.vision.model, 'gpt-5.6-luna');
        assert.equal(config.vision.reasoningEffort, 'medium');
        assert.equal(config.documentIntelligence.endpoint, 'https://documents.example.com');
        assert.equal(config.documentIntelligence.key, undefined);
        assert.deepEqual(
            {
                maxFileBytes: config.limits.maxFileBytes,
                uploadMaxFiles: config.limits.uploadMaxFiles,
                maxPages: config.limits.maxPages,
                accurateMaxPages: config.limits.accurateMaxPages,
                analysisConcurrency: config.limits.analysisConcurrency,
                visionConcurrency: config.limits.visionConcurrency,
            },
            {
                maxFileBytes: 134_217_728,
                uploadMaxFiles: 1000,
                maxPages: 2000,
                accurateMaxPages: 100,
                analysisConcurrency: 4,
                visionConcurrency: 8,
            }
        );
        assert.ok(config.signingKeyGenerated);
    });

    it('configures an http deployment with Entra and a blob store', () => {
        const config = loadConfig({ ...HTTP, LOUPE_VISION_MODEL: 'vision-deployment', LOUPE_OPENAI_KEY: 'secret' });
        assert.equal(config.auth.mode, 'entra');
        assert.equal(config.auth.requiredRole, 'Loupe.User');
        assert.equal(config.store.kind, 'azureblob');
        assert.equal(config.vision.model, 'vision-deployment');
        assert.equal(config.openai.key, 'secret');
    });

    it('requires the service endpoints', () => {
        expectConfigError(
            { LOUPE_OPENAI_ENDPOINT: SERVICES.LOUPE_OPENAI_ENDPOINT },
            /LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT/
        );
        expectConfigError({ ...SERVICES, LOUPE_OPENAI_ENDPOINT: 'not a url' }, /LOUPE_OPENAI_ENDPOINT/);
    });

    it('requires a retention beyond the job duration and URL lifetime', () => {
        expectConfigError({ ...SERVICES, LOUPE_RETENTION: 'PT12H' }, /LOUPE_RETENTION/);
        assert.ok(loadConfig({ ...SERVICES, LOUPE_RETENTION: 'PT3H', LOUPE_MAX_JOB_DURATION: 'PT1H' }));
    });

    it('refuses unsafe or incomplete deployments', () => {
        expectConfigError({ ...HTTP, LOUPE_AUTH: 'none' }, /LOUPE_AUTH/);
        expectConfigError({ ...HTTP, LOUPE_SIGNING_KEY: '' }, /LOUPE_SIGNING_KEY/);
        expectConfigError({ ...HTTP, LOUPE_SIGNING_KEY: 'short' }, /LOUPE_SIGNING_KEY/);
        expectConfigError({ ...HTTP, LOUPE_AUTH_CLIENT_ID: '' }, /LOUPE_AUTH_CLIENT_ID/);
        expectConfigError({ ...HTTP, LOUPE_STORE_ACCOUNT_URL: '' }, /LOUPE_STORE_ACCOUNT_URL/);
        expectConfigError({ ...HTTP, LOUPE_AUTH: 'entra-broker' }, /LOUPE_AUTH_CLIENT_ASSERTION_FILE/);
        expectConfigError({ ...SERVICES, LOUPE_VISION_REASONING_EFFORT: 'extreme' }, /LOUPE_VISION_REASONING_EFFORT/);
        expectConfigError({ ...SERVICES, LOUPE_MAX_PAGES: '0' }, /LOUPE_MAX_PAGES/);
    });
});
