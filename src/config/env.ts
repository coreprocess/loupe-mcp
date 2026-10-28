import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { parseIsoDuration } from '../core/duration.ts';
import { LoupeError } from '../core/errors.ts';

export interface AuthConfig {
    mode: 'entra' | 'entra-broker' | 'none';
    tenantId: string | undefined;
    clientId: string | undefined;
    requiredRole: string;
    scopeName: string;
    /** entra-broker: how Loupe authenticates to Entra (secret, or a federated token file). */
    clientSecret: string | undefined;
    clientAssertionFile: string | undefined;
    /** entra-broker: client ID of a user-assigned managed identity whose token is the client assertion. */
    assertionIdentity: string | undefined;
    /** entra-broker: redirect URIs MCP clients may register, besides loopback. */
    redirectUris: string[];
    accessTokenTtlMs: number;
    sessionTtlMs: number;
    /** Overrides for non-public clouds and tests. Defaults derive from the tenant. */
    issuer: string | undefined;
    jwksUri: string | undefined;
    authorizationServer: string | undefined;
}

export interface StoreConfig {
    kind: 'azureblob' | 'filesystem';
    accountUrl: string | undefined;
    connectionString: string | undefined;
    container: string;
    dir: string;
}

/** An Azure AI service: its endpoint, and an API key or (without one) the managed identity. */
export interface ServiceConfig {
    endpoint: string;
    key: string | undefined;
}

export interface LimitsConfig {
    maxFileBytes: number;
    uploadMaxFiles: number;
    uploadMaxBytes: number;
    maxPages: number;
    accurateMaxPages: number;
    maxJobDurationMs: number;
    analysisConcurrency: number;
    visionConcurrency: number;
    maxActiveJobs: number;
    readMaxBytes: number;
}

export interface Config {
    transport: 'stdio' | 'http';
    host: string;
    port: number;
    publicUrl: string;
    auth: AuthConfig;
    store: StoreConfig;
    retentionMs: number;
    urlTtlMs: number;
    signingKey: Buffer;
    signingKeyGenerated: boolean;
    documentIntelligence: ServiceConfig;
    openai: ServiceConfig;
    vision: { model: string; reasoningEffort: string };
    limits: LimitsConfig;
    auditLog: string;
    logLevel: string;
}

type Env = Record<string, string | undefined>;

const fail = (variable: string, reason: string): never => {
    throw new LoupeError('config_invalid', `${variable}: ${reason}`);
};

const intVar = (env: Env, name: string, fallback: number, min = 1): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min) fail(name, `expected an integer >= ${min}`);
    return value;
};

const durationVar = (env: Env, name: string, fallback: string): number => {
    const raw = env[name] ?? fallback;
    try {
        return parseIsoDuration(raw);
    } catch {
        return fail(name, `invalid ISO 8601 duration '${raw}'`);
    }
};

const enumVar = <T extends string>(env: Env, name: string, values: readonly T[], fallback: T): T => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!values.includes(raw as T)) fail(name, `expected one of ${values.join(', ')}`);
    return raw as T;
};

const urlSchema = z.url();

const urlVar = (env: Env, name: string): string => {
    const raw = env[name];
    if (!raw) return fail(name, 'required');
    if (!urlSchema.safeParse(raw).success) fail(name, 'invalid URL');
    return raw.replace(/\/+$/, '');
};

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

/** Loads the full configuration from environment variables. */
export const loadConfig = (env: Env = process.env): Config => {
    const transport = enumVar(env, 'LOUPE_TRANSPORT', ['stdio', 'http'] as const, 'stdio');
    const port = intVar(env, 'LOUPE_PORT', 8080, 0);
    const host = env.LOUPE_HOST ?? (transport === 'http' ? '0.0.0.0' : '127.0.0.1');

    const authMode = enumVar(
        env,
        'LOUPE_AUTH',
        ['entra', 'entra-broker', 'none'] as const,
        transport === 'http' ? 'entra' : 'none'
    );
    if (authMode === 'none' && transport === 'http' && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
        fail('LOUPE_AUTH', "'none' is only allowed with stdio or a localhost bind (LOUPE_HOST)");
    }
    const entraAuth = authMode === 'entra' || authMode === 'entra-broker';
    if (entraAuth) {
        if (!env.LOUPE_AUTH_TENANT_ID) fail('LOUPE_AUTH_TENANT_ID', `required for ${authMode} auth`);
        if (!env.LOUPE_AUTH_CLIENT_ID) fail('LOUPE_AUTH_CLIENT_ID', `required for ${authMode} auth`);
    }
    // Workload identity (AKS) injects AZURE_FEDERATED_TOKEN_FILE; it doubles as the client assertion.
    const clientAssertionFile = env.LOUPE_AUTH_CLIENT_ASSERTION_FILE ?? env.AZURE_FEDERATED_TOKEN_FILE;
    if (authMode === 'entra-broker') {
        if (transport !== 'http') fail('LOUPE_AUTH', "'entra-broker' needs the http transport");
        if (!env.LOUPE_AUTH_CLIENT_SECRET && !env.LOUPE_AUTH_ASSERTION_IDENTITY && !clientAssertionFile) {
            fail(
                'LOUPE_AUTH_CLIENT_ASSERTION_FILE',
                'entra-broker needs a client assertion file, LOUPE_AUTH_ASSERTION_IDENTITY or LOUPE_AUTH_CLIENT_SECRET'
            );
        }
        if (!env.LOUPE_SIGNING_KEY)
            fail('LOUPE_SIGNING_KEY', 'required for entra-broker auth (it also seals OAuth tokens)');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.LOUPE_AUTH_TENANT_ID ?? '')) {
            fail('LOUPE_AUTH_TENANT_ID', 'entra-broker needs the tenant ID (GUID), not a domain');
        }
        const path = env.LOUPE_PUBLIC_URL ? new URL(env.LOUPE_PUBLIC_URL).pathname : '/';
        if (path !== '/' && path !== '') fail('LOUPE_PUBLIC_URL', 'entra-broker needs a URL without a path');
    }
    const redirectUris = (
        env.LOUPE_AUTH_REDIRECT_URIS ??
        'https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback'
    )
        .split(',')
        .map((uri) => uri.trim())
        .filter(Boolean);
    for (const uri of authMode === 'entra-broker' ? redirectUris : []) {
        if (!uri.startsWith('https://') || !urlSchema.safeParse(uri).success) {
            fail('LOUPE_AUTH_REDIRECT_URIS', `'${uri}' is not an https URL`);
        }
    }

    let publicUrl = env.LOUPE_PUBLIC_URL;
    if (transport === 'http' && entraAuth && !publicUrl) fail('LOUPE_PUBLIC_URL', 'required for http');
    if (publicUrl !== undefined && !urlSchema.safeParse(publicUrl).success) fail('LOUPE_PUBLIC_URL', 'invalid URL');
    publicUrl = (publicUrl ?? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`).replace(/\/+$/, '');

    const storeKind = enumVar(
        env,
        'LOUPE_STORE',
        ['azureblob', 'filesystem'] as const,
        transport === 'http' ? 'azureblob' : 'filesystem'
    );
    if (storeKind === 'azureblob' && !env.LOUPE_STORE_ACCOUNT_URL && !env.LOUPE_STORE_CONNECTION_STRING) {
        fail('LOUPE_STORE_ACCOUNT_URL', 'required for the azureblob store');
    }

    let signingKey: Buffer;
    let signingKeyGenerated = false;
    if (env.LOUPE_SIGNING_KEY) {
        signingKey = Buffer.from(env.LOUPE_SIGNING_KEY, 'utf8');
        if (signingKey.length < 32) fail('LOUPE_SIGNING_KEY', 'must be at least 32 bytes');
    } else {
        if (transport === 'http' && storeKind === 'azureblob') {
            fail('LOUPE_SIGNING_KEY', 'required when the store is shared across replicas');
        }
        signingKey = randomBytes(32);
        signingKeyGenerated = true;
    }

    const retentionMs = durationVar(env, 'LOUPE_RETENTION', 'P2D');
    const urlTtlMs = durationVar(env, 'LOUPE_URL_TTL', 'PT1H');
    const maxJobDurationMs = durationVar(env, 'LOUPE_MAX_JOB_DURATION', 'PT12H');
    if (retentionMs <= maxJobDurationMs + urlTtlMs) {
        fail('LOUPE_RETENTION', 'must exceed LOUPE_MAX_JOB_DURATION plus LOUPE_URL_TTL');
    }

    const maxPages = intVar(env, 'LOUPE_MAX_PAGES', 2000);

    return {
        transport,
        host,
        port,
        publicUrl,
        auth: {
            mode: authMode,
            tenantId: env.LOUPE_AUTH_TENANT_ID,
            clientId: env.LOUPE_AUTH_CLIENT_ID,
            requiredRole: env.LOUPE_AUTH_REQUIRED_ROLE ?? 'Loupe.User',
            scopeName: env.LOUPE_AUTH_SCOPE ?? 'Loupe.Access',
            clientSecret: env.LOUPE_AUTH_CLIENT_SECRET,
            clientAssertionFile,
            assertionIdentity: env.LOUPE_AUTH_ASSERTION_IDENTITY,
            redirectUris,
            accessTokenTtlMs: durationVar(env, 'LOUPE_AUTH_ACCESS_TOKEN_TTL', 'PT1H'),
            sessionTtlMs: durationVar(env, 'LOUPE_AUTH_SESSION_TTL', 'P30D'),
            issuer: env.LOUPE_AUTH_ISSUER,
            jwksUri: env.LOUPE_AUTH_JWKS_URI,
            authorizationServer: env.LOUPE_AUTH_AUTHORIZATION_SERVER,
        },
        store: {
            kind: storeKind,
            accountUrl: env.LOUPE_STORE_ACCOUNT_URL,
            connectionString: env.LOUPE_STORE_CONNECTION_STRING,
            container: env.LOUPE_STORE_CONTAINER ?? 'store',
            dir: env.LOUPE_STORE_DIR ?? './.loupe/store',
        },
        retentionMs,
        urlTtlMs,
        signingKey,
        signingKeyGenerated,
        documentIntelligence: {
            endpoint: urlVar(env, 'LOUPE_DOCUMENT_INTELLIGENCE_ENDPOINT'),
            key: env.LOUPE_DOCUMENT_INTELLIGENCE_KEY || undefined,
        },
        openai: { endpoint: urlVar(env, 'LOUPE_OPENAI_ENDPOINT'), key: env.LOUPE_OPENAI_KEY || undefined },
        vision: {
            model: env.LOUPE_VISION_MODEL || 'gpt-5.6-luna',
            reasoningEffort: enumVar(env, 'LOUPE_VISION_REASONING_EFFORT', REASONING_EFFORTS, 'medium'),
        },
        limits: {
            maxFileBytes: intVar(env, 'LOUPE_MAX_FILE_BYTES', 128 * 1024 * 1024),
            uploadMaxFiles: intVar(env, 'LOUPE_UPLOAD_MAX_FILES', 1000),
            uploadMaxBytes: intVar(env, 'LOUPE_UPLOAD_MAX_BYTES', 10 * 1024 ** 3),
            maxPages,
            accurateMaxPages: intVar(env, 'LOUPE_ACCURATE_MAX_PAGES', 100, 0),
            maxJobDurationMs,
            analysisConcurrency: intVar(env, 'LOUPE_ANALYSIS_CONCURRENCY', 4),
            visionConcurrency: intVar(env, 'LOUPE_VISION_CONCURRENCY', 8),
            maxActiveJobs: intVar(env, 'LOUPE_MAX_ACTIVE_JOBS', 8),
            readMaxBytes: intVar(env, 'LOUPE_READ_MAX_BYTES', 65_536, 1024),
        },
        auditLog: env.LOUPE_AUDIT_LOG ?? (transport === 'stdio' ? 'stderr' : 'stdout'),
        logLevel: env.LOUPE_LOG_LEVEL ?? 'info',
    };
};
