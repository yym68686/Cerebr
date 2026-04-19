import enLocale from '../locales/en.json' with { type: 'json' };
import zhCnLocale from '../locales/zh_CN.json' with { type: 'json' };
import zhTwLocale from '../locales/zh_TW.json' with { type: 'json' };

// Plugin-local i18n loader and resolver.
// Locale data is bundled as JSON modules so dropped guest shell plugins
// stay self-contained and do not rely on runtime fetch() against import.meta.url.

const FALLBACK_LOCALE = 'en';
const SUPPORTED_LOCALES = new Set(['en', 'zh_TW', 'zh_CN']);
const LOCALE_MAP = Object.freeze({
    en: enLocale,
    zh_CN: zhCnLocale,
    zh_TW: zhTwLocale,
});

let activeLocale = FALLBACK_LOCALE;
let fallbackMap = LOCALE_MAP[FALLBACK_LOCALE] || { ui: {}, seed_commands: {}, language_label: 'English' };
let activeMap = fallbackMap;

function normalizeLocaleCode(code) {
    const raw = String(code ?? '').trim();
    if (!raw) return FALLBACK_LOCALE;
    if (SUPPORTED_LOCALES.has(raw)) return raw;
    const lower = raw.toLowerCase();
    if (lower.startsWith('zh')) {
        if (lower.includes('hant') || lower.endsWith('-tw') || lower.endsWith('_tw')
            || lower.endsWith('-hk') || lower.endsWith('-mo')) {
            return 'zh_TW';
        }
        return 'zh_CN';
    }
    return FALLBACK_LOCALE;
}

function readByDotPath(map, dotKey) {
    return String(dotKey).split('.').reduce(
        (node, segment) => (node && typeof node === 'object' ? node[segment] : undefined),
        map,
    );
}

function applySubstitutions(template, substitutions) {
    const list = Array.isArray(substitutions) ? substitutions : [substitutions];
    if (!list.length) return template;
    let out = template;
    list.forEach((value, index) => {
        out = out.split(`$${index + 1}`).join(String(value ?? ''));
    });
    return out;
}

export async function loadPluginLocale(rawCode) {
    const target = normalizeLocaleCode(rawCode);
    fallbackMap = LOCALE_MAP[FALLBACK_LOCALE] || { ui: {}, seed_commands: {}, language_label: 'English' };

    if (target === FALLBACK_LOCALE) {
        activeMap = fallbackMap;
        activeLocale = FALLBACK_LOCALE;
        return activeMap;
    }

    if (LOCALE_MAP[target] && typeof LOCALE_MAP[target] === 'object') {
        activeMap = LOCALE_MAP[target];
        activeLocale = target;
    } else {
        activeMap = fallbackMap;
        activeLocale = FALLBACK_LOCALE;
    }

    return activeMap;
}

export function t(key, substitutions = []) {
    const activeHit = readByDotPath(activeMap, key);
    const fallbackHit = readByDotPath(fallbackMap, key);
    const template = typeof activeHit === 'string'
        ? activeHit
        : (typeof fallbackHit === 'string' ? fallbackHit : key);
    return applySubstitutions(template, substitutions);
}

export function getLocaleLabel() {
    return typeof activeMap?.language_label === 'string'
        ? activeMap.language_label
        : 'English';
}

export function getSeedCommandMeta(seedKey) {
    const meta = activeMap?.seed_commands?.[seedKey];
    if (meta && typeof meta === 'object') return meta;
    const fallback = fallbackMap?.seed_commands?.[seedKey];
    return fallback && typeof fallback === 'object' ? fallback : null;
}

export function getActiveLocale() {
    return activeLocale;
}
