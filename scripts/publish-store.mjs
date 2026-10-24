import { createHmac, createSign, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chromeRoot = 'https://chromewebstore.googleapis.com';
const edgeRoot = 'https://api.addons.microsoftedge.microsoft.com';
const firefoxRoot = 'https://addons.mozilla.org/api/v5';

export function firefoxToken(key, secret, now = Math.floor(Date.now() / 1000)) {
    const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: key, jti: randomUUID(), iat: now, exp: now + 60 })}`;
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function chromeAssertion(credentials, now = Math.floor(Date.now() / 1000)) {
    const body = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
        iss: credentials.client_email,
        scope: 'https://www.googleapis.com/auth/chromewebstore',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
    })}`;
    return `${body}.${createSign('RSA-SHA256').update(body).sign(credentials.private_key, 'base64url')}`;
}

export function redact(message, secrets = []) {
    let text = String(message);
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
        text = text.split(secret).join('[REDACTED]');
    return text.replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[REDACTED]');
}

export function createClient({ fetchImpl = fetch, sleep = delay, secrets = [] } = {}) {
    const request = async (url, options = {}) => {
        const { allow404 = false, ...init } = options;
        // Only reads are retried: a timed-out POST may already have been accepted.
        for (let attempt = 0; ; attempt++) {
            const response = await fetchImpl(url, {
                ...init,
                redirect: 'error',
                signal: AbortSignal.timeout(120000),
            });
            if (
                (init.method || 'GET') === 'GET' &&
                [429, 502, 503, 504].includes(response.status) &&
                attempt < 3
            ) {
                await sleep(5000 * (attempt + 1));
                continue;
            }
            const text = await response.text();
            let data;
            try {
                data = text ? JSON.parse(text) : {};
            } catch {
                data = { message: text.slice(0, 2000) };
            }
            if (allow404 && response.status === 404) return null;
            if (!response.ok) {
                const authorization = new Headers(init.headers).get('authorization');
                const assertion = init.body instanceof URLSearchParams ? init.body.get('assertion') : null;
                throw new Error(
                    redact(`HTTP ${response.status}: ${JSON.stringify(data)}`, [
                        ...secrets,
                        authorization,
                        authorization?.split(' ').slice(1).join(' '),
                        assertion,
                    ])
                );
            }
            return { data, headers: response.headers, status: response.status };
        }
    };
    const poll = async (read, done, label) => {
        for (let attempt = 0; attempt < 90; attempt++) {
            const value = await read();
            if (done(value)) return value;
            await sleep(5000);
        }
        throw new Error(`${label} timed out; inspect the store dashboard before retrying.`);
    };
    return { request, poll };
}

export async function publishChrome({ client, credentials, publisherId, itemId, version, archive }) {
    const assertion = chromeAssertion(credentials);
    const { data: auth } = await client.request('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!auth.access_token) throw new Error('Chrome did not return an access token');
    const headers = { Authorization: `Bearer ${auth.access_token}` };
    const item = `/v2/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;
    const status = async () => (await client.request(`${chromeRoot}${item}:fetchStatus`, { headers })).data;
    const initial = await status();
    const contains = (revision) =>
        revision?.distributionChannels?.some((channel) => channel.crxVersion === version);
    if (contains(initial.publishedItemRevisionStatus)) return { state: 'published', version };
    const pending = initial.submittedItemRevisionStatus;
    if (pending && ['PENDING_REVIEW', 'STAGED'].includes(pending.state)) {
        if (contains(pending)) return { state: pending.state, version };
        throw new Error('Chrome has another version under review; retry this release after it finishes.');
    }
    const { data: upload } = await client.request(`${chromeRoot}/upload${item}:upload`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/zip' },
        body: archive,
    });
    let uploadState = upload.uploadState;
    if (['IN_PROGRESS', 'UPLOAD_IN_PROGRESS'].includes(uploadState)) {
        const completed = await client.poll(
            status,
            (value) =>
                value.lastAsyncUploadState &&
                !['IN_PROGRESS', 'UPLOAD_IN_PROGRESS'].includes(value.lastAsyncUploadState),
            'Chrome upload'
        );
        uploadState = completed.lastAsyncUploadState;
    }
    if (!['SUCCEEDED', 'SUCCESS'].includes(uploadState))
        throw new Error(`Chrome upload failed: ${uploadState}`);
    if (upload.crxVersion && upload.crxVersion !== version)
        throw new Error('Chrome uploaded version does not match the release');
    const { data: result } = await client.request(`${chromeRoot}${item}:publish`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
    });
    if (!['PENDING_REVIEW', 'PUBLISHED', 'STAGED', 'PUBLISHED_TO_TESTERS'].includes(result.state))
        throw new Error(`Unexpected Chrome submission state: ${result.state}`);
    return { state: result.state, version, warnings: result.warningInfo?.warnings };
}

export function edgeOperationUrl(location, prefix) {
    if (!location) throw new Error('Edge did not return an operation ID');
    if (/^[a-zA-Z0-9-]+$/.test(location)) return `${prefix}/operations/${location}`;
    const url = new URL(location, edgeRoot);
    if (url.origin !== edgeRoot || !url.href.startsWith(`${prefix}/operations/`))
        throw new Error('Unexpected Edge operation URL');
    return url.href;
}

export async function publishEdge({
    client,
    clientId,
    apiKey,
    productId,
    version,
    archive,
    checkpoint = {},
    save = async () => {},
}) {
    if (checkpoint.version && (checkpoint.version !== version || checkpoint.productId !== productId))
        throw new Error('Edge checkpoint belongs to another version or product');
    const state = { ...checkpoint, version, productId };
    const headers = { Authorization: `ApiKey ${apiKey}`, 'X-ClientID': clientId };
    const base = `${edgeRoot}/v1/products/${encodeURIComponent(productId)}/submissions`;
    const wait = (url) =>
        client.poll(
            async () => (await client.request(url, { headers })).data,
            (result) => {
                if (result.status === 'Succeeded') return true;
                if (result.status !== 'InProgress')
                    throw new Error(`Edge operation failed: ${JSON.stringify(result)}`);
                return false;
            },
            'Edge operation'
        );
    if (state.publishOperation) {
        await wait(edgeOperationUrl(state.publishOperation, base));
        return { state: 'submitted', version, operation: state.publishOperation };
    }
    if (!state.uploadOperation) {
        const upload = await client.request(`${base}/draft/package`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/zip' },
            body: archive,
        });
        state.uploadOperation = edgeOperationUrl(upload.headers.get('location'), `${base}/draft/package`);
        await save(state);
    }
    await wait(edgeOperationUrl(state.uploadOperation, `${base}/draft/package`));
    const result = await client.request(base, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            notes: `Cerebr ${version}. Built from the matching GitHub release tag at https://github.com/yym68686/Cerebr.`,
        }),
    });
    state.publishOperation = edgeOperationUrl(result.headers.get('location'), base);
    await save(state);
    await wait(state.publishOperation);
    return { state: 'submitted', version, operation: state.publishOperation };
}

export async function publishFirefox({ client, key, secret, addonId, version, archive, source }) {
    const headers = () => ({ Authorization: `JWT ${firefoxToken(key, secret)}` });
    const base = `${firefoxRoot}/addons/addon/${encodeURIComponent(addonId)}/versions/`;
    const existing = await client.request(`${base}${encodeURIComponent(version)}/`, {
        headers: headers(),
        allow404: true,
    });
    if (existing) {
        if (
            existing.data.channel !== 'listed' ||
            !['public', 'unreviewed'].includes(existing.data.file?.status)
        )
            throw new Error(
                `Firefox version already exists in state ${existing.data.file?.status}; inspect AMO.`
            );
        if (!existing.data.source) {
            const form = new FormData();
            form.set(
                'source',
                new Blob([source], { type: 'application/zip' }),
                `cerebr-${version}-source.zip`
            );
            await client.request(`${base}${version}/`, { method: 'PATCH', headers: headers(), body: form });
        }
        return { state: existing.data.file.status, version };
    }
    const form = new FormData();
    form.set('channel', 'listed');
    form.set('upload', new Blob([archive], { type: 'application/zip' }), 'cerebr-firefox.zip');
    const { data: upload } = await client.request(`${firefoxRoot}/addons/upload/`, {
        method: 'POST',
        headers: headers(),
        body: form,
    });
    if (!upload.uuid) throw new Error('Firefox did not return an upload ID');
    const validation = await client.poll(
        async () =>
            (
                await client.request(`${firefoxRoot}/addons/upload/${encodeURIComponent(upload.uuid)}/`, {
                    headers: headers(),
                })
            ).data,
        (value) => value.processed,
        'Firefox validation'
    );
    if (!validation.valid)
        throw new Error(`Firefox validation failed: ${JSON.stringify(validation.validation)}`);
    if (validation.version !== version)
        throw new Error('Firefox uploaded version does not match the release');
    const submission = new FormData();
    submission.set('upload', upload.uuid);
    submission.set('source', new Blob([source], { type: 'application/zip' }), `cerebr-${version}-source.zip`);
    const { data: result } = await client.request(base, {
        method: 'POST',
        headers: headers(),
        body: submission,
    });
    if (result.version !== version || result.channel !== 'listed')
        throw new Error('Unexpected Firefox version response');
    return { state: result.file?.status || 'submitted', version, editUrl: result.edit_url };
}

async function main() {
    const store = process.argv[2],
        env = process.env;
    if (!['chrome', 'edge', 'firefox'].includes(store))
        throw new Error('Usage: node scripts/publish-store.mjs chrome|edge|firefox');
    const required = (name) => {
        if (!env[name]) throw new Error(`Missing ${name}`);
        return env[name];
    };
    const version = JSON.parse(await readFile('package.json', 'utf8')).version;
    if (required('RELEASE_TAG') !== `v${version}`)
        throw new Error('Release tag does not match the checkout version');
    const archivePath = path.resolve('artifacts', store === 'firefox' ? 'cerebr-firefox.zip' : 'cerebr.zip');
    const manifest = JSON.parse((await execute('unzip', ['-p', archivePath, 'manifest.json'])).stdout);
    if (manifest.version !== version) throw new Error('Archive version does not match the release');
    const archive = await readFile(archivePath);
    const secrets = [
        env.EDGE_API_KEY,
        env.EDGE_CLIENT_ID,
        env.FIREFOX_API_KEY,
        env.FIREFOX_API_SECRET,
        env.CHROME_SERVICE_ACCOUNT_JSON,
    ];
    const client = createClient({ secrets });
    let result;
    try {
        if (store === 'chrome')
            result = await publishChrome({
                client,
                version,
                archive,
                credentials: JSON.parse(required('CHROME_SERVICE_ACCOUNT_JSON')),
                publisherId: required('CHROME_PUBLISHER_ID'),
                itemId: required('CHROME_EXTENSION_ID'),
            });
        else if (store === 'edge') {
            const checkpointPath = 'artifacts/store-state/edge.json';
            let checkpoint;
            try {
                checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            result = await publishEdge({
                client,
                version,
                archive,
                checkpoint,
                clientId: required('EDGE_CLIENT_ID'),
                apiKey: required('EDGE_API_KEY'),
                productId: required('EDGE_PRODUCT_ID'),
                save: async (data) => {
                    await mkdir(path.dirname(checkpointPath), { recursive: true });
                    await writeFile(checkpointPath, JSON.stringify(data));
                },
            });
        } else {
            const addonId = required('FIREFOX_ADDON_ID');
            if (manifest.browser_specific_settings?.gecko?.id !== addonId)
                throw new Error('Firefox add-on ID does not match the package');
            result = await publishFirefox({
                client,
                version,
                archive,
                addonId,
                key: required('FIREFOX_API_KEY'),
                secret: required('FIREFOX_API_SECRET'),
                source: await readFile('artifacts/cerebr-source.zip'),
            });
        }
        console.log(JSON.stringify({ store, ...result }));
        if (env.GITHUB_STEP_SUMMARY)
            await appendFile(
                env.GITHUB_STEP_SUMMARY,
                `\n${store}: ${version} — ${result.state}. Submission success does not guarantee store approval.\n`
            );
    } catch (error) {
        throw new Error(redact(error.message, secrets));
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
