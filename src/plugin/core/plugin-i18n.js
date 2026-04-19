import {
    detectSystemLocale,
    getLanguagePreference,
    LANGUAGE_AUTO,
    LANGUAGE_PREFERENCE_KEY,
} from '../../utils/i18n.js';
import { normalizeString } from './runtime-utils.js';

const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

function normalizeSubstitutions(substitutions = []) {
    if (Array.isArray(substitutions)) {
        return substitutions;
    }
    if (typeof substitutions === 'undefined' || substitutions === null) {
        return [];
    }
    return [substitutions];
}

function applySubstitutions(message, substitutions = []) {
    let output = String(message ?? '');
    normalizeSubstitutions(substitutions).forEach((value, index) => {
        output = output.split(`$${index + 1}`).join(String(value ?? ''));
    });
    return output;
}

function normalizeLanguageSegment(segment = '') {
    return normalizeString(segment).toLowerCase();
}

function normalizeRegionSegment(segment = '') {
    const normalized = normalizeString(segment);
    if (!normalized) {
        return '';
    }
    if (normalized.length === 4) {
        return normalized[0].toUpperCase() + normalized.slice(1).toLowerCase();
    }
    if (/^\d+$/.test(normalized)) {
        return normalized;
    }
    return normalized.toUpperCase();
}

function normalizeLocaleSegments(segments = []) {
    const filtered = segments
        .map((segment) => normalizeString(segment))
        .filter(Boolean);

    if (filtered.length === 0) {
        return '';
    }

    return filtered
        .map((segment, index) => {
            if (index === 0) {
                return normalizeLanguageSegment(segment);
            }
            return normalizeRegionSegment(segment);
        })
        .join('-');
}

export function normalizePluginLocaleTag(value, fallback = '') {
    const normalizedValue = normalizeString(value);
    if (!normalizedValue) {
        return normalizeString(fallback);
    }

    const segments = normalizedValue
        .replace(/_/g, '-')
        .split('-')
        .map((segment) => normalizeString(segment))
        .filter(Boolean);

    return normalizeLocaleSegments(segments) || normalizeString(fallback);
}

function normalizePluginMessageTable(table = {}) {
    if (!table || typeof table !== 'object' || Array.isArray(table)) {
        return null;
    }

    const normalized = Object.fromEntries(
        Object.entries(table)
            .map(([key, value]) => {
                const normalizedKey = normalizeString(key);
                if (!normalizedKey) {
                    return null;
                }

                if (typeof value === 'string') {
                    return [normalizedKey, value];
                }

                if (value && typeof value === 'object' && typeof value.message === 'string') {
                    return [normalizedKey, value.message];
                }

                return null;
            })
            .filter(Boolean)
    );

    return Object.keys(normalized).length > 0
        ? normalized
        : null;
}

function normalizePluginLocaleMessages(messages = {}) {
    if (!messages || typeof messages !== 'object' || Array.isArray(messages)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(messages)
            .map(([locale, table]) => {
                const normalizedLocale = normalizePluginLocaleTag(locale);
                const normalizedTable = normalizePluginMessageTable(table);
                if (!normalizedLocale || !normalizedTable) {
                    return null;
                }

                return [normalizedLocale, normalizedTable];
            })
            .filter(Boolean)
    );
}

function resolveLocaleRef(ref = '', sourceUrl = '') {
    const normalizedRef = normalizeString(ref);
    if (!normalizedRef) {
        return '';
    }

    if (!sourceUrl) {
        return normalizedRef;
    }

    const resolvedUrl = new URL(normalizedRef, sourceUrl).toString();
    const sourceOrigin = new URL(sourceUrl, globalThis.location?.href || 'https://cerebr.local/').origin;
    const resolvedOrigin = new URL(resolvedUrl, sourceUrl).origin;
    if (sourceOrigin !== resolvedOrigin) {
        throw new Error(`Plugin locale resource "${normalizedRef}" must stay on the same origin as plugin.json`);
    }

    return resolvedUrl;
}

function normalizePluginLocaleRefs(locales = {}, { sourceUrl = '' } = {}) {
    if (!locales || typeof locales !== 'object' || Array.isArray(locales)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(locales)
            .map(([locale, ref]) => {
                const normalizedLocale = normalizePluginLocaleTag(locale);
                const normalizedRef = typeof ref === 'string'
                    ? resolveLocaleRef(ref, sourceUrl)
                    : '';
                if (!normalizedLocale || !normalizedRef) {
                    return null;
                }

                return [normalizedLocale, normalizedRef];
            })
            .filter(Boolean)
    );
}

export function normalizePluginI18nConfig(value = null, { sourceUrl = '' } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const messages = normalizePluginLocaleMessages(value.messages);
    const locales = normalizePluginLocaleRefs(value.locales, {
        sourceUrl,
    });
    const explicitDefaultLocale = normalizePluginLocaleTag(value.defaultLocale);
    const defaultLocale = explicitDefaultLocale
        || Object.keys(messages)[0]
        || Object.keys(locales)[0]
        || '';

    if (!defaultLocale && Object.keys(messages).length === 0 && Object.keys(locales).length === 0) {
        return null;
    }

    return {
        defaultLocale,
        locales,
        messages,
    };
}

function resolveBundleRelativePath(specifier = '', manifestPath = 'plugin.json') {
    const normalizedSpecifier = normalizeString(specifier);
    if (!normalizedSpecifier) {
        return '';
    }

    if (ABSOLUTE_URL_PATTERN.test(normalizedSpecifier) || normalizedSpecifier.startsWith('data:')) {
        return '';
    }

    const [pathPart] = normalizedSpecifier.split(/[?#]/, 1);
    const isAbsolutePath = pathPart.startsWith('/');
    const baseSegments = isAbsolutePath
        ? []
        : normalizeString(manifestPath, 'plugin.json')
            .split('/')
            .filter(Boolean)
            .slice(0, -1);
    const segments = isAbsolutePath
        ? pathPart.split('/').filter(Boolean)
        : pathPart.split('/');
    const resolved = [...baseSegments];

    segments.forEach((segment) => {
        if (!segment || segment === '.') {
            return;
        }
        if (segment === '..') {
            if (resolved.length > 0) {
                resolved.pop();
            }
            return;
        }
        resolved.push(segment);
    });

    return resolved.join('/');
}

function parsePluginMessagesJson(json, locale, refLabel) {
    let payload = null;
    try {
        payload = JSON.parse(json);
    } catch (error) {
        throw new Error(
            `Failed to parse plugin locale "${locale}" from "${refLabel}": ${error?.message || String(error)}`
        );
    }

    const normalizedTable = normalizePluginMessageTable(payload);
    if (!normalizedTable) {
        throw new Error(`Plugin locale "${locale}" from "${refLabel}" must be a key/message object`);
    }

    return normalizedTable;
}

export async function materializePluginI18n(manifest = {}, {
    bundleFiles = null,
    manifestPath = 'plugin.json',
    fetcher = null,
} = {}) {
    const normalizedManifest = manifest && typeof manifest === 'object'
        ? manifest
        : {};
    const i18n = normalizedManifest.i18n && typeof normalizedManifest.i18n === 'object'
        ? normalizedManifest.i18n
        : null;
    if (!i18n) {
        return normalizedManifest;
    }

    const localeRefs = i18n.locales && typeof i18n.locales === 'object'
        ? i18n.locales
        : {};
    if (Object.keys(localeRefs).length === 0) {
        return normalizedManifest;
    }

    const nextMessages = {
        ...(i18n.messages && typeof i18n.messages === 'object'
            ? i18n.messages
            : {}),
    };

    const effectiveFetcher = typeof fetcher === 'function'
        ? fetcher
        : (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

    for (const [locale, ref] of Object.entries(localeRefs)) {
        if (nextMessages[locale] && Object.keys(nextMessages[locale]).length > 0) {
            continue;
        }

        let localeJson = '';
        const bundlePath = bundleFiles && typeof bundleFiles === 'object'
            ? resolveBundleRelativePath(ref, manifestPath)
            : '';
        if (bundlePath && bundleFiles?.[bundlePath]) {
            localeJson = String(bundleFiles[bundlePath]?.text ?? '');
        } else {
            if (!effectiveFetcher) {
                continue;
            }

            const response = await effectiveFetcher(ref, {
                cache: 'no-store',
                credentials: 'omit',
            });
            if (!response?.ok) {
                throw new Error(`Failed to fetch plugin locale "${locale}" from "${ref}": HTTP ${response?.status}`);
            }
            localeJson = await response.text();
        }

        nextMessages[locale] = parsePluginMessagesJson(localeJson, locale, bundlePath || ref);
    }

    return {
        ...normalizedManifest,
        i18n: {
            ...i18n,
            messages: nextMessages,
        },
    };
}

function getLocaleCandidates(locale = '', defaultLocale = '') {
    const seen = new Set();
    const candidates = [];

    const addCandidate = (value) => {
        const normalized = normalizePluginLocaleTag(value);
        if (!normalized || seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        candidates.push(normalized);

        const language = normalized.split('-')[0];
        if (language && !seen.has(language)) {
            seen.add(language);
            candidates.push(language);
        }
    };

    addCandidate(locale);
    addCandidate(defaultLocale);
    addCandidate('en');

    return candidates;
}

export function resolvePluginI18nMessage(i18n = null, locale = '', key = '', substitutions = [], fallback = '') {
    const normalizedKey = normalizeString(key);
    const normalizedFallback = normalizeString(fallback);
    if (!normalizedKey) {
        return normalizedFallback;
    }

    const normalizedI18n = i18n && typeof i18n === 'object'
        ? i18n
        : null;
    if (!normalizedI18n) {
        return normalizedFallback;
    }

    const messages = normalizedI18n.messages && typeof normalizedI18n.messages === 'object'
        ? normalizedI18n.messages
        : {};
    const candidates = getLocaleCandidates(locale, normalizedI18n.defaultLocale);

    for (const candidate of candidates) {
        const table = messages[candidate];
        if (!table || typeof table !== 'object') {
            continue;
        }

        if (typeof table[normalizedKey] !== 'string') {
            continue;
        }

        return applySubstitutions(table[normalizedKey], substitutions);
    }

    return normalizedFallback;
}

export function resolvePluginLocalizedText({
    i18n = null,
    locale = '',
    key = '',
    fallback = '',
    substitutions = [],
    hostGetMessage = null,
} = {}) {
    const normalizedKey = normalizeString(key);
    const normalizedFallback = normalizeString(fallback);
    const pluginValue = resolvePluginI18nMessage(
        i18n,
        locale,
        normalizedKey,
        substitutions,
        ''
    );
    if (pluginValue) {
        return normalizeString(pluginValue, normalizedFallback);
    }

    if (typeof hostGetMessage === 'function' && normalizedKey) {
        const hostValue = hostGetMessage(normalizedKey, substitutions, '');
        if (hostValue && hostValue !== normalizedKey) {
            return normalizeString(hostValue, normalizedFallback);
        }
    }

    return normalizedFallback || normalizedKey;
}

export async function getResolvedPluginHostLocale() {
    const preference = await getLanguagePreference();
    return preference === LANGUAGE_AUTO
        ? detectSystemLocale()
        : preference;
}

export function createPluginHostLocaleStore({
    logger = console,
} = {}) {
    let started = false;
    let currentLocale = detectSystemLocale();
    let unsubscribe = null;
    const listeners = new Set();

    const emit = () => {
        const detail = {
            locale: currentLocale,
        };
        listeners.forEach((listener) => {
            try {
                listener(detail);
            } catch (error) {
                logger?.warn?.('[Cerebr] Plugin locale listener failed', error);
            }
        });
    };

    const refresh = async () => {
        currentLocale = await getResolvedPluginHostLocale();
        emit();
        return currentLocale;
    };

    const subscribeToPreferenceChanges = () => {
        if (typeof chrome !== 'undefined' && chrome?.storage?.onChanged?.addListener) {
            const handleStorageChange = (changes, areaName) => {
                if (areaName !== 'sync' || !changes?.[LANGUAGE_PREFERENCE_KEY]) {
                    return;
                }
                void refresh();
            };
            chrome.storage.onChanged.addListener(handleStorageChange);
            return () => chrome.storage.onChanged.removeListener(handleStorageChange);
        }

        if (typeof window !== 'undefined' && window?.addEventListener) {
            const storageKey = `sync_${LANGUAGE_PREFERENCE_KEY}`;
            const handleStorage = (event) => {
                if (event.key !== storageKey) {
                    return;
                }
                void refresh();
            };
            window.addEventListener('storage', handleStorage);
            return () => window.removeEventListener('storage', handleStorage);
        }

        return () => {};
    };

    return {
        getLocale() {
            return currentLocale;
        },
        async start() {
            if (started) {
                return currentLocale;
            }
            started = true;
            unsubscribe = subscribeToPreferenceChanges();
            return refresh();
        },
        stop() {
            if (!started) {
                return;
            }
            started = false;
            unsubscribe?.();
            unsubscribe = null;
            listeners.clear();
        },
        subscribe(callback, { immediate = true } = {}) {
            if (typeof callback !== 'function') {
                return () => {};
            }

            listeners.add(callback);
            if (immediate) {
                callback({
                    locale: currentLocale,
                });
            }

            return () => {
                listeners.delete(callback);
            };
        },
    };
}

export function createPluginRuntimeI18nApi(entry = {}, {
    getLocale = () => '',
    onLocaleChanged = null,
    hostGetMessage = null,
    addDisposer = null,
} = {}) {
    const pluginId = normalizeString(entry?.plugin?.id);
    const i18n = entry?.manifest?.i18n && typeof entry.manifest.i18n === 'object'
        ? entry.manifest.i18n
        : null;

    return {
        getLocale() {
            return normalizeString(getLocale());
        },
        getMessage(key, substitutions = [], fallback = '') {
            return resolvePluginLocalizedText({
                i18n,
                locale: getLocale(),
                key,
                fallback,
                substitutions,
                hostGetMessage,
            });
        },
        onLocaleChanged(callback, options = {}) {
            if (typeof callback !== 'function' || typeof onLocaleChanged !== 'function') {
                return () => {};
            }

            const unsubscribe = onLocaleChanged(callback, options);
            if (typeof addDisposer === 'function') {
                addDisposer(pluginId, unsubscribe);
            }
            return unsubscribe;
        },
    };
}
