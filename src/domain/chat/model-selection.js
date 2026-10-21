// Keep the model name with the conversation, but never duplicate API secrets.
export function modelSelection(config) {
    return config?.id && config.modelName
        ? { configId: config.id, modelName: config.modelName }
        : null;
}

export function getChatModelSelection(chat, apis) {
    return chat?.modelSelection || (chat ? apis.legacySelection : null) ||
        apis.defaultSelection || modelSelection(apis.configs[apis.selected]);
}

export function resolveChatApiConfig(chat, apis) {
    const selection = getChatModelSelection(chat, apis);
    const config = apis.configs.find(config => config.id === selection?.configId);
    // A removed/missing connection must not silently substitute another model.
    return config ? { ...config, modelName: selection.modelName } : undefined;
}
