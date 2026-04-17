import { definePlugin } from './define-plugin.js';
import { normalizePageExtractorDefinition } from '../core/page-extractor-utils.js';
import { normalizePromptFragment } from '../core/prompt-fragment-utils.js';
import {
    normalizePositiveInt,
    normalizeString,
    normalizeStringArray,
} from '../core/runtime-utils.js';

function cloneValue(value, fallback = null) {
    if (value == null) {
        return fallback;
    }

    try {
        if (typeof structuredClone === 'function') {
            return structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value));
    } catch {
        return fallback;
    }
}

function normalizePromptFragmentList(value, pluginId) {
    const fragments = Array.isArray(value) ? value : [value];
    return fragments
        .map((fragment) => normalizePromptFragment(fragment, pluginId))
        .filter(Boolean);
}

function normalizeRequestPolicyConfig(value = {}, pluginId = '') {
    const declarative = value && typeof value === 'object'
        ? value
        : {};

    return {
        applyTo: {
            modes: normalizeStringArray(declarative.applyTo?.modes).map((mode) => mode.toLowerCase()),
            modelIncludes: normalizeStringArray(declarative.applyTo?.modelIncludes).map((item) => item.toLowerCase()),
            urlIncludes: normalizeStringArray(declarative.applyTo?.urlIncludes).map((item) => item.toLowerCase()),
        },
        promptFragments: normalizePromptFragmentList(declarative.promptFragments, pluginId),
        requestPatch: {
            url: normalizeString(declarative.requestPatch?.url),
            headers: declarative.requestPatch?.headers && typeof declarative.requestPatch.headers === 'object'
                ? Object.fromEntries(
                    Object.entries(declarative.requestPatch.headers)
                        .map(([key, nextValue]) => [normalizeString(key), String(nextValue ?? '')])
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
                `declarative:${normalizeString(pluginId)}:retry`
            ),
        },
        cancel: {
            draftMatches: normalizeString(declarative.cancel?.draftMatches),
            draftIncludes: normalizeStringArray(declarative.cancel?.draftIncludes).map((item) => item.toLowerCase()),
            reason: normalizeString(
                declarative.cancel?.reason,
                `declarative:${normalizeString(pluginId)}:cancel`
            ),
        },
    };
}

function normalizeSelectionActionList(value, pluginId) {
    return (Array.isArray(value) ? value : [])
        .map((action, index) => {
            if (!action || typeof action !== 'object') {
                return null;
            }

            const prompt = normalizeString(action.prompt || action.text || action.promptTemplate);
            const label = normalizeString(action.label);
            if (!prompt || !label) {
                return null;
            }

            return {
                id: normalizeString(action.id, `${pluginId}.selection-action.${index + 1}`),
                label,
                title: normalizeString(action.title, label),
                icon: normalizeString(action.icon, 'dot'),
                prompt,
                focus: action.focus !== false,
                separator: normalizeString(action.separator, '\n\n'),
                offsetX: Number.isFinite(Number(action.offsetX)) ? Number(action.offsetX) : 0,
                offsetY: Number.isFinite(Number(action.offsetY)) ? Number(action.offsetY) : 0,
                minLength: normalizePositiveInt(action.minLength, 2),
                maxLength: normalizePositiveInt(action.maxLength, 4000),
            };
        })
        .filter(Boolean);
}

function normalizeShellExecute(value = {}, pluginId = '', contributionId = '') {
    const execute = value && typeof value === 'object'
        ? value
        : {};
    const type = normalizeString(execute.type).toLowerCase();
    if (!type) {
        return null;
    }

    if (type === 'import_text' || type === 'insert_text' || type === 'set_draft') {
        const text = normalizeString(execute.text || execute.prompt || execute.template);
        if (!text) {
            return null;
        }

        return {
            type,
            text,
            focus: execute.focus !== false,
            separator: normalizeString(execute.separator, '\n\n'),
        };
    }

    if (type === 'show_toast') {
        const message = normalizeString(execute.message || execute.text);
        if (!message) {
            return null;
        }

        return {
            type,
            message,
            toastType: normalizeString(execute.toastType || execute.kind || execute.level, 'info'),
            durationMs: normalizePositiveInt(execute.durationMs, 2400),
        };
    }

    if (type === 'open_page') {
        const page = execute.page && typeof execute.page === 'object'
            ? cloneValue(execute.page, {}) || {}
            : null;
        if (!page) {
            return null;
        }

        return {
            type,
            page,
        };
    }

    return null;
}

function normalizeInputActionList(value, pluginId) {
    return (Array.isArray(value) ? value : [])
        .map((action, index) => {
            if (!action || typeof action !== 'object') {
                return null;
            }

            const id = normalizeString(action.id, `${pluginId}.input-action.${index + 1}`);
            const label = normalizeString(action.label);
            const icon = normalizeString(action.icon);
            if (!id || (!label && !icon)) {
                return null;
            }

            const execute = normalizeShellExecute(action.execute, pluginId, id);
            if (!execute) {
                return null;
            }

            return {
                id,
                label,
                icon,
                title: normalizeString(action.title, label || icon || id),
                variant: normalizeString(action.variant, icon && !label ? 'ghost' : 'soft'),
                disabled: !!action.disabled,
                background: normalizeString(action.background),
                color: normalizeString(action.color),
                order: Number.isFinite(Number(action.order)) ? Number(action.order) : index,
                execute,
            };
        })
        .filter(Boolean);
}

function normalizeMenuItemList(value, pluginId) {
    return (Array.isArray(value) ? value : [])
        .map((item, index) => {
            if (!item || typeof item !== 'object') {
                return null;
            }

            const id = normalizeString(item.id, `${pluginId}.menu-item.${index + 1}`);
            const label = normalizeString(item.label);
            if (!id || !label) {
                return null;
            }

            const execute = normalizeShellExecute(item.execute, pluginId, id);
            if (!execute) {
                return null;
            }

            return {
                id,
                label,
                icon: normalizeString(item.icon),
                title: normalizeString(item.title, label),
                order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
                disclosure: item.disclosure !== false,
                disabled: !!item.disabled,
                execute,
            };
        })
        .filter(Boolean);
}

function normalizeSlashCommandList(value, pluginId) {
    return (Array.isArray(value) ? value : [])
        .map((command, index) => {
            if (!command || typeof command !== 'object') {
                return null;
            }

            const name = normalizeString(command.name);
            const prompt = normalizeString(command.prompt || command.text || command.template);
            if (!name || !prompt) {
                return null;
            }

            return {
                id: normalizeString(command.id, `${pluginId}.slash-command.${index + 1}`),
                name,
                label: normalizeString(command.label, name),
                description: normalizeString(command.description),
                aliases: normalizeStringArray(command.aliases),
                prompt,
                separator: Object.prototype.hasOwnProperty.call(command, 'separator')
                    ? String(command.separator ?? '')
                    : '\n\n',
                disabled: !!command.disabled,
                order: Number.isFinite(Number(command.order)) ? Number(command.order) : index,
            };
        })
        .filter(Boolean);
}

function normalizeDeclarativeContributions(manifest = {}, pluginId = '') {
    if (manifest?.contributions && typeof manifest.contributions === 'object') {
        return {
            promptFragments: normalizePromptFragmentList(manifest.contributions.promptFragments, pluginId),
            requestPolicies: (Array.isArray(manifest.contributions.requestPolicies)
                ? manifest.contributions.requestPolicies
                : []
            )
                .map((policy) => normalizeRequestPolicyConfig(policy, pluginId))
                .filter(Boolean),
            pageExtractors: (Array.isArray(manifest.contributions.pageExtractors)
                ? manifest.contributions.pageExtractors
                : []
            )
                .map((extractor) => normalizePageExtractorDefinition(extractor, pluginId))
                .filter(Boolean),
            selectionActions: normalizeSelectionActionList(manifest.contributions.selectionActions, pluginId),
            inputActions: normalizeInputActionList(manifest.contributions.inputActions, pluginId),
            menuItems: normalizeMenuItemList(manifest.contributions.menuItems, pluginId),
            slashCommands: normalizeSlashCommandList(manifest.contributions.slashCommands, pluginId),
        };
    }

    const declarative = manifest?.declarative || {};
    const declarativeType = normalizeString(declarative.type);

    if (declarativeType === 'prompt_fragment') {
        return {
            promptFragments: normalizePromptFragmentList(declarative, pluginId),
            requestPolicies: [],
            pageExtractors: [],
            selectionActions: [],
            inputActions: [],
            menuItems: [],
            slashCommands: [],
        };
    }

    if (declarativeType === 'request_policy') {
        return {
            promptFragments: [],
            requestPolicies: [normalizeRequestPolicyConfig(declarative, pluginId)],
            pageExtractors: [],
            selectionActions: [],
            inputActions: [],
            menuItems: [],
            slashCommands: [],
        };
    }

    if (declarativeType === 'page_extractor') {
        const extractor = normalizePageExtractorDefinition(declarative, pluginId);
        return {
            promptFragments: [],
            requestPolicies: [],
            pageExtractors: extractor ? [extractor] : [],
            selectionActions: [],
            inputActions: [],
            menuItems: [],
            slashCommands: [],
        };
    }

    return {
        promptFragments: [],
        requestPolicies: [],
        pageExtractors: [],
        selectionActions: [],
        inputActions: [],
        menuItems: [],
        slashCommands: [],
    };
}

function resolveTemplatePath(templateContext = {}, path = '') {
    return String(path || '')
        .split('.')
        .reduce((currentValue, segment) => {
            if (!segment) {
                return currentValue;
            }
            if (!currentValue || typeof currentValue !== 'object') {
                return undefined;
            }
            return currentValue[segment];
        }, templateContext);
}

function materializeTemplateValue(value, templateContext = {}) {
    if (typeof value === 'string') {
        return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, path) => {
            const resolvedValue = resolveTemplatePath(templateContext, path);
            if (resolvedValue == null) {
                return '';
            }
            return String(resolvedValue);
        });
    }

    if (Array.isArray(value)) {
        return value.map((item) => materializeTemplateValue(item, templateContext));
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, nextValue]) => [
                key,
                materializeTemplateValue(nextValue, templateContext),
            ])
        );
    }

    return value;
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

function createShellExecuteRunner(api) {
    return (execute = null, templateContext = {}) => {
        if (!execute || typeof execute !== 'object') {
            return false;
        }

        if (execute.type === 'import_text') {
            const text = materializeTemplateValue(execute.text, templateContext);
            return api.shell?.importText?.(text, {
                focus: execute.focus !== false,
                separator: execute.separator || '\n\n',
            }) ?? false;
        }

        if (execute.type === 'insert_text') {
            const text = materializeTemplateValue(execute.text, templateContext);
            return api.shell?.insertText?.(text, {
                focus: execute.focus !== false,
            }) ?? false;
        }

        if (execute.type === 'set_draft') {
            const text = materializeTemplateValue(execute.text, templateContext);
            return api.shell?.setDraft?.(text) ?? false;
        }

        if (execute.type === 'show_toast') {
            const message = materializeTemplateValue(execute.message, templateContext);
            api.ui?.showToast?.(message, {
                type: execute.toastType || 'info',
                durationMs: execute.durationMs || 2400,
            });
            return true;
        }

        if (execute.type === 'open_page') {
            const page = materializeTemplateValue(cloneValue(execute.page, {}) || {}, templateContext);
            return api.shell?.openPage?.(page) ?? false;
        }

        return false;
    };
}

function safeReadPluginApi(read, fallback) {
    if (typeof read !== 'function') {
        return fallback;
    }

    try {
        return read();
    } catch {
        return fallback;
    }
}

function createSelectionActionSetup(contributions, api) {
    if (!Array.isArray(contributions.selectionActions) || contributions.selectionActions.length === 0) {
        return null;
    }

    const actionHandles = new Map();

    const disposeAll = () => {
        actionHandles.forEach((handle) => {
            handle?.dispose?.();
        });
        actionHandles.clear();
    };

    const dispose = api.page?.watchSelection?.((selection) => {
        const normalizedText = normalizeString(selection?.text);
        const shouldRender = !!normalizedText &&
            !selection?.collapsed &&
            !!selection?.rect &&
            !selection?.insideEditable &&
            !selection?.insideCodeBlock;

        if (!shouldRender) {
            disposeAll();
            return;
        }

        contributions.selectionActions.forEach((action, index) => {
            const actionId = normalizeString(action.id);
            const textLength = normalizedText.length;
            if (textLength < action.minLength || textLength > action.maxLength) {
                actionHandles.get(actionId)?.dispose?.();
                actionHandles.delete(actionId);
                return;
            }

            const nextConfig = {
                rect: selection.rect,
                label: action.label,
                title: action.title,
                icon: action.icon || 'dot',
                offsetX: (Number(action.offsetX) || 0) + (index * 28),
                offsetY: Number(action.offsetY) || 0,
                onClick() {
                    const text = materializeTemplateValue(action.prompt, {
                        selection,
                        page: safeReadPluginApi(() => api.page?.getSnapshot?.({
                            includeText: false,
                        }), {}) || {},
                    });
                    api.shell?.importText?.(text, {
                        focus: action.focus !== false,
                        separator: action.separator || '\n\n',
                    });
                    api.page?.clearSelection?.();
                },
            };

            if (actionHandles.has(actionId)) {
                actionHandles.get(actionId)?.update?.(nextConfig);
                return;
            }

            const handle = api.ui?.showAnchoredAction?.(nextConfig);
            if (handle) {
                actionHandles.set(actionId, handle);
            }
        });
    });

    return () => {
        dispose?.();
        disposeAll();
    };
}

function createInputActionSetup(contributions, api) {
    if (!Array.isArray(contributions.inputActions) || contributions.inputActions.length === 0) {
        return null;
    }

    const actionMap = new Map(
        contributions.inputActions.map((action) => [normalizeString(action.id), action])
    );
    const runExecute = createShellExecuteRunner(api);
    api.shell?.setInputActions?.(contributions.inputActions);
    const unsubscribe = api.shell?.onInputAction?.((event = {}) => {
        const action = actionMap.get(normalizeString(event.actionId));
        if (!action) {
            return;
        }

        runExecute(action.execute, {
            action,
            event,
            draft: safeReadPluginApi(() => api.editor?.getDraftSnapshot?.(), {}) || {},
            locale: api.i18n?.getLocale?.() || '',
        });
    });

    return () => {
        unsubscribe?.();
        api.shell?.clearInputActions?.();
    };
}

function createMenuItemSetup(contributions, api) {
    if (!Array.isArray(contributions.menuItems) || contributions.menuItems.length === 0) {
        return null;
    }

    const itemMap = new Map(
        contributions.menuItems.map((item) => [normalizeString(item.id), item])
    );
    const runExecute = createShellExecuteRunner(api);
    api.shell?.setMenuItems?.(contributions.menuItems);
    const unsubscribe = api.shell?.onMenuAction?.((event = {}) => {
        const item = itemMap.get(normalizeString(event.itemId));
        if (!item) {
            return;
        }

        runExecute(item.execute, {
            item,
            event,
            draft: safeReadPluginApi(() => api.editor?.getDraftSnapshot?.(), {}) || {},
            locale: api.i18n?.getLocale?.() || '',
        });
    });

    return () => {
        unsubscribe?.();
        api.shell?.clearMenuItems?.();
    };
}

function createSlashCommandSetup(contributions, api) {
    if (!Array.isArray(contributions.slashCommands) || contributions.slashCommands.length === 0) {
        return null;
    }

    api.shell?.setSlashCommands?.(contributions.slashCommands);

    return () => {
        api.shell?.clearSlashCommands?.();
    };
}

function createPromptFragmentSetup(contributions, api) {
    if (!Array.isArray(contributions.promptFragments) || contributions.promptFragments.length === 0) {
        return null;
    }

    const handles = contributions.promptFragments
        .map((fragment) => api.prompt?.addFragment?.(fragment))
        .filter(Boolean);

    return () => {
        handles.forEach((handle) => {
            handle?.dispose?.();
        });
    };
}

function createPageExtractorSetup(contributions, api) {
    if (!Array.isArray(contributions.pageExtractors) || contributions.pageExtractors.length === 0) {
        return null;
    }

    const handles = contributions.pageExtractors
        .map((extractor) => api.page?.registerExtractor?.(extractor))
        .filter(Boolean);

    return () => {
        handles.forEach((handle) => {
            handle?.dispose?.();
        });
    };
}

function resolveActivationEventsForContributions(contributions, host) {
    const activationEvents = new Set();

    if (Array.isArray(contributions.promptFragments) && contributions.promptFragments.length > 0) {
        activationEvents.add('hook:onBuildPrompt');
    }
    if (Array.isArray(contributions.requestPolicies) && contributions.requestPolicies.length > 0) {
        activationEvents.add('hook:onBeforeSend');
        activationEvents.add('hook:onBuildPrompt');
        activationEvents.add('hook:onRequest');
        activationEvents.add('hook:onResponseError');
    }
    if (Array.isArray(contributions.pageExtractors) && contributions.pageExtractors.length > 0) {
        activationEvents.add('page.ready');
    }
    if (Array.isArray(contributions.selectionActions) && contributions.selectionActions.length > 0) {
        activationEvents.add('page.ready');
    }
    if (host === 'shell' && (
        (Array.isArray(contributions.inputActions) && contributions.inputActions.length > 0)
        || (Array.isArray(contributions.menuItems) && contributions.menuItems.length > 0)
        || (Array.isArray(contributions.slashCommands) && contributions.slashCommands.length > 0)
    )) {
        activationEvents.add('shell.ready');
    }

    return [...activationEvents];
}

function createDeclarativeContributionPlugin(descriptor = {}, { host = '' } = {}) {
    const manifest = descriptor?.manifest || {};
    const pluginId = normalizeString(descriptor.id || manifest.id);
    const contributions = normalizeDeclarativeContributions(manifest, pluginId);
    const normalizedHost = normalizeString(host);

    const hostHasContribution = normalizedHost === 'shell'
        ? contributions.promptFragments.length > 0
            || contributions.requestPolicies.length > 0
            || contributions.inputActions.length > 0
            || contributions.menuItems.length > 0
            || contributions.slashCommands.length > 0
        : normalizedHost === 'page'
            ? contributions.pageExtractors.length > 0
                || contributions.selectionActions.length > 0
            : false;

    if (!hostHasContribution) {
        return null;
    }

    return definePlugin({
        id: descriptor.id,
        displayName: descriptor?.manifest?.displayName,
        priority: descriptor?.manifest?.priority ?? 0,
        activationEvents: resolveActivationEventsForContributions(contributions, normalizedHost),
        setup(api) {
            const disposers = [];

            const addDisposer = (disposer) => {
                if (typeof disposer === 'function') {
                    disposers.push(disposer);
                }
            };

            if (normalizedHost === 'shell') {
                addDisposer(createPromptFragmentSetup(contributions, api));
                addDisposer(createInputActionSetup(contributions, api));
                addDisposer(createMenuItemSetup(contributions, api));
                addDisposer(createSlashCommandSetup(contributions, api));
            }

            if (normalizedHost === 'page') {
                addDisposer(createPageExtractorSetup(contributions, api));
                addDisposer(createSelectionActionSetup(contributions, api));
            }

            return () => {
                while (disposers.length > 0) {
                    const dispose = disposers.pop();
                    dispose?.();
                }
            };
        },
        onBeforeSend(payload, ctx) {
            let nextPayload = payload;

            contributions.requestPolicies.forEach((policy) => {
                if (!matchesPolicyTarget(policy, ctx, null, nextPayload)) {
                    return;
                }

                if (shouldCancelBeforeSend(policy, nextPayload)) {
                    ctx.chat.cancel(policy.cancel.reason);
                }
            });

            return nextPayload;
        },
        onBuildPrompt(ctx) {
            return contributions.requestPolicies.flatMap((policy) => {
                if (!matchesPolicyTarget(policy, ctx)) {
                    return [];
                }

                return policy.promptFragments;
            });
        },
        onRequest(requestDescriptor, ctx) {
            let nextDescriptor = requestDescriptor;

            contributions.requestPolicies.forEach((policy) => {
                if (!matchesPolicyTarget(policy, ctx, nextDescriptor)) {
                    return;
                }

                nextDescriptor = patchRequestDescriptor(nextDescriptor, policy.requestPatch);
            });

            return nextDescriptor;
        },
        onResponseError(error, ctx) {
            contributions.requestPolicies.forEach((policy) => {
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
            });
        },
    });
}

export function createDeclarativePluginEntry(descriptor = {}, { host = '' } = {}) {
    const plugin = createDeclarativeContributionPlugin(descriptor, {
        host,
    });

    if (!plugin) {
        return null;
    }

    return {
        plugin,
        manifest: descriptor.manifest ? { ...descriptor.manifest } : null,
    };
}
