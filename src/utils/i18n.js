import { syncStorageAdapter } from './storage-adapter.js';

const SUPPORTED_LOCALES = ['en', 'zh_CN', 'zh_TW'];
export const LANGUAGE_PREFERENCE_KEY = 'uiLanguage';
export const LANGUAGE_AUTO = 'auto';

let activeLocale = 'en';
let activeMessages = Object.create(null);
let fallbackMessages = Object.create(null);
let initialized = false;

function normalizeLocaleTag(tag) {
    if (!tag) return '';
    return String(tag).replace(/_/g, '-').trim();
}

function mapToSupportedLocale(rawTag) {
    const tag = normalizeLocaleTag(rawTag).toLowerCase();
    if (!tag) return 'en';

    if (tag.startsWith('zh')) {
        // Traditional: explicit script or region hints
        if (tag.includes('hant') || tag.endsWith('-tw') || tag.endsWith('-hk') || tag.endsWith('-mo')) {
            return 'zh_TW';
        }
        return 'zh_CN';
    }
    return 'en';
}

export function detectSystemLocale() {
    try {
        if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
            return mapToSupportedLocale(chrome.i18n.getUILanguage());
        }
    } catch {
        // ignore
    }
    return mapToSupportedLocale(typeof navigator !== 'undefined' ? navigator.language : 'en');
}

function getResourceUrl(path) {
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
            return chrome.runtime.getURL(path);
        }
    } catch {
        // ignore
    }
    return new URL(path, window.location.href).toString();
}

function coerceMessagesJsonToMap(json) {
    const map = Object.create(null);
    if (!json || typeof json !== 'object') return map;
    for (const [key, value] of Object.entries(json)) {
        if (value && typeof value === 'object' && typeof value.message === 'string') {
            map[key] = value.message;
        }
    }
    return map;
}

async function loadLocaleMessages(locale) {
    const url = getResourceUrl(`_locales/${locale}/messages.json`);
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Failed to load locale ${locale}: ${response.status}`);
    const json = await response.json();
    return coerceMessagesJsonToMap(json);
}

function applySubstitutions(message, substitutions) {
    if (!substitutions || substitutions.length === 0) return message;
    let out = message;
    substitutions.forEach((value, index) => {
        const token = `$${index + 1}`;
        out = out.split(token).join(String(value));
    });
    return out;
}

export function t(key, substitutions = []) {
    const raw = activeMessages[key] ?? fallbackMessages[key];
    if (typeof raw !== 'string') return key;
    return applySubstitutions(raw, Array.isArray(substitutions) ? substitutions : [substitutions]);
}

export function getActiveLocale() {
    return activeLocale;
}

export function getLanguagePreferenceLabel(value) {
    if (value === LANGUAGE_AUTO) return t('language_auto');
    if (value === 'en') return t('language_en');
    if (value === 'zh_CN') return t('language_zh_cn');
    if (value === 'zh_TW') return t('language_zh_tw');
    return value;
}

export async function getLanguagePreference() {
    try {
        const result = await syncStorageAdapter.get(LANGUAGE_PREFERENCE_KEY);
        const value = result?.[LANGUAGE_PREFERENCE_KEY];
        if (value === LANGUAGE_AUTO) return LANGUAGE_AUTO;
        if (SUPPORTED_LOCALES.includes(value)) return value;
    } catch {
        // ignore
    }
    return LANGUAGE_AUTO;
}

export async function setLanguagePreference(value) {
    const normalized = value === LANGUAGE_AUTO ? LANGUAGE_AUTO : (SUPPORTED_LOCALES.includes(value) ? value : LANGUAGE_AUTO);
    await syncStorageAdapter.set({ [LANGUAGE_PREFERENCE_KEY]: normalized });
    return normalized;
}

export async function initI18n() {
    const preference = await getLanguagePreference();
    const resolved = preference === LANGUAGE_AUTO ? detectSystemLocale() : preference;

    // Always load fallback first
    try {
        fallbackMessages = await loadLocaleMessages('en');
    } catch {
        fallbackMessages = Object.create(null);
    }

    activeLocale = resolved;
    try {
        activeMessages = await loadLocaleMessages(resolved);
    } catch {
        activeMessages = Object.create(null);
        activeLocale = 'en';
    }

    initialized = true;

    try {
        const langAttr = activeLocale === 'zh_CN' ? 'zh-CN' : (activeLocale === 'zh_TW' ? 'zh-TW' : 'en');
        document.documentElement.setAttribute('lang', langAttr);
    } catch {
        // ignore
    }

    window.dispatchEvent(new CustomEvent('cerebr:localeChanged', { detail: { locale: activeLocale, preference } }));
}

export async function reloadI18n() {
    return initI18n();
}

function parseAttrBindings(value) {
    const raw = String(value || '');
    return raw
        .split(';')
        .map(s => s.trim())
        .filter(Boolean)
        .map(pair => {
            const idx = pair.indexOf(':');
            if (idx === -1) return null;
            const attr = pair.slice(0, idx).trim();
            const key = pair.slice(idx + 1).trim();
            if (!attr || !key) return null;
            return { attr, key };
        })
        .filter(Boolean);
}

export function applyI18n(root = document) {
    if (!root) return;

    const scope = root.querySelectorAll ? root : document;

    // Text content
    scope.querySelectorAll?.('[data-i18n]')?.forEach((el) => {
        const key = el.getAttribute('data-i18n');
        if (!key) return;
        el.textContent = t(key);
    });

    // Attributes
    scope.querySelectorAll?.('[data-i18n-attr]')?.forEach((el) => {
        const bindings = parseAttrBindings(el.getAttribute('data-i18n-attr'));
        bindings.forEach(({ attr, key }) => {
            const value = t(key);
            if (value) el.setAttribute(attr, value);
        });
    });

    // Contenteditable placeholder polyfill: keep attribute updated, and toggle a data flag for CSS hooks.
    scope.querySelectorAll?.('[contenteditable][placeholder]')?.forEach((el) => {
        const hasContent = (el.textContent || '').trim().length > 0 || !!el.querySelector?.('.image-tag');
        if (!hasContent) el.classList.add('is-empty');
        else el.classList.remove('is-empty');
    });
}

export function onLocaleChanged(handler) {
    if (typeof handler !== 'function') return () => {};
    const listener = (e) => handler(e?.detail);
    window.addEventListener('cerebr:localeChanged', listener);
    if (initialized) handler({ locale: activeLocale, preference: null });
    return () => window.removeEventListener('cerebr:localeChanged', listener);
}

