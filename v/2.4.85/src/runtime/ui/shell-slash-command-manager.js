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

        const nextDraft = buildExpandedDraft(record.command, runtimeState.openState?.trailingText);
        hide();
        editor?.setDraft?.(nextDraft);
        editor?.focus?.();

        dispatch({
            type: 'select',
            trailingText: normalizeString(runtimeState.openState?.trailingText),
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

    function createCommandButton(record, index) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'cerebr-plugin-slash-command__item';
        item.dataset.commandId = record.command.id;
        item.dataset.active = index === runtimeState.activeIndex ? 'true' : 'false';

        item.addEventListener('mousedown', (event) => {
            event.preventDefault();
        });
        item.addEventListener('mouseenter', () => {
            runtimeState.activeIndex = index;
            render();
        });
        item.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            applySelection(record);
        });

        const tokenRow = document.createElement('div');
        tokenRow.className = 'cerebr-plugin-slash-command__token-row';

        const token = document.createElement('span');
        token.className = 'cerebr-plugin-slash-command__token';
        token.textContent = `/${record.command.name}`;
        tokenRow.appendChild(token);

        const label = document.createElement('span');
        label.className = 'cerebr-plugin-slash-command__label';
        label.textContent = record.command.label;
        tokenRow.appendChild(label);

        item.appendChild(tokenRow);

        if (record.command.description) {
            const description = document.createElement('span');
            description.className = 'cerebr-plugin-slash-command__description';
            description.textContent = record.command.description;
            item.appendChild(description);
        }

        return item;
    }

    function render() {
        if (!(container instanceof HTMLElement)) {
            return false;
        }

        const openState = runtimeState.openState;
        container.replaceChildren();
        container.hidden = !openState;
        container.dataset.open = openState ? 'true' : 'false';

        if (!openState) {
            syncLayout();
            return true;
        }

        const panel = document.createElement('div');
        panel.className = 'cerebr-plugin-slash-command';

        if (openState.matches.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'cerebr-plugin-slash-command__empty';
            empty.textContent = openState.emptyText;
            panel.appendChild(empty);
        } else {
            const list = document.createElement('div');
            list.className = 'cerebr-plugin-slash-command__list';
            openState.matches.forEach((record, index) => {
                list.appendChild(createCommandButton(record, index));
            });
            panel.appendChild(list);
        }

        container.appendChild(panel);
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
        messageInput.addEventListener('input', () => {
            refreshFromEditor();
        });
        messageInput.addEventListener('compositionstart', () => {
            runtimeState.isComposing = true;
            hide();
        });
        messageInput.addEventListener('compositionend', () => {
            runtimeState.isComposing = false;
            refreshFromEditor();
        });
        messageInput.addEventListener('keydown', handleComposerKeydown, true);
        messageInput.addEventListener('blur', () => {
            hide();
        });
    }

    document.addEventListener('pointerdown', (event) => {
        const target = event.target;
        if (inputContainer instanceof HTMLElement && inputContainer.contains(target)) {
            return;
        }
        hide();
    }, true);

    return {
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
