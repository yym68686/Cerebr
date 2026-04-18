import { isExtensionEnvironment } from '../../utils/storage-adapter.js';
import {
    normalizeBundlePath,
    validateLocalShellPluginBundle,
} from '../dev/local-plugin-bundle.js';

const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;
const STATIC_IMPORT_PATTERN = /(import\s+(?:[^"'()]*?\s+from\s+)?)(['"])([^'"]+)\2/g;
const EXPORT_FROM_PATTERN = /(export\s+(?:[^"'()]*?\s+from\s+))(['"])([^'"]+)\2/g;
const DYNAMIC_IMPORT_PATTERN = /(import\s*\(\s*)(['"])([^'"]+)\2(\s*(?:,\s*[^)]*)?\))/g;

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function isJsonModulePath(modulePath, mimeType = '') {
    if (String(mimeType || '').toLowerCase().includes('json')) {
        return true;
    }
    return /\.json$/i.test(modulePath);
}

function isJavaScriptModulePath(modulePath, mimeType = '') {
    if (isJsonModulePath(modulePath, mimeType)) {
        return false;
    }

    const normalizedMimeType = normalizeString(mimeType).toLowerCase();
    if (normalizedMimeType.includes('javascript') || normalizedMimeType.includes('ecmascript')) {
        return true;
    }

    if (/\.(?:m?js|jsx|ts|tsx)$/i.test(modulePath)) {
        return true;
    }

    return !/\.[a-z0-9]+$/i.test(modulePath);
}

function decodeUrlPathname(pathname = '') {
    return pathname
        .split('/')
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        })
        .join('/');
}

function toOriginRelativePath(urlString = '') {
    const parsedUrl = new URL(urlString, globalThis.location?.href || 'https://cerebr.local/');
    return normalizeBundlePath(decodeUrlPathname(parsedUrl.pathname).replace(/^\/+/, ''));
}

function getDirname(path = '') {
    const normalizedPath = normalizeBundlePath(path);
    if (!normalizedPath.includes('/')) {
        return '';
    }
    return normalizedPath.slice(0, normalizedPath.lastIndexOf('/'));
}

function createRelativeBundleSpecifier(fromPath = '', toPath = '', suffix = '') {
    const fromSegments = getDirname(fromPath).split('/').filter(Boolean);
    const toSegments = normalizeBundlePath(toPath).split('/').filter(Boolean);
    let sharedLength = 0;

    while (
        sharedLength < fromSegments.length
        && sharedLength < toSegments.length
        && fromSegments[sharedLength] === toSegments[sharedLength]
    ) {
        sharedLength += 1;
    }

    const upwardSegments = new Array(fromSegments.length - sharedLength).fill('..');
    const downwardSegments = toSegments.slice(sharedLength);
    const relativePath = [...upwardSegments, ...downwardSegments].join('/');
    const normalizedRelativePath = relativePath || '.';
    const withDotPrefix = normalizedRelativePath.startsWith('.')
        ? normalizedRelativePath
        : `./${normalizedRelativePath}`;

    return `${withDotPrefix}${suffix}`;
}

function getResponseMimeType(response, path = '') {
    const contentType = normalizeString(response.headers.get('content-type'))
        .split(';')[0]
        .trim();
    if (contentType) {
        return contentType;
    }
    if (isJsonModulePath(path)) {
        return 'application/json';
    }
    return 'text/javascript';
}

function splitSpecifierSuffix(specifier = '') {
    const normalized = normalizeString(specifier);
    const separatorIndex = normalized.search(/[?#]/);
    if (separatorIndex < 0) {
        return {
            path: normalized,
            suffix: '',
        };
    }

    return {
        path: normalized.slice(0, separatorIndex),
        suffix: normalized.slice(separatorIndex),
    };
}

async function replaceAsync(source, pattern, replacer) {
    const matches = [];
    source.replace(pattern, (...args) => {
        matches.push(args);
        return args[0];
    });

    if (matches.length === 0) {
        return source;
    }

    const replacements = await Promise.all(matches.map((args) => replacer(...args)));
    let replacementIndex = 0;
    return source.replace(pattern, () => replacements[replacementIndex++]);
}

function resolveReviewedImportSpecifier(specifier, fromUrl, expectedOrigin) {
    const normalizedSpecifier = normalizeString(specifier);
    if (!normalizedSpecifier) {
        throw new Error('Reviewed marketplace script packages cannot import an empty specifier');
    }

    if (normalizedSpecifier.startsWith('data:') || normalizedSpecifier.startsWith('blob:')) {
        throw new Error(`Reviewed marketplace script packages must not import "${normalizedSpecifier}"`);
    }

    if (!normalizedSpecifier.startsWith('.')
        && !normalizedSpecifier.startsWith('/')
        && !ABSOLUTE_URL_PATTERN.test(normalizedSpecifier)) {
        throw new Error(`Reviewed marketplace script packages cannot import bare specifier "${normalizedSpecifier}"`);
    }

    const resolvedUrl = new URL(normalizedSpecifier, fromUrl);
    if (resolvedUrl.origin !== expectedOrigin) {
        throw new Error(
            `Reviewed marketplace script packages must stay on the same origin. Received "${normalizedSpecifier}"`
        );
    }

    return {
        url: resolvedUrl.toString(),
        path: toOriginRelativePath(resolvedUrl.toString()),
        suffix: `${resolvedUrl.search}${resolvedUrl.hash}`,
    };
}

function getBundleRecordSize(text = '') {
    if (typeof Blob !== 'undefined') {
        return new Blob([text], { type: 'text/plain;charset=utf-8' }).size;
    }

    if (typeof TextEncoder === 'function') {
        return new TextEncoder().encode(String(text ?? '')).length;
    }

    return String(text ?? '').length;
}

async function rewriteReviewedModuleSource(source, currentModuleUrl, currentModulePath, expectedOrigin, enqueueDependency) {
    let rewrittenSource = String(source ?? '');

    const rewriteSpecifier = async (specifier) => {
        const resolvedImport = resolveReviewedImportSpecifier(specifier, currentModuleUrl, expectedOrigin);
        await enqueueDependency(resolvedImport.url);
        return createRelativeBundleSpecifier(currentModulePath, resolvedImport.path, resolvedImport.suffix);
    };

    rewrittenSource = await replaceAsync(
        rewrittenSource,
        STATIC_IMPORT_PATTERN,
        async (match, prefix, quote, specifier) => `${prefix}${JSON.stringify(await rewriteSpecifier(specifier))}`
    );

    rewrittenSource = await replaceAsync(
        rewrittenSource,
        EXPORT_FROM_PATTERN,
        async (match, prefix, quote, specifier) => `${prefix}${JSON.stringify(await rewriteSpecifier(specifier))}`
    );

    rewrittenSource = await replaceAsync(
        rewrittenSource,
        DYNAMIC_IMPORT_PATTERN,
        async (match, prefix, quote, specifier, suffix) => {
            return `${prefix}${JSON.stringify(await rewriteSpecifier(specifier))}${suffix}`;
        }
    );

    return rewrittenSource;
}

async function fetchReviewedBundleFiles(entryUrl, expectedOrigin) {
    const files = {};
    const queuedUrls = new Set();
    const pendingUrls = [entryUrl];

    const enqueueDependency = async (urlString) => {
        const normalizedUrl = normalizeString(urlString);
        if (!normalizedUrl || queuedUrls.has(normalizedUrl)) {
            return;
        }
        queuedUrls.add(normalizedUrl);
        pendingUrls.push(normalizedUrl);
    };

    await enqueueDependency(entryUrl);

    while (pendingUrls.length > 0) {
        const currentUrl = pendingUrls.pop();
        const response = await fetch(currentUrl, {
            cache: 'no-store',
            credentials: 'omit',
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch reviewed script module "${currentUrl}": HTTP ${response.status}`);
        }

        const currentPath = toOriginRelativePath(currentUrl);
        const mimeType = getResponseMimeType(response, currentPath);
        const sourceText = await response.text();
        const rewrittenSource = isJavaScriptModulePath(currentPath, mimeType)
            ? await rewriteReviewedModuleSource(
                sourceText,
                currentUrl,
                currentPath,
                expectedOrigin,
                enqueueDependency
            )
            : sourceText;

        files[currentPath] = {
            text: rewrittenSource,
            type: mimeType,
            size: getBundleRecordSize(rewrittenSource),
            lastModified: 0,
        };
    }

    return files;
}

export async function materializeReviewedScriptPluginPackage(manifest = {}, manifestUrl = '') {
    const pluginId = normalizeString(manifest?.id);
    const normalizedManifestUrl = normalizeString(manifestUrl);

    if (manifest?.kind !== 'script') {
        return manifest;
    }
    if (!pluginId) {
        throw new Error('Reviewed script plugin packaging requires manifest.id');
    }
    if (!normalizedManifestUrl) {
        throw new Error(`Reviewed script plugin "${pluginId}" is missing its manifest URL`);
    }

    const parsedManifestUrl = new URL(normalizedManifestUrl, globalThis.location?.href || 'https://cerebr.local/');
    const expectedOrigin = parsedManifestUrl.origin;
    const manifestPath = toOriginRelativePath(parsedManifestUrl.toString());
    const entryUrl = normalizeString(manifest?.script?.entry);
    if (!entryUrl) {
        throw new Error(`Reviewed script plugin "${pluginId}" is missing script.entry`);
    }

    const entryPath = toOriginRelativePath(entryUrl);
    const files = await fetchReviewedBundleFiles(entryUrl, expectedOrigin);
    const bundledManifest = {
        ...manifest,
        script: {
            ...manifest.script,
            entry: createRelativeBundleSpecifier(manifestPath, entryPath),
        },
        source: {
            manifestUrl: parsedManifestUrl.toString(),
            sourceLabel: normalizeString(manifest?.displayName, pluginId),
            mode: isExtensionEnvironment && normalizeString(manifest?.scope) === 'shell'
                ? 'guest'
                : 'bundle',
            bundle: {
                manifestPath,
                files: {},
            },
        },
    };

    files[manifestPath] = {
        text: JSON.stringify(bundledManifest, null, 2),
        type: 'application/json',
        size: 0,
        lastModified: 0,
    };
    files[manifestPath].size = getBundleRecordSize(files[manifestPath].text);
    bundledManifest.source.bundle.files = files;

    if (bundledManifest.scope === 'shell') {
        validateLocalShellPluginBundle(bundledManifest, files, manifestPath);
    }

    return bundledManifest;
}
