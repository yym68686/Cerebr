import { isPluginBridgeMessage } from '../bridge/plugin-bridge.js';
import { createPluginManager } from '../shared/plugin-manager.js';
import { isPluginEnabled, readPluginSettings, subscribePluginSettings } from '../shared/plugin-store.js';
import { getInstalledScriptPlugins } from '../dev/local-plugin-service.js';
import { readDeveloperModePreference, subscribeDeveloperModePreference } from '../dev/developer-mode.js';
import { createScriptPluginCacheKey, loadScriptPluginModule } from '../dev/script-plugin-loader.js';
import {
    getFormattedMessageContent,
    insertTextIntoMessageInput,
    moveCaretToEnd,
    setMessageInputText,
} from '../../components/message-input.js';

function getBuiltinShellPlugins() {
    return [];
}

export function createShellPluginRuntime({
    messageInput,
} = {}) {
    const editorApi = {
        focus() {
            messageInput?.focus?.({ preventScroll: true });
            if (messageInput) {
                moveCaretToEnd(messageInput);
            }
        },
        setDraft(text) {
            if (!messageInput) return;
            setMessageInputText(messageInput, String(text ?? ''));
            editorApi.focus();
        },
        insertText(text, options = {}) {
            if (!messageInput) return;
            insertTextIntoMessageInput(messageInput, String(text ?? ''), options);
            editorApi.focus();
        },
        importText(text, { focus = true } = {}) {
            if (!messageInput) return;

            const value = String(text ?? '').trim();
            if (!value) return;

            const { message, imageTags } = getFormattedMessageContent(messageInput);
            const hasExistingDraft = !!String(message || '').trim() || (imageTags?.length || 0) > 0;

            if (!hasExistingDraft) {
                setMessageInputText(messageInput, value);
            } else {
                insertTextIntoMessageInput(messageInput, value, { separator: '\n\n' });
            }

            if (focus) {
                editorApi.focus();
            }
        },
    };

    const api = {
        editor: editorApi,
    };

    const pluginManager = createPluginManager({
        plugins: getBuiltinShellPlugins(),
        api,
        logger: console,
    });
    const scriptPluginCache = new Map();
    let unsubscribePluginSettings = null;
    let unsubscribeDeveloperMode = null;
    let pluginSyncPromise = Promise.resolve();
    let developerModeEnabled = false;
    let started = false;

    const getRegisteredPluginIds = () => new Set(
        pluginManager.getPlugins().map((plugin) => plugin?.id).filter(Boolean)
    );

    const resolveScriptPlugin = async (descriptor) => {
        const signature = createScriptPluginCacheKey(descriptor);
        const cached = scriptPluginCache.get(descriptor.id);
        if (cached?.signature === signature && cached.plugin) {
            return {
                plugin: cached.plugin,
                changed: false,
            };
        }

        const plugin = await loadScriptPluginModule(descriptor);
        scriptPluginCache.set(descriptor.id, { signature, plugin });
        return {
            plugin,
            changed: true,
        };
    };

    const applyPluginSettings = async (settings) => {
        const installedScriptPlugins = await getInstalledScriptPlugins({ scope: 'shell' });
        const activeScriptPlugins = installedScriptPlugins.filter((descriptor) => {
            return developerModeEnabled || descriptor.sourceType !== 'developer';
        });
        const desiredPluginIds = new Set(activeScriptPlugins.map((descriptor) => descriptor.id));
        const activePluginIds = new Set(pluginManager.getActivePluginIds());
        const registeredPluginIds = getRegisteredPluginIds();

        for (const descriptor of activeScriptPlugins) {
            const shouldEnable = descriptor.compatible &&
                descriptor.runtimeSupported &&
                isPluginEnabled(settings, descriptor.id, descriptor.manifest?.defaultEnabled !== false);

            if (!shouldEnable) {
                if (registeredPluginIds.has(descriptor.id)) {
                    await pluginManager.unregister(descriptor.id);
                    registeredPluginIds.delete(descriptor.id);
                    activePluginIds.delete(descriptor.id);
                }
                continue;
            }

            try {
                const { plugin, changed } = await resolveScriptPlugin(descriptor);
                if (changed || !activePluginIds.has(descriptor.id)) {
                    await pluginManager.register(plugin);
                    registeredPluginIds.add(descriptor.id);
                    activePluginIds.add(descriptor.id);
                }
            } catch (error) {
                scriptPluginCache.delete(descriptor.id);
                if (registeredPluginIds.has(descriptor.id)) {
                    await pluginManager.unregister(descriptor.id);
                    registeredPluginIds.delete(descriptor.id);
                    activePluginIds.delete(descriptor.id);
                }
                console.error(`[Cerebr] Failed to load shell script plugin "${descriptor.id}"`, error);
            }
        }

        for (const pluginId of [...scriptPluginCache.keys()]) {
            if (desiredPluginIds.has(pluginId)) continue;

            scriptPluginCache.delete(pluginId);
            if (registeredPluginIds.has(pluginId)) {
                await pluginManager.unregister(pluginId);
            }
        }
    };

    const syncPlugins = ({ settings = null, developerMode = null } = {}) => {
        pluginSyncPromise = pluginSyncPromise
            .then(async () => {
                if (!started) return;

                developerModeEnabled = typeof developerMode === 'boolean'
                    ? developerMode
                    : await readDeveloperModePreference();
                const effectiveSettings = settings || await readPluginSettings();
                await applyPluginSettings(effectiveSettings);
            })
            .catch((error) => {
                console.error('[Cerebr] Failed to sync shell plugins', error);
            });

        return pluginSyncPromise;
    };

    const handleBridgeMessage = (event) => {
        if (!isPluginBridgeMessage(event?.data, 'shell')) return;

        const { command, payload = {} } = event.data;

        if (command === 'editor.focus') {
            editorApi.focus();
            return;
        }
        if (command === 'editor.setDraft') {
            editorApi.setDraft(payload.text);
            return;
        }
        if (command === 'editor.insertText') {
            editorApi.insertText(payload.text, payload.options || {});
            return;
        }
        if (command === 'editor.importText') {
            editorApi.importText(payload.text, { focus: payload.focus !== false });
        }
    };

    const start = async () => {
        if (started) return;
        started = true;
        window.addEventListener('message', handleBridgeMessage);
        await pluginManager.start();
        developerModeEnabled = await readDeveloperModePreference();
        await syncPlugins({
            settings: await readPluginSettings(),
            developerMode: developerModeEnabled,
        });
        unsubscribePluginSettings = subscribePluginSettings((settings) => {
            void syncPlugins({ settings });
        });
        unsubscribeDeveloperMode = subscribeDeveloperModePreference((enabled) => {
            void syncPlugins({ developerMode: enabled });
        });
    };

    const stop = async () => {
        if (!started) return;
        started = false;
        window.removeEventListener('message', handleBridgeMessage);
        unsubscribePluginSettings?.();
        unsubscribePluginSettings = null;
        unsubscribeDeveloperMode?.();
        unsubscribeDeveloperMode = null;
        scriptPluginCache.clear();
        await pluginManager.stop();
    };

    return {
        start,
        stop,
        api,
        manager: pluginManager,
    };
}
