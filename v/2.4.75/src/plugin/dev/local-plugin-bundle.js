import { validatePluginManifest } from '../market/plugin-schema.js';
import { assertLocalPluginUrl } from './local-plugin-source.js';

const PLUGIN_MANIFEST_FILE = 'plugin.json';
const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getBasename(path) {
    const normalized = normalizeBundlePath(path);
    if (!normalized) return '';
    const segments = normalized.split('/');
    return segments[segments.length - 1] || '';
}

function getDirname(path) {
    const normalized = normalizeBundlePath(path);
    if (!normalized || !normalized.includes('/')) return '';
    return normalized.slice(0, normalized.lastIndexOf('/'));
}

function getTopLevelFolder(path) {
    const normalized = normalizeBundlePath(path);
    if (!normalized) return '';
    return normalized.split('/').filter(Boolean)[0] || '';
}

function splitSpecifierSuffix(specifier) {
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

function normalizeResolvedPath(baseSegments, rawPath) {
    const normalizedPath = String(rawPath || '').replace(/\\/g, '/');
    const segments = Array.isArray(baseSegments) ? [...baseSegments] : [];
    let escaped = 0;

    normalizedPath.split('/').forEach((segment) => {
        if (!segment || segment === '.') return;
        if (segment === '..') {
            if (segments.length > 0) {
                segments.pop();
            } else {
                escaped += 1;
            }
            return;
        }
        segments.push(segment);
    });

    return {
        path: segments.join('/'),
        escaped,
    };
}

function uniqueFileRecords(records) {
    const deduped = new Map();

    (Array.isArray(records) ? records : []).forEach((record) => {
        const path = normalizeBundlePath(record?.path);
        if (!path || !record?.file) return;
        if (!deduped.has(path)) {
            deduped.set(path, {
                path,
                file: record.file,
            });
        }
    });

    return Array.from(deduped.values());
}

function readFileFromEntry(entry) {
    return new Promise((resolve, reject) => {
        entry.file(
            (file) => resolve(file),
            (error) => reject(error || new Error(`Failed to read local plugin file "${entry.fullPath || entry.name || ''}"`))
        );
    });
}

async function readFileFromHandle(handle) {
    try {
        return await handle.getFile();
    } catch (error) {
        throw error || new Error(`Failed to read local plugin file "${handle?.name || ''}"`);
    }
}

function readDirectoryEntries(entry) {
    return new Promise((resolve, reject) => {
        const reader = entry.createReader();
        const entries = [];

        const readNext = () => {
            reader.readEntries(
                (batch) => {
                    if (!Array.isArray(batch) || batch.length === 0) {
                        resolve(entries);
                        return;
                    }

                    entries.push(...batch);
                    readNext();
                },
                (error) => reject(error || new Error(`Failed to read local plugin directory "${entry.fullPath || entry.name || ''}"`))
            );
        };

        readNext();
    });
}

async function walkDroppedEntry(entry, parentPath = '') {
    const entryName = normalizeString(entry?.name);
    const entryPath = normalizeBundlePath(parentPath ? `${parentPath}/${entryName}` : entryName);
    if (!entryPath) return [];

    if (entry?.isFile) {
        return [{
            path: entryPath,
            file: await readFileFromEntry(entry),
        }];
    }

    if (!entry?.isDirectory) {
        return [];
    }

    const children = await readDirectoryEntries(entry);
    const nestedRecords = await Promise.all(children.map((child) => walkDroppedEntry(child, entryPath)));
    return nestedRecords.flat();
}

async function readDirectoryHandleChildren(handle) {
    if (typeof handle?.values === 'function') {
        const children = [];
        for await (const childHandle of handle.values()) {
            children.push(childHandle);
        }
        return children;
    }

    if (typeof handle?.entries === 'function') {
        const children = [];
        for await (const entry of handle.entries()) {
            const value = Array.isArray(entry) ? entry[1] : entry;
            if (value) {
                children.push(value);
            }
        }
        return children;
    }

    return [];
}

async function walkFileSystemHandle(handle, parentPath = '') {
    const handleName = normalizeString(handle?.name);
    const handlePath = normalizeBundlePath(parentPath ? `${parentPath}/${handleName}` : handleName);
    if (!handlePath) return [];

    if (handle?.kind === 'file') {
        return [{
            path: handlePath,
            file: await readFileFromHandle(handle),
        }];
    }

    if (handle?.kind !== 'directory') {
        return [];
    }

    const children = await readDirectoryHandleChildren(handle);
    const nestedRecords = await Promise.all(children.map((child) => walkFileSystemHandle(child, handlePath)));
    return nestedRecords.flat();
}

function collectFileRecordsFromFileList(fileList) {
    return uniqueFileRecords(
        Array.from(fileList || []).map((file) => ({
            path: normalizeBundlePath(file.webkitRelativePath || file.name),
            file,
        }))
    );
}

async function collectDroppedFileRecords(dataTransfer) {
    if (!dataTransfer) return [];

    const handleRecords = [];
    const directFileRecords = [];
    const entryRecords = [];

    const items = Array.from(dataTransfer.items || []);
    for (const item of items) {
        if (item?.kind !== 'file') continue;

        if (typeof item.getAsFileSystemHandle === 'function') {
            try {
                const handle = await item.getAsFileSystemHandle();
                if (handle) {
                    handleRecords.push(...await walkFileSystemHandle(handle));
                    continue;
                }
            } catch {
                // Fall through to legacy entry / direct file handling.
            }
        }

        if (typeof item.webkitGetAsEntry === 'function') {
            const entry = item.webkitGetAsEntry();
            if (entry) {
                entryRecords.push(...await walkDroppedEntry(entry));
                continue;
            }
        }

        const file = item.getAsFile?.();
        if (!file) continue;
        directFileRecords.push({
            path: normalizeBundlePath(file.webkitRelativePath || file.name),
            file,
        });
    }

    return uniqueFileRecords([
        ...handleRecords,
        ...entryRecords,
        ...directFileRecords,
        ...collectFileRecordsFromFileList(dataTransfer.files),
    ]);
}

function resolveBundleRootPath(fileRecords) {
    const manifestRecords = fileRecords.filter((record) => getBasename(record.path).toLowerCase() === PLUGIN_MANIFEST_FILE);
    if (manifestRecords.length === 0) {
        throw new Error('The dropped files do not contain a plugin.json manifest');
    }
    if (manifestRecords.length > 1) {
        throw new Error('Multiple plugin.json files were found. Drag a single plugin folder instead');
    }

    return {
        rootPath: getDirname(manifestRecords[0].path),
        manifestPath: manifestRecords[0].path,
    };
}

function normalizeBundleFiles(files) {
    if (!isPlainObject(files)) return {};

    return Object.fromEntries(
        Object.entries(files)
            .map(([path, value]) => {
                const normalizedPath = normalizeBundlePath(path);
                if (!normalizedPath || !isPlainObject(value)) return null;

                return [normalizedPath, {
                    text: String(value.text ?? ''),
                    type: normalizeString(value.type),
                    size: Number(value.size) || 0,
                    lastModified: Number(value.lastModified) || 0,
                }];
            })
            .filter(Boolean)
    );
}

function resolveBundleSourceLabel(rootPath, manifest) {
    const explicitLabel = normalizeString(rootPath).split('/').filter(Boolean).pop();
    if (explicitLabel) return explicitLabel;
    return normalizeString(manifest?.displayName || manifest?.id, PLUGIN_MANIFEST_FILE);
}

function validateBundledEntryAvailability(manifest, bundleFiles) {
    const entry = normalizeString(manifest?.script?.entry);
    if (!entry) {
        throw new Error(`Script plugin "${manifest?.id || ''}" is missing script.entry`);
    }

    if (ABSOLUTE_URL_PATTERN.test(entry) || entry.startsWith('/')) {
        assertLocalPluginUrl(new URL(entry, window.location.href).toString());
        return;
    }

    const resolvedEntry = resolveLocalPluginBundleSpecifier(entry, PLUGIN_MANIFEST_FILE);
    if (resolvedEntry.kind !== 'bundle' || !bundleFiles[resolvedEntry.path]) {
        throw new Error(
            `Local plugin "${manifest?.id || ''}" is missing "${resolvedEntry.path || entry}". Drag the whole plugin folder instead`
        );
    }
}

export function normalizeBundlePath(value) {
    const normalized = String(value ?? '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+/g, '/')
        .trim();

    if (!normalized) return '';

    const segments = [];
    normalized.split('/').forEach((segment) => {
        if (!segment || segment === '.') return;
        if (segment === '..') {
            if (segments.length > 0) {
                segments.pop();
            }
            return;
        }
        segments.push(segment);
    });

    return segments.join('/');
}

export function resolveLocalPluginBundleSpecifier(specifier, fromFilePath = '') {
    const normalizedSpecifier = normalizeString(specifier);
    if (!normalizedSpecifier) {
        return { kind: 'invalid', specifier: '' };
    }

    if (normalizedSpecifier.startsWith('blob:') || normalizedSpecifier.startsWith('data:')) {
        return { kind: 'external', url: normalizedSpecifier };
    }

    if (ABSOLUTE_URL_PATTERN.test(normalizedSpecifier)) {
        return {
            kind: 'origin',
            url: assertLocalPluginUrl(new URL(normalizedSpecifier, window.location.href).toString()),
        };
    }

    if (normalizedSpecifier.startsWith('/')) {
        return {
            kind: 'origin',
            url: assertLocalPluginUrl(new URL(normalizedSpecifier, window.location.href).toString()),
        };
    }

    if (!normalizedSpecifier.startsWith('.')) {
        return {
            kind: 'bare',
            specifier: normalizedSpecifier,
        };
    }

    const { path: rawPath, suffix } = splitSpecifierSuffix(normalizedSpecifier);
    const baseSegments = getDirname(fromFilePath).split('/').filter(Boolean);
    const resolved = normalizeResolvedPath(baseSegments, rawPath);
    if (!resolved.path) {
        throw new Error(`Unsupported local plugin import "${specifier}"`);
    }

    if (resolved.escaped > 0) {
        return {
            kind: 'origin',
            url: assertLocalPluginUrl(new URL(`/${resolved.path}${suffix}`, window.location.href).toString()),
        };
    }

    return {
        kind: 'bundle',
        path: resolved.path,
        suffix,
    };
}

export function isLocalPluginBundlePackage(pluginPackage) {
    return isPlainObject(pluginPackage?.source?.bundle) && isPlainObject(pluginPackage?.source?.bundle?.files);
}

export function getLocalPluginBundleFiles(pluginPackage) {
    return normalizeBundleFiles(pluginPackage?.source?.bundle?.files);
}

async function buildLocalPluginBundleFromFileRecords(fileRecords) {
    if (fileRecords.length === 0) {
        throw new Error('No local plugin files were provided');
    }

    const { rootPath, manifestPath } = resolveBundleRootPath(fileRecords);
    const relevantRecords = fileRecords.filter((record) => {
        if (!rootPath) return true;
        return record.path === rootPath || record.path.startsWith(`${rootPath}/`);
    });

    const files = Object.create(null);
    for (const record of relevantRecords) {
        const relativePath = rootPath
            ? normalizeBundlePath(record.path.slice(rootPath.length + 1))
            : normalizeBundlePath(record.path);
        if (!relativePath) continue;

        files[relativePath] = {
            text: await record.file.text(),
            type: normalizeString(record.file.type),
            size: Number(record.file.size) || 0,
            lastModified: Number(record.file.lastModified) || 0,
        };
    }

    const manifestFile = files[PLUGIN_MANIFEST_FILE];
    if (!manifestFile?.text) {
        throw new Error('The local plugin bundle is missing plugin.json');
    }

    let payload = null;
    try {
        payload = JSON.parse(manifestFile.text);
    } catch (error) {
        throw new Error(`Failed to parse plugin.json: ${error?.message || String(error)}`);
    }

    const manifest = validatePluginManifest(payload);
    validateBundledEntryAvailability(manifest, files);
    const sourceRoot = rootPath || (
        manifestPath !== PLUGIN_MANIFEST_FILE
            ? getTopLevelFolder(manifestPath)
            : ''
    );

    return {
        manifest,
        sourceLabel: resolveBundleSourceLabel(sourceRoot, manifest),
        bundle: {
            manifestPath: PLUGIN_MANIFEST_FILE,
            files,
        },
    };
}

export async function readLocalPluginBundleFromDataTransfer(dataTransfer) {
    const fileRecords = await collectDroppedFileRecords(dataTransfer);
    return buildLocalPluginBundleFromFileRecords(fileRecords);
}

export async function readLocalPluginBundleFromFileList(fileList) {
    const fileRecords = collectFileRecordsFromFileList(fileList);
    return buildLocalPluginBundleFromFileRecords(fileRecords);
}
