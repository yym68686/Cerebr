// An empty name means automatic selection is pending discovery. Keep the
// connection ID so it cannot fall back to a different provider while loading.
// Never duplicate API secrets in conversations or model preferences.
export function modelSelection(config) {
    return config?.id ? { configId: config.id, modelName: config.modelName || '' } : null;
}

export function configModelSelection(config, apis, name) {
    return modelSelection(
        config && {
            ...config,
            modelName: name?.trim() || config.modelName?.trim() || apis.modelLists?.[config.id]?.[0] || '',
        }
    );
}

export function configModelNames(config, apis) {
    return [...new Set([config.modelName?.trim(), ...(apis.modelLists?.[config.id] || [])].filter(Boolean))];
}

export function getChatModelSelection(chat, apis) {
    const selection = chat?.modelSelection || (chat ? apis.legacySelection : null) || apis.defaultSelection;
    if (selection?.modelName) return selection;
    const config = selection
        ? apis.configs.find((config) => config.id === selection.configId)
        : apis.configs[apis.selected] || apis.configs[0];
    return configModelSelection(config, apis) || selection;
}

export function resolveChatApiConfig(chat, apis) {
    const selection = getChatModelSelection(chat, apis);
    const config = apis.configs.find((config) => config.id === selection?.configId);
    // A removed/missing connection must not silently substitute another model.
    return config ? { ...config, modelName: selection.modelName } : undefined;
}
