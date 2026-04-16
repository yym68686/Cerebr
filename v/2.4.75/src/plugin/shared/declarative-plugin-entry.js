import { definePlugin } from './define-plugin.js';
import { normalizePageExtractorDefinition } from '../core/page-extractor-utils.js';
import { normalizePromptFragment } from '../core/prompt-fragment-utils.js';
import {
    normalizePositiveInt,
    normalizeString,
    normalizeStringArray,
} from '../core/runtime-utils.js';

function normalizePromptFragmentList(value, pluginId) {
    const fragments = Array.isArray(value) ? value : [value];
    return fragments
        .map((fragment) => normalizePromptFragment(fragment, pluginId))
        .filter(Boolean);
}

function normalizeRequestPolicyConfig(manifest = {}) {
    const declarative = manifest?.declarative || {};

    return {
        applyTo: {
            modes: normalizeStringArray(declarative.applyTo?.modes).map((mode) => mode.toLowerCase()),
            modelIncludes: normalizeStringArray(declarative.applyTo?.modelIncludes).map((item) => item.toLowerCase()),
            urlIncludes: normalizeStringArray(declarative.applyTo?.urlIncludes).map((item) => item.toLowerCase()),
        },
        promptFragments: normalizePromptFragmentList(declarative.promptFragments, manifest.id),
        requestPatch: {
            url: normalizeString(declarative.requestPatch?.url),
            headers: declarative.requestPatch?.headers && typeof declarative.requestPatch.headers === 'object'
                ? Object.fromEntries(
                    Object.entries(declarative.requestPatch.headers)
                        .map(([key, value]) => [normalizeString(key), String(value ?? '')])
                        .filter(([key]) => !!key)
                )
                : {},
            body: declarative.requestPatch?.body && typeof declarative.requestPatch.body === 'object'
                ? { ...declarative.requestPatch.body }
                : {},
        },
        retry: {
            enabled: !!(declarative.retry && typeof declarative.retry === 'object'),
            onErrorCodes: normalizeStringArray(declarative.retry?.onErrorCodes),
            maxAttempts: normalizePositiveInt(declarative.retry?.maxAttempts, 20),
            reason: normalizeString(
                declarative.retry?.reason,
                `declarative:${normalizeString(manifest.id)}:retry`
            ),
        },
        cancel: {
            draftMatches: normalizeString(declarative.cancel?.draftMatches),
            draftIncludes: normalizeStringArray(declarative.cancel?.draftIncludes).map((item) => item.toLowerCase()),
            reason: normalizeString(
                declarative.cancel?.reason,
                `declarative:${normalizeString(manifest.id)}:cancel`
            ),
        },
    };
}

function matchesPolicyTarget(policy, context = {}, requestDescriptor = null, payload = null) {
    const mode = normalizeString(
        context?.request?.mode || context?.mode || payload?.mode
    ).toLowerCase();
    if (policy.applyTo.modes.length > 0 && !policy.applyTo.modes.includes(mode)) {
        return false;
    }

    const modelName = normalizeString(
        context?.request?.apiConfig?.modelName ||
        payload?.apiConfig?.modelName
    ).toLowerCase();
    if (policy.applyTo.modelIncludes.length > 0 && !policy.applyTo.modelIncludes.some((item) => modelName.includes(item))) {
        return false;
    }

    const requestUrl = normalizeString(requestDescriptor?.url).toLowerCase();
    if (policy.applyTo.urlIncludes.length > 0 && !policy.applyTo.urlIncludes.some((item) => requestUrl.includes(item))) {
        return false;
    }

    return true;
}

function shouldCancelBeforeSend(policy, payload = null) {
    const draftText = normalizeString(payload?.draft?.message || payload?.userMessage?.content);
    if (!draftText) {
        return false;
    }

    const normalizedDraftText = draftText.toLowerCase();
    if (policy.cancel.draftIncludes.length > 0 && policy.cancel.draftIncludes.some((item) => normalizedDraftText.includes(item))) {
        return true;
    }

    if (!policy.cancel.draftMatches) {
        return false;
    }

    try {
        return new RegExp(policy.cancel.draftMatches, 'i').test(draftText);
    } catch {
        return false;
    }
}

function patchRequestDescriptor(requestDescriptor = {}, requestPatch = {}) {
    const nextDescriptor = {
        ...requestDescriptor,
        requestBody: requestDescriptor?.requestBody && typeof requestDescriptor.requestBody === 'object'
            ? { ...requestDescriptor.requestBody }
            : {},
        requestInit: requestDescriptor?.requestInit && typeof requestDescriptor.requestInit === 'object'
            ? {
                ...requestDescriptor.requestInit,
                headers: {
                    ...(requestDescriptor.requestInit.headers || {}),
                },
            }
            : {
                headers: {},
            },
    };

    if (requestPatch.url) {
        nextDescriptor.url = requestPatch.url;
    }

    if (requestPatch.body && Object.keys(requestPatch.body).length > 0) {
        nextDescriptor.requestBody = {
            ...nextDescriptor.requestBody,
            ...requestPatch.body,
        };
    }

    if (requestPatch.headers && Object.keys(requestPatch.headers).length > 0) {
        nextDescriptor.requestInit = {
            ...nextDescriptor.requestInit,
            headers: {
                ...(nextDescriptor.requestInit.headers || {}),
                ...requestPatch.headers,
            },
        };
    }

    return nextDescriptor;
}

function createPromptFragmentPlugin(descriptor = {}) {
    const fragment = normalizePromptFragment(descriptor?.manifest?.declarative, descriptor?.id);
    if (!fragment) {
        return null;
    }

    return definePlugin({
        id: descriptor.id,
        displayName: descriptor?.manifest?.displayName,
        priority: descriptor?.manifest?.priority ?? fragment.priority ?? 0,
        setup(api) {
            const handle = api.prompt?.addFragment?.(fragment);
            return () => handle?.dispose?.();
        },
    });
}

function createRequestPolicyPlugin(descriptor = {}) {
    const policy = normalizeRequestPolicyConfig(descriptor?.manifest || {});

    return definePlugin({
        id: descriptor.id,
        displayName: descriptor?.manifest?.displayName,
        priority: descriptor?.manifest?.priority ?? 0,
        setup() {},
        onBeforeSend(payload, ctx) {
            if (!matchesPolicyTarget(policy, ctx, null, payload)) {
                return payload;
            }

            if (shouldCancelBeforeSend(policy, payload)) {
                ctx.chat.cancel(policy.cancel.reason);
            }

            return payload;
        },
        onBuildPrompt(ctx) {
            if (!matchesPolicyTarget(policy, ctx)) {
                return [];
            }

            return policy.promptFragments;
        },
        onRequest(requestDescriptor, ctx) {
            if (!matchesPolicyTarget(policy, ctx, requestDescriptor)) {
                return requestDescriptor;
            }

            return patchRequestDescriptor(requestDescriptor, policy.requestPatch);
        },
        onResponseError(error, ctx) {
            if (!matchesPolicyTarget(policy, ctx)) {
                return;
            }
            if (!policy.retry.enabled) {
                return;
            }

            const errorCode = normalizeString(error?.code);
            if (policy.retry.onErrorCodes.length > 0 && !policy.retry.onErrorCodes.includes(errorCode)) {
                return;
            }

            ctx.chat.retry(policy.retry.reason, {
                maxAttempts: policy.retry.maxAttempts,
            });
        },
    });
}

function createPageExtractorPlugin(descriptor = {}) {
    const extractor = normalizePageExtractorDefinition(descriptor?.manifest?.declarative, descriptor?.id);
    if (!extractor) {
        return null;
    }

    return definePlugin({
        id: descriptor.id,
        displayName: descriptor?.manifest?.displayName,
        priority: extractor.priority,
        setup(api) {
            const handle = api.page?.registerExtractor?.(extractor);
            return () => handle?.dispose?.();
        },
    });
}

export function createDeclarativePluginEntry(descriptor = {}, { host = '' } = {}) {
    const manifest = descriptor?.manifest || {};
    const declarativeType = normalizeString(manifest?.declarative?.type);
    const normalizedHost = normalizeString(host);

    let plugin = null;

    if (declarativeType === 'prompt_fragment' && normalizedHost === 'shell') {
        plugin = createPromptFragmentPlugin(descriptor);
    } else if (declarativeType === 'request_policy' && normalizedHost === 'shell') {
        plugin = createRequestPolicyPlugin(descriptor);
    } else if (declarativeType === 'page_extractor' && normalizedHost === 'page') {
        plugin = createPageExtractorPlugin(descriptor);
    }

    if (!plugin) {
        return null;
    }

    return {
        plugin,
        manifest: descriptor.manifest ? { ...descriptor.manifest } : null,
    };
}
