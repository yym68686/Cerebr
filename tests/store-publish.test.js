// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import {
    chromeAssertion,
    firefoxToken,
    createClient,
    publishChrome,
    publishEdge,
    publishFirefox,
    edgeOperationUrl,
    redact,
} from '../scripts/publish-store.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = {
    client_email: 'publisher@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};
const version = '2.6.18',
    archive = Buffer.from('archive'),
    source = Buffer.from('source');
const response = (data, status = 200, headers = {}) =>
    new Response(JSON.stringify(data), { status, headers });
function clientFor(...responses) {
    const fetchImpl = vi.fn();
    for (const value of responses) fetchImpl.mockResolvedValueOnce(value);
    return { fetchImpl, client: createClient({ fetchImpl, sleep: async () => {} }) };
}
const chrome = (client) =>
    publishChrome({ client, credentials, publisherId: 'publisher', itemId: 'item', version, archive });
const edge = (client, options = {}) =>
    publishEdge({
        client,
        clientId: 'client',
        apiKey: 'secret',
        productId: 'product',
        version,
        archive,
        ...options,
    });
const firefox = (client) =>
    publishFirefox({
        client,
        key: 'issuer',
        secret: 'secret',
        addonId: 'addon@example.com',
        version,
        archive,
        source,
    });

it('signs service account and AMO JWTs with the expected audience, scope and lifetime', () => {
    const jwt = chromeAssertion(credentials, 100),
        [head, payload, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(payload, 'base64url'))).toMatchObject({
        iat: 100,
        exp: 3700,
        aud: 'https://oauth2.googleapis.com/token',
        scope: 'https://www.googleapis.com/auth/chromewebstore',
    });
    expect(createVerify('RSA-SHA256').update(`${head}.${payload}`).verify(publicKey, sig, 'base64url')).toBe(
        true
    );
    const token = firefoxToken('issuer', 'secret', 100),
        parts = token.split('.');
    expect(JSON.parse(Buffer.from(parts[1], 'base64url'))).toMatchObject({
        iss: 'issuer',
        iat: 100,
        exp: 160,
    });
    expect(parts[2]).toBe(
        createHmac('sha256', 'secret').update(parts.slice(0, 2).join('.')).digest('base64url')
    );
    expect(firefoxToken('issuer', 'secret', 100)).not.toBe(token);
});

it('waits for Chrome upload completion before submitting and reports review rather than publication', async () => {
    const { client, fetchImpl } = clientFor(
        response({ access_token: 'token' }),
        response({}),
        response({ uploadState: 'UPLOAD_IN_PROGRESS' }),
        response({ lastAsyncUploadState: 'UPLOAD_IN_PROGRESS' }),
        response({ lastAsyncUploadState: 'SUCCESS' }),
        response({ state: 'PENDING_REVIEW' })
    );
    expect(await chrome(client)).toMatchObject({ state: 'PENDING_REVIEW', version });
    expect(fetchImpl.mock.calls[2][1].body).toEqual(archive);
    expect(fetchImpl.mock.calls.at(-1)[0]).toMatch(/:publish$/);
});

it.each(['publishedItemRevisionStatus', 'submittedItemRevisionStatus'])(
    'does not re-upload an existing Chrome version in %s',
    async (field) => {
        const { client, fetchImpl } = clientFor(
            response({ access_token: 'token' }),
            response({
                [field]: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: version }] },
            })
        );
        await chrome(client);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
);

it('refuses to overwrite a different Chrome version under review or publish a failed upload', async () => {
    const busy = clientFor(
        response({ access_token: 'token' }),
        response({
            submittedItemRevisionStatus: {
                state: 'PENDING_REVIEW',
                distributionChannels: [{ crxVersion: '2.6.17' }],
            },
        })
    );
    await expect(chrome(busy.client)).rejects.toThrow('another version under review');
    const failed = clientFor(
        response({ access_token: 'token' }),
        response({}),
        response({ uploadState: 'FAILURE' })
    );
    await expect(chrome(failed.client)).rejects.toThrow('Chrome upload failed');
    expect(failed.fetchImpl).toHaveBeenCalledTimes(3);
});

it('persists Edge operations and resumes submission without uploading twice', async () => {
    const save = vi.fn(async () => {});
    const { client } = clientFor(
        response({}, 202, { location: 'upload-id' }),
        response({ status: 'InProgress' }),
        response({ status: 'Succeeded' }),
        response({}, 202, { location: 'publish-id' }),
        response({ status: 'Succeeded' })
    );
    expect(await edge(client, { save })).toMatchObject({ state: 'submitted', version });
    expect(save).toHaveBeenCalledTimes(2);
    const checkpoint = save.mock.calls.at(-1)[0];
    expect(JSON.stringify(checkpoint)).not.toContain('secret');
    const retry = clientFor(response({ status: 'Succeeded' }));
    await edge(retry.client, { checkpoint });
    expect(retry.fetchImpl).toHaveBeenCalledTimes(1);
    expect(retry.fetchImpl.mock.calls[0][1].method).toBeUndefined();
});

it('does not submit to Edge after an upload validation failure', async () => {
    const { client, fetchImpl } = clientFor(
        response({}, 202, { location: 'upload-id' }),
        response({ status: 'Failed', errorCode: 'InvalidManifest' })
    );
    await expect(edge(client)).rejects.toThrow('InvalidManifest');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('rejects unrelated Edge checkpoint or operation locations before sending credentials there', async () => {
    const prefix = 'https://api.addons.microsoftedge.microsoft.com/v1/products/product/submissions';
    expect(() => edgeOperationUrl('https://other.example/operations/id', prefix)).toThrow('Unexpected');
    expect(() => edgeOperationUrl('/v1/products/other/submissions/operations/id', prefix)).toThrow(
        'Unexpected'
    );
    const { client, fetchImpl } = clientFor();
    await expect(edge(client, { checkpoint: { version: '2.6.1', productId: 'product' } })).rejects.toThrow(
        'another version'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
});

it('uploads Firefox as listed and includes source in version creation', async () => {
    const { client, fetchImpl } = clientFor(
        response({}, 404),
        response({ uuid: 'upload' }),
        response({ processed: false }),
        response({ processed: true, valid: true, version }),
        response({ channel: 'listed', version, file: { status: 'unreviewed' } })
    );
    expect(await firefox(client)).toMatchObject({ state: 'unreviewed', version });
    const upload = fetchImpl.mock.calls[1][1].body;
    expect(upload.get('channel')).toBe('listed');
    expect(await upload.get('upload').text()).toBe('archive');
    const submitted = fetchImpl.mock.calls.at(-1)[1].body;
    expect(submitted.get('upload')).toBe('upload');
    expect(await submitted.get('source').text()).toBe('source');
});

it('stops on Firefox validation failure without creating a version', async () => {
    const { client, fetchImpl } = clientFor(
        response({}, 404),
        response({ uuid: 'upload' }),
        response({ processed: true, valid: false, validation: { errors: ['Invalid manifest'] } })
    );
    await expect(firefox(client)).rejects.toThrow('Invalid manifest');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it('repairs missing Firefox sources on retry without creating a duplicate version', async () => {
    const { client, fetchImpl } = clientFor(
        response({ channel: 'listed', file: { status: 'unreviewed' }, source: null }),
        response({})
    );
    await firefox(client);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1].method).toBe('PATCH');
    expect(await fetchImpl.mock.calls[1][1].body.get('source').text()).toBe('source');
});

it('never retries ambiguous POST failures and strips echoed secrets from diagnostics', async () => {
    const fetchImpl = vi.fn(async () => response({ message: 'invalid secret-with.!punctuation' }, 503));
    const client = createClient({ fetchImpl, sleep: async () => {}, secrets: ['secret-with.!punctuation'] });
    await expect(client.request('https://example.com', { method: 'POST' })).rejects.toThrow('[REDACTED]');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(redact('secret-with.!punctuation', ['secret-with.!punctuation'])).toBe('[REDACTED]');
});
