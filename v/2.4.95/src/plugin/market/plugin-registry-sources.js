export const OFFICIAL_CURATED_PLUGIN_REGISTRY_URL =
    'https://yym68686.github.io/cerebr-plugins/plugin-registry.json';

export const BUNDLED_PLUGIN_REGISTRY_URL = 'statics/plugin-registry.json';

export const DEFAULT_PLUGIN_REGISTRY_SOURCES = Object.freeze([
    Object.freeze({
        id: 'official-bundled',
        displayName: 'Cerebr Bundled Registry',
        url: BUNDLED_PLUGIN_REGISTRY_URL,
    }),
    Object.freeze({
        id: 'official-curated',
        displayName: 'Cerebr Plugins Registry',
        url: OFFICIAL_CURATED_PLUGIN_REGISTRY_URL,
    }),
]);
