import { pluginUiStore } from './plugin-ui-store.js';
function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function normalizeNumber(value, fallback = 0) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeStringArray(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => normalizeString(item))
            .filter(Boolean);
    }

    return String(value ?? '')
        .split(/[\n,]+/g)
        .map((item) => normalizeString(item))
        .filter(Boolean);
}

function createPluginRecord() {
    return {
        commands: [],
        options: {
            emptyText: '',
        },
    };
}

function normalizeSlashCommandDescriptor(command = {}, index = 0) {
    const name = normalizeString(command?.name);
    const prompt = String(command?.prompt ?? '').trimEnd();
    if (!name || !prompt) {
        return null;
    }

    const aliases = normalizeStringArray(command?.aliases);
    const label = normalizeString(command?.label, name);
    const description = normalizeString(command?.description);

    return {
        id: normalizeString(command?.id, `slash-${index}`),
        name,
        label,
        description,
        aliases,
        prompt,
        separator: Object.prototype.hasOwnProperty.call(command || {}, 'separator')
            ? String(command.separator ?? '')
            : '\n\n',
        disabled: !!command?.disabled,
        order: normalizeNumber(command?.order, index),
        searchText: [
            name.toLowerCase(),
            label.toLowerCase(),
            description.toLowerCase(),
            ...aliases.map((alias) => alias.toLowerCase()),
        ]
            .filter(Boolean)
            .join('\n'),
    };
}

function normalizeOptions(options = {}) {
    return {
        emptyText: normalizeString(options?.emptyText),
    };
}

function createMergedCommandRecord(pluginId, command) {
    return {
        pluginId: normalizeString(pluginId),
        command: {
            ...command,
        },
    };
}

function normalizeDraftTextFromSnapshot(text) {
    return String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/\u200b/g, '');
}

function buildExpandedDraft(command, trailingText) {
    const prompt = String(command?.prompt ?? '').trimEnd();
    const tail = String(trailingText ?? '').trimStart();
    if (!tail) {
        return prompt;
    }

    const separator = Object.prototype.hasOwnProperty.call(command || {}, 'separator')
        ? String(command?.separator ?? '')
        : '\n\n';

    if (!separator) {
        return `${prompt}${tail}`;
    }

    return `${prompt}${separator}${tail}`;
}

function createCommandPayload(record = {}) {
    return {
        pluginId: normalizeString(record?.pluginId),
        commandId: normalizeString(record?.command?.id),
        command: record?.command ? { ...record.command } : null,
    };
}

export function createShellSlashCommandManager({
    container = null,
    messageInput = null,
    inputContainer = null,
    editor = null,
    logger = console,
    onLayoutSync = null,
} = {}) {
    const subscriptions = new AbortController();
    const listen = (target, type, listener, capture = false) => target.addEventListener(type, listener, { capture, signal: subscriptions.signal });
    const pluginRecords = new Map();
    const listeners = new Set();
    const runtimeState = {
        activeIndex: 0,
        isComposing: false,
        openState: null,
    };

    function syncLayout() {
        if (typeof onLayoutSync === 'function') {
            onLayoutSync();
        }
    }

    function ensurePluginRecord(pluginId) {
        const normalizedPluginId = normalizeString(pluginId);
        if (!normalizedPluginId) {
            return null;
        }

        let record = pluginRecords.get(normalizedPluginId);
        if (!record) {
            record = createPluginRecord();
            pluginRecords.set(normalizedPluginId, record);
        }
        return record;
    }

    function prunePluginRecord(pluginId) {
        const normalizedPluginId = normalizeString(pluginId);
        const record = pluginRecords.get(normalizedPluginId);
        if (!record) {
            return false;
        }

        if (record.commands.length > 0) {
            return false;
        }

        pluginRecords.delete(normalizedPluginId);
        return true;
    }

    function getMergedCommands() {
        const merged = [];
        pluginRecords.forEach((record, pluginId) => {
            record.commands.forEach((command) => {
                if (command.disabled) {
                    return;
                }
                merged.push(createMergedCommandRecord(pluginId, command));
            });
        });

        return merged.sort((left, right) => {
            const orderDelta = normalizeNumber(left?.command?.order) - normalizeNumber(right?.command?.order);
            if (orderDelta !== 0) {
                return orderDelta;
            }

            return normalizeString(left?.command?.name).localeCompare(normalizeString(right?.command?.name));
        });
    }

    function getEmptyText(matchesLength) {
        if (matchesLength > 0) {
            return '';
        }

        for (const [, record] of pluginRecords.entries()) {
            if (record?.options?.emptyText) {
                return record.options.emptyText;
            }
        }

        return 'No matching slash commands.';
    }

    function hide() {
        runtimeState.activeIndex = 0;
        runtimeState.openState = null;
        render();
    }

    function dispatch(event = {}) {
        listeners.forEach((listener) => {
            try {
                listener(event);
            } catch (error) {
                logger?.error?.('[Cerebr] Failed to handle shell slash command event', error);
            }
        });
    }

    function applySelection(record) {
        if (!record?.command) {
            return;
        }

        const trailingText = runtimeState.openState?.trailingText;
        const nextDraft = buildExpandedDraft(record.command, trailingText);
        hide();
        editor?.setDraft?.(nextDraft);
        editor?.focus?.();

        dispatch({
            type: 'select',
            trailingText: normalizeString(trailingText),
            ...createCommandPayload(record),
        });
    }

    function parseOpenState(snapshot) {
        if (!snapshot || runtimeState.isComposing) {
            return null;
        }
        if (Array.isArray(snapshot.imageTags) && snapshot.imageTags.length > 0) {
            return null;
        }

        const draftText = normalizeDraftTextFromSnapshot(snapshot.text);
        if (!draftText.startsWith('/')) {
            return null;
        }

        const withoutSlash = draftText.slice(1);
        const firstWhitespace = withoutSlash.search(/\s/);
        const query = (firstWhitespace === -1
            ? withoutSlash
            : withoutSlash.slice(0, firstWhitespace)
        ).trim().toLowerCase();
        const trailingText = firstWhitespace === -1
            ? ''
            : withoutSlash.slice(firstWhitespace).trimStart();

        const matches = getMergedCommands().filter((record) => {
            if (!query) {
                return true;
            }
            return record.command.searchText.includes(query);
        });

        return {
            draftText,
            query,
            trailingText,
            matches,
            emptyText: getEmptyText(matches.length),
        };
    }

    function render() {
        const open = runtimeState.openState;
        pluginUiStore.set({ commands: open ? { ...open, activeIndex: runtimeState.activeIndex, select: applySelection, activate: index => { runtimeState.activeIndex = index; render(); } } : null });
        syncLayout();
        return true;
    }

    function refreshFromEditor() {
        const snapshot = editor?.getDraftSnapshot?.();
        const nextState = parseOpenState(snapshot);
        if (!nextState) {
            hide();
            return;
        }

        runtimeState.openState = nextState;
        const maxIndex = Math.max(nextState.matches.length - 1, 0);
        runtimeState.activeIndex = Math.max(0, Math.min(runtimeState.activeIndex, maxIndex));
        render();
    }

    function handleComposerKeydown(event) {
        if (!runtimeState.openState) {
            return;
        }

        if (runtimeState.isComposing) {
            return;
        }

        const matches = Array.isArray(runtimeState.openState.matches)
            ? runtimeState.openState.matches
            : [];

        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            hide();
            return;
        }

        if (!matches.length) {
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopImmediatePropagation();
            runtimeState.activeIndex = (runtimeState.activeIndex + 1) % matches.length;
            render();
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopImmediatePropagation();
            runtimeState.activeIndex = (runtimeState.activeIndex - 1 + matches.length) % matches.length;
            render();
            return;
        }

        if (event.key === 'Enter') {
            event.preventDefault();
            event.stopImmediatePropagation();
            applySelection(matches[runtimeState.activeIndex]);
        }
    }

    if (messageInput instanceof HTMLElement) {
        listen(messageInput, 'input', () => {
            refreshFromEditor();
        });
        listen(messageInput, 'compositionstart', () => {
            runtimeState.isComposing = true;
            hide();
        });
        listen(messageInput, 'compositionend', () => {
            runtimeState.isComposing = false;
            refreshFromEditor();
        });
        listen(messageInput, 'keydown', handleComposerKeydown, true);
        listen(messageInput, 'blur', () => {
            hide();
        });
    }

    listen(document, 'pointerdown', (event) => {
        const target = event.target;
        if (inputContainer instanceof HTMLElement && inputContainer.contains(target)) {
            return;
        }
        hide();
    }, true);

    return {
        dispose() { subscriptions.abort(); hide(); },
        setCommands(pluginId, commands = [], options = {}) {
            const record = ensurePluginRecord(pluginId);
            if (!record) {
                return [];
            }

            record.commands = Array.isArray(commands)
                ? commands.map((command, index) => normalizeSlashCommandDescriptor(command, index)).filter(Boolean)
                : [];
            record.options = normalizeOptions(options);
            refreshFromEditor();
            return record.commands.map((command) => ({ ...command }));
        },
        clearCommands(pluginId) {
            const normalizedPluginId = normalizeString(pluginId);
            const record = pluginRecords.get(normalizedPluginId);
            if (!record) {
                return false;
            }

            record.commands = [];
            record.options = normalizeOptions();
            prunePluginRecord(normalizedPluginId);
            refreshFromEditor();
            return true;
        },
        addListener(listener) {
            if (typeof listener !== 'function') {
                return () => {};
            }

            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        removePlugin(pluginId) {
            const normalizedPluginId = normalizeString(pluginId);
            const record = pluginRecords.get(normalizedPluginId);
            if (!record) {
                return false;
            }

            record.commands = [];
            record.options = normalizeOptions();
            prunePluginRecord(normalizedPluginId);
            refreshFromEditor();
            return true;
        },
    };
}
