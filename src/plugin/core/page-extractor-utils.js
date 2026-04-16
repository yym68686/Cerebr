import { matchesAnyUrlPattern } from './url-pattern-utils.js';
import {
    normalizeBoolean,
    normalizeNumber,
    normalizePositiveInt,
    normalizeString,
    normalizeStringArray,
} from './runtime-utils.js';

const SUPPORTED_PAGE_EXTRACTOR_STRATEGIES = new Set([
    'replace',
    'prepend',
    'append',
]);

function dedupeElements(elements = []) {
    const deduped = [];
    const seen = new Set();

    elements.forEach((element) => {
        if (!(element instanceof Element) || seen.has(element)) {
            return;
        }
        seen.add(element);
        deduped.push(element);
    });

    return deduped;
}

function cloneDocumentBody(root) {
    if (!(root instanceof Element)) {
        return null;
    }

    const cloned = root.cloneNode(true);
    const originalInputs = root.querySelectorAll('textarea, input');
    const clonedInputs = cloned.querySelectorAll('textarea, input');

    originalInputs.forEach((element, index) => {
        if (!clonedInputs[index] || !element.value) {
            return;
        }
        clonedInputs[index].textContent = element.value;
    });

    return cloned;
}

function normalizeWhitespace(text, collapseWhitespace = true) {
    const normalizedText = String(text ?? '');
    if (collapseWhitespace === false) {
        return normalizedText.trim();
    }

    return normalizedText
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

export function normalizePageExtractorDefinition(definition, pluginId = '') {
    if (!definition || typeof definition !== 'object') {
        return null;
    }

    const matches = normalizeStringArray(definition.matches);
    const includeSelectors = normalizeStringArray(
        definition.includeSelectors || definition.selectors?.include
    );
    const excludeSelectors = normalizeStringArray(
        definition.excludeSelectors || definition.selectors?.exclude
    );
    const strategy = normalizeString(definition.strategy, 'replace');
    const normalizedStrategy = SUPPORTED_PAGE_EXTRACTOR_STRATEGIES.has(strategy)
        ? strategy
        : 'replace';
    const normalizedPluginId = normalizeString(definition.pluginId, pluginId);
    const extractorId = normalizeString(
        definition.id,
        `${normalizedPluginId || 'plugin'}:extractor:${normalizeString(definition.label, 'default')}`
    );

    return {
        id: extractorId,
        pluginId: normalizedPluginId,
        label: normalizeString(definition.label),
        matches,
        includeSelectors,
        excludeSelectors,
        strategy: normalizedStrategy,
        priority: normalizeNumber(definition.priority, 0),
        maxTextLength: normalizePositiveInt(definition.maxTextLength, 20000),
        collapseWhitespace: normalizeBoolean(definition.collapseWhitespace, true),
    };
}

export function matchesPageExtractor(extractor, url) {
    if (!extractor) return false;
    return matchesAnyUrlPattern(url, extractor.matches);
}

export function sortPageExtractors(extractors = []) {
    return [...extractors].sort((left, right) => {
        const priorityDelta = normalizeNumber(right?.priority, 0) - normalizeNumber(left?.priority, 0);
        if (priorityDelta !== 0) {
            return priorityDelta;
        }
        return normalizeString(left?.id).localeCompare(normalizeString(right?.id));
    });
}

export function extractTextWithPageExtractor(extractor, { root = document.body } = {}) {
    const clonedRoot = cloneDocumentBody(root);
    if (!clonedRoot) {
        return '';
    }

    extractor?.excludeSelectors?.forEach((selector) => {
        clonedRoot.querySelectorAll(selector).forEach((element) => element.remove());
    });

    let text = '';

    if (Array.isArray(extractor?.includeSelectors) && extractor.includeSelectors.length > 0) {
        const includedElements = dedupeElements(
            extractor.includeSelectors.flatMap((selector) => Array.from(clonedRoot.querySelectorAll(selector)))
        );
        text = includedElements
            .map((element) => element.innerText || element.textContent || '')
            .join('\n\n');
    } else {
        text = clonedRoot.innerText || clonedRoot.textContent || '';
    }

    const normalizedText = normalizeWhitespace(text, extractor?.collapseWhitespace !== false);
    const maxTextLength = normalizePositiveInt(extractor?.maxTextLength, 20000);
    return normalizedText.slice(0, maxTextLength);
}
