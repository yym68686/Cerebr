import {
    loadPluginLocale,
    t,
    getLocaleLabel,
    getSeedCommandMeta,
} from './helpers/plugin-i18n.js';
import { expandLanguagePlaceholders } from './helpers/language-placeholders.js';
import seedPromptsSource from './seed-prompts.json' with { type: 'json' };

const STORAGE_KEY = 'cerebr_plugin_lite_slash_commands_v1';
const STORAGE_SCHEMA_VERSION = 1;
const DEFAULT_SEED_VERSION = '2026-04-17-minimal-seed-1';
const SEED_ORDER = ['explain', 'translate', 'summarize', 'code_explain'];

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function normalizeTimestamp(value, fallback = Date.now()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeAliasList(value) {
    const items = Array.isArray(value)
        ? value
        : String(value ?? '').split(/[\n,]+/g);
    const aliases = [];
    const unique = new Set();

    items.forEach((item) => {
        const alias = normalizeString(item);
        if (!alias) {
            return;
        }

        const lookup = alias.toLowerCase();
        if (unique.has(lookup)) {
            return;
        }

        unique.add(lookup);
        aliases.push(alias);
    });

    return aliases;
}

function createCommandId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `slash-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function buildSearchText(command) {
    return [
        normalizeString(command.name).toLowerCase(),
        normalizeString(command.label).toLowerCase(),
        normalizeString(command.description).toLowerCase(),
        ...normalizeAliasList(command.aliases).map((alias) => alias.toLowerCase()),
    ]
        .filter(Boolean)
        .join('\n');
}

function decorateCommand(command) {
    return {
        ...command,
        aliases: normalizeAliasList(command.aliases),
        searchText: buildSearchText(command),
    };
}

function normalizeStoredCommandEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    const name = normalizeString(entry.name);
    const prompt = String(entry.prompt ?? '').trim();
    if (!name || !prompt) {
        return null;
    }

    const now = Date.now();
    const seedKey = normalizeString(entry.seedKey);

    return decorateCommand({
        id: normalizeString(entry.id, createCommandId()),
        name,
        label: normalizeString(entry.label, name),
        prompt,
        description: normalizeString(entry.description),
        aliases: normalizeAliasList(entry.aliases),
        createdAt: normalizeTimestamp(entry.createdAt, now),
        updatedAt: normalizeTimestamp(entry.updatedAt, now),
        seedKey: seedKey || undefined,
    });
}

function normalizeEnvelope(rawEnvelope, { fallbackInitializedAt = Date.now() } = {}) {
    const commandsSource = Array.isArray(rawEnvelope?.commands)
        ? rawEnvelope.commands
        : Array.isArray(rawEnvelope)
            ? rawEnvelope
            : [];

    return {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        seedVersion: normalizeString(rawEnvelope?.seedVersion, DEFAULT_SEED_VERSION),
        commands: commandsSource
            .map((entry) => normalizeStoredCommandEntry(entry))
            .filter(Boolean),
        meta: {
            initializedAt: normalizeTimestamp(rawEnvelope?.meta?.initializedAt, fallbackInitializedAt),
            lastResetAt: rawEnvelope?.meta?.lastResetAt
                ? normalizeTimestamp(rawEnvelope.meta.lastResetAt, fallbackInitializedAt)
                : null,
            userManagedAt: rawEnvelope?.meta?.userManagedAt
                ? normalizeTimestamp(rawEnvelope.meta.userManagedAt, fallbackInitializedAt)
                : null,
        },
    };
}

function serializeEnvelope(envelope) {
    return {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        seedVersion: normalizeString(envelope?.seedVersion, DEFAULT_SEED_VERSION),
        commands: Array.isArray(envelope?.commands)
            ? envelope.commands.map((command) => {
                const out = {
                    id: command.id,
                    name: command.name,
                    label: command.label,
                    prompt: command.prompt,
                    description: command.description,
                    aliases: [...normalizeAliasList(command.aliases)],
                    createdAt: command.createdAt,
                    updatedAt: command.updatedAt,
                };
                if (command.seedKey) {
                    out.seedKey = command.seedKey;
                }
                return out;
            })
            : [],
        meta: {
            initializedAt: normalizeTimestamp(envelope?.meta?.initializedAt, Date.now()),
            lastResetAt: envelope?.meta?.lastResetAt
                ? normalizeTimestamp(envelope.meta.lastResetAt, Date.now())
                : null,
            userManagedAt: envelope?.meta?.userManagedAt
                ? normalizeTimestamp(envelope.meta.userManagedAt, Date.now())
                : null,
        },
    };
}

function parseImportedEnvelope(rawText, existingEnvelope = null) {
    const payload = JSON.parse(rawText);
    const fallbackInitializedAt = existingEnvelope?.meta?.initializedAt || Date.now();

    if (Array.isArray(payload)) {
        return normalizeEnvelope({
            schemaVersion: STORAGE_SCHEMA_VERSION,
            seedVersion: existingEnvelope?.seedVersion || DEFAULT_SEED_VERSION,
            commands: payload,
            meta: {
                initializedAt: fallbackInitializedAt,
                lastResetAt: existingEnvelope?.meta?.lastResetAt || null,
            },
        }, {
            fallbackInitializedAt,
        });
    }

    if (payload && typeof payload === 'object' && Array.isArray(payload.commands)) {
        return normalizeEnvelope(payload, {
            fallbackInitializedAt,
        });
    }

    throw new Error('Imported JSON must be an array or an object with a commands array');
}

function buildSeedEnvelopeFromLocale(seedPrompts, currentEnvelope = null) {
    const initializedAt = currentEnvelope?.meta?.initializedAt
        ? normalizeTimestamp(currentEnvelope.meta.initializedAt, Date.now())
        : Date.now();
    const now = Date.now();

    const commands = SEED_ORDER.map((seedKey) => {
        const meta = getSeedCommandMeta(seedKey);
        const prompt = String(seedPrompts?.[seedKey] ?? '').trim();
        if (!meta || !prompt) {
            return null;
        }

        return decorateCommand({
            id: createCommandId(),
            name: meta.name,
            label: meta.label || meta.name,
            prompt,
            description: meta.description || '',
            aliases: [],
            createdAt: now,
            updatedAt: now,
            seedKey,
        });
    }).filter(Boolean);

    if (!commands.length) {
        throw new Error('Seed generation produced zero commands — check locale JSON integrity');
    }

    return {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        seedVersion: DEFAULT_SEED_VERSION,
        commands,
        meta: {
            initializedAt,
            lastResetAt: now,
        },
    };
}

function refreshSeedCommandsForLocale(envelope) {
    if (!envelope?.commands?.length) {
        return false;
    }

    let changed = false;
    envelope.commands = envelope.commands.map((command) => {
        if (!command.seedKey) {
            return command;
        }

        const meta = getSeedCommandMeta(command.seedKey);
        if (!meta) {
            return command;
        }

        if (command.name === meta.name
            && command.label === (meta.label || meta.name)
            && command.description === (meta.description || '')) {
            return command;
        }

        changed = true;
        return decorateCommand({
            ...command,
            name: meta.name,
            label: meta.label || meta.name,
            description: meta.description || '',
            updatedAt: Date.now(),
        });
    });

    return changed;
}

async function loadSeedPrompts() {
    if (!seedPromptsSource || typeof seedPromptsSource !== 'object' || Array.isArray(seedPromptsSource)) {
        throw new Error('seed-prompts.json must be a JSON object');
    }

    return seedPromptsSource;
}

function createBlankCommandValues(indexHint = 1) {
    return {
        name: t('ui.blank_command_name', [indexHint]),
        label: '',
        aliases: '',
        description: '',
        prompt: t('ui.blank_command_prompt'),
    };
}

function commandToFormValues(command) {
    return {
        name: normalizeString(command?.name),
        label: normalizeString(command?.label),
        aliases: Array.isArray(command?.aliases) ? command.aliases.join(', ') : '',
        description: normalizeString(command?.description),
        prompt: String(command?.prompt ?? ''),
    };
}

function readCommandFromValues(values = {}, existingCommand = null) {
    const name = normalizeString(values.name);
    if (!name) {
        throw new Error(t('ui.error_name_required'));
    }

    const prompt = String(values.prompt ?? '').trim();
    if (!prompt) {
        throw new Error(t('ui.error_prompt_required'));
    }

    const now = Date.now();
    return decorateCommand({
        id: normalizeString(existingCommand?.id, createCommandId()),
        name,
        label: normalizeString(values.label, name),
        prompt,
        description: normalizeString(values.description),
        aliases: normalizeAliasList(values.aliases),
        createdAt: normalizeTimestamp(existingCommand?.createdAt, now),
        updatedAt: now,
        seedKey: normalizeString(existingCommand?.seedKey) || undefined,
    });
}

function cloneFieldValues(values = {}) {
    return {
        name: String(values?.name ?? ''),
        label: String(values?.label ?? ''),
        aliases: String(values?.aliases ?? ''),
        description: String(values?.description ?? ''),
        prompt: String(values?.prompt ?? ''),
    };
}

function formatTimestamp(timestamp, locale) {
    try {
        return new Intl.DateTimeFormat(locale || 'en', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        }).format(new Date(timestamp));
    } catch {
        return new Date(timestamp).toLocaleDateString();
    }
}

const runtimeState = {
    api: null,
    commandEnvelope: null,
    currentLocale: 'en',
    editorMode: 'create',
    editorValues: createBlankCommandValues(1),
    importText: '',
    pageMode: 'manage',
    pageOpen: false,
    pageViewRevision: 0,
    selectedCommandId: '',
    stopHandles: [],
};

function getCommands() {
    return runtimeState.commandEnvelope?.commands || [];
}

function getSelectedCommand() {
    return getCommands().find((command) => command.id === runtimeState.selectedCommandId) || null;
}

function ensureEditorSelection() {
    const commands = getCommands();
    if (runtimeState.editorMode === 'create') {
        runtimeState.editorValues = cloneFieldValues(runtimeState.editorValues);
        return;
    }

    const selected = getSelectedCommand();
    if (selected) {
        runtimeState.editorValues = commandToFormValues(selected);
        return;
    }

    if (commands[0]) {
        runtimeState.selectedCommandId = commands[0].id;
        runtimeState.editorMode = 'edit';
        runtimeState.editorValues = commandToFormValues(commands[0]);
        return;
    }

    runtimeState.selectedCommandId = '';
    runtimeState.editorMode = 'create';
    runtimeState.editorValues = createBlankCommandValues(1);
}

function beginCreateCommand() {
    runtimeState.selectedCommandId = '';
    runtimeState.editorMode = 'create';
    runtimeState.editorValues = createBlankCommandValues(getCommands().length + 1);
    runtimeState.pageViewRevision += 1;
}

function beginEditCommand(commandId) {
    const command = getCommands().find((item) => item.id === commandId);
    if (!command) {
        beginCreateCommand();
        return;
    }

    runtimeState.selectedCommandId = command.id;
    runtimeState.editorMode = 'edit';
    runtimeState.editorValues = commandToFormValues(command);
    runtimeState.pageViewRevision += 1;
}

async function readStoredEnvelope() {
    const result = await runtimeState.api.storage.get(STORAGE_KEY);
    const stored = result?.[STORAGE_KEY];
    if (typeof stored === 'string') {
        try {
            return JSON.parse(stored);
        } catch {
            return null;
        }
    }
    return stored || null;
}

async function writeStoredEnvelope(envelope) {
    await runtimeState.api.storage.set({
        [STORAGE_KEY]: serializeEnvelope(envelope),
    });
}

async function loadInitialEnvelope() {
    const storedEnvelope = await readStoredEnvelope();
    if (storedEnvelope && typeof storedEnvelope === 'object') {
        const normalizedEnvelope = normalizeEnvelope(storedEnvelope, {
            fallbackInitializedAt: Date.now(),
        });
        if (normalizedEnvelope.commands.length > 0) {
            return normalizedEnvelope;
        }

        if (normalizedEnvelope.meta?.userManagedAt) {
            return normalizedEnvelope;
        }
    }

    const seedPrompts = await loadSeedPrompts();
    const seededEnvelope = buildSeedEnvelopeFromLocale(seedPrompts);
    await writeStoredEnvelope(seededEnvelope);
    return seededEnvelope;
}

async function persistEnvelope(nextEnvelope) {
    runtimeState.commandEnvelope = normalizeEnvelope(nextEnvelope, {
        fallbackInitializedAt: runtimeState.commandEnvelope?.meta?.initializedAt || Date.now(),
    });
    runtimeState.commandEnvelope.meta = {
        ...runtimeState.commandEnvelope.meta,
        userManagedAt: Date.now(),
    };
    await writeStoredEnvelope(runtimeState.commandEnvelope);
    ensureEditorSelection();
    await syncSlashCommands();
}

function buildSlashCommandDescriptors(commands = []) {
    const localeLabel = getLocaleLabel();

    return commands.map((command, index) => ({
        id: command.id,
        name: command.name,
        label: command.label || command.name,
        description: command.description || '',
        aliases: [...normalizeAliasList(command.aliases)],
        prompt: expandLanguagePlaceholders(String(command.prompt ?? '').trimEnd(), localeLabel),
        separator: '\n\n',
        order: index,
    }));
}

async function syncSlashCommands() {
    const commands = buildSlashCommandDescriptors(getCommands());
    await runtimeState.api.shell.setSlashCommands(commands, {
        emptyText: t('ui.picker_empty'),
    });
}

async function syncMenuItems() {
    await runtimeState.api.shell.setMenuItems([{
        id: 'open-slash-commands',
        icon: '/',
        label: t('ui.menu_label'),
        title: t('ui.menu_title'),
        order: 65,
    }]);
}

function createTopActions() {
    return [
        {
            id: 'create-command',
            label: t('ui.create_command'),
            variant: 'primary',
        },
        {
            id: 'reset-defaults',
            label: t('ui.reset_defaults'),
            variant: 'warning',
            confirm: t('ui.reset_defaults'),
        },
        {
            id: 'open-import',
            label: t('ui.import_json'),
        },
        {
            id: 'open-export',
            label: t('ui.export_json'),
        },
    ];
}

function createCommandListItems() {
    const commands = getCommands();
    return commands.map((command, index) => ({
        id: command.id,
        title: command.label || command.name,
        description: command.description || `/${command.name}`,
        meta: `/${command.name}`,
        selected: runtimeState.editorMode === 'edit' && runtimeState.selectedCommandId === command.id,
        actionId: 'select-command',
        actions: [
            {
                id: 'move-up',
                icon: '↑',
                title: t('ui.move_up'),
                disabled: index === 0,
            },
            {
                id: 'move-down',
                icon: '↓',
                title: t('ui.move_down'),
                disabled: index === commands.length - 1,
            },
            {
                id: 'delete-command',
                icon: '🗑',
                title: t('ui.delete_command'),
                variant: 'danger',
                confirm: t('ui.delete_command'),
            },
        ],
    }));
}

function buildManageView() {
    const selectedCommand = getSelectedCommand();
    const editorTitle = runtimeState.editorMode === 'create'
        ? t('ui.create_command')
        : (selectedCommand?.label || selectedCommand?.name || t('ui.settings_title'));
    const editorDescription = runtimeState.editorMode === 'edit' && selectedCommand
        ? t('ui.command_meta', [
            selectedCommand.id,
            formatTimestamp(selectedCommand.createdAt, runtimeState.currentLocale),
            formatTimestamp(selectedCommand.updatedAt, runtimeState.currentLocale),
        ])
        : t('ui.settings_subtitle');

    return {
        sections: [
            {
                kind: 'card',
                variant: 'subtle',
                title: t('ui.settings_title'),
                description: t('ui.settings_subtitle'),
                body: [
                    {
                        kind: 'stats',
                        items: [
                            {
                                label: t('ui.status_count', [getCommands().length]).replace(/^[^0-9\u4e00-\u9fa5A-Za-z]*/, ''),
                                value: String(getCommands().length),
                                tone: 'primary',
                            },
                            {
                                label: 'Locale',
                                value: getLocaleLabel(),
                                tone: 'muted',
                            },
                        ],
                    },
                    {
                        kind: 'actions',
                        actions: createTopActions(),
                    },
                ],
            },
            {
                kind: 'card',
                title: t('ui.settings_title'),
                description: t('ui.status_count', [getCommands().length]),
                body: [
                    {
                        kind: 'list',
                        emptyText: t('ui.list_empty'),
                        items: createCommandListItems(),
                    },
                ],
            },
            {
                kind: 'card',
                title: editorTitle,
                description: editorDescription,
                body: [
                    {
                        kind: 'form',
                        fields: [
                            {
                                id: 'name',
                                label: t('ui.field_name_label'),
                                type: 'text',
                                value: runtimeState.editorValues.name,
                                placeholder: t('ui.field_name_placeholder'),
                            },
                            {
                                id: 'label',
                                label: t('ui.field_label_label'),
                                type: 'text',
                                value: runtimeState.editorValues.label,
                                placeholder: t('ui.field_label_placeholder'),
                            },
                            {
                                id: 'aliases',
                                label: t('ui.field_aliases_label'),
                                type: 'textarea',
                                value: runtimeState.editorValues.aliases,
                                placeholder: t('ui.field_aliases_placeholder'),
                                description: t('ui.field_aliases_note'),
                                rows: 3,
                            },
                            {
                                id: 'description',
                                label: t('ui.field_description_label'),
                                type: 'textarea',
                                value: runtimeState.editorValues.description,
                                placeholder: t('ui.field_description_placeholder'),
                                rows: 3,
                            },
                            {
                                id: 'prompt',
                                label: t('ui.field_prompt_label'),
                                type: 'textarea',
                                value: runtimeState.editorValues.prompt,
                                placeholder: t('ui.field_prompt_placeholder'),
                                rows: 10,
                                span: 2,
                            },
                        ],
                    },
                    {
                        kind: 'actions',
                        actions: [
                            {
                                id: 'save-command',
                                label: t('ui.save_changes'),
                                variant: 'primary',
                            },
                            {
                                id: 'move-current-up',
                                label: t('ui.move_up'),
                                disabled: runtimeState.editorMode !== 'edit'
                                    || getCommands().findIndex((item) => item.id === runtimeState.selectedCommandId) <= 0,
                            },
                            {
                                id: 'move-current-down',
                                label: t('ui.move_down'),
                                disabled: runtimeState.editorMode !== 'edit'
                                    || getCommands().findIndex((item) => item.id === runtimeState.selectedCommandId) === -1
                                    || getCommands().findIndex((item) => item.id === runtimeState.selectedCommandId) >= getCommands().length - 1,
                            },
                            {
                                id: 'delete-current',
                                label: t('ui.delete_command'),
                                variant: 'danger',
                                disabled: runtimeState.editorMode !== 'edit',
                                confirm: t('ui.delete_command'),
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

function buildImportView() {
    return {
        sections: [
            {
                kind: 'card',
                title: t('ui.import_json'),
                description: t('ui.import_note'),
                body: [
                    {
                        kind: 'form',
                        fields: [
                            {
                                id: 'import-json',
                                label: t('ui.import_json'),
                                type: 'textarea',
                                value: runtimeState.importText,
                                placeholder: t('ui.import_json'),
                                rows: 16,
                                span: 2,
                            },
                        ],
                    },
                    {
                        kind: 'actions',
                        actions: [
                            {
                                id: 'apply-import',
                                label: t('ui.import_action'),
                                variant: 'primary',
                            },
                            {
                                id: 'apply-import-file',
                                icon: '📄',
                                title: t('ui.import_json'),
                                kind: 'file',
                                accept: '.json,application/json',
                            },
                            {
                                id: 'back-manage',
                                label: t('ui.back_to_list'),
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

function buildExportText() {
    return JSON.stringify(serializeEnvelope(runtimeState.commandEnvelope), null, 2);
}

function buildExportView() {
    const exportText = runtimeState.importText || buildExportText();
    return {
        sections: [
            {
                kind: 'card',
                title: t('ui.export_json'),
                description: t('ui.import_note'),
                body: [
                    {
                        kind: 'form',
                        fields: [
                            {
                                id: 'export-json',
                                label: t('ui.export_json'),
                                type: 'textarea',
                                value: exportText,
                                rows: 16,
                                span: 2,
                            },
                        ],
                    },
                    {
                        kind: 'actions',
                        actions: [
                            {
                                id: 'copy-export',
                                label: t('ui.export_action'),
                                variant: 'primary',
                            },
                            {
                                id: 'back-manage',
                                label: t('ui.back_to_list'),
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

function buildCurrentPage() {
    const pageId = `slash-commands.${runtimeState.pageMode}`;
    const base = {
        id: pageId,
        title: runtimeState.pageMode === 'import'
            ? t('ui.import_json')
            : runtimeState.pageMode === 'export'
                ? t('ui.export_json')
                : t('ui.settings_title'),
        subtitle: runtimeState.pageMode === 'manage'
            ? t('ui.settings_subtitle')
            : t('ui.import_note'),
        viewStateKey: `${runtimeState.pageMode}:${runtimeState.editorMode}:${runtimeState.selectedCommandId || 'new'}:${runtimeState.pageViewRevision}`,
    };

    if (runtimeState.pageMode === 'import') {
        return {
            ...base,
            view: buildImportView(),
        };
    }

    if (runtimeState.pageMode === 'export') {
        return {
            ...base,
            view: buildExportView(),
        };
    }

    return {
        ...base,
        view: buildManageView(),
    };
}

async function renderCurrentPage({ resetViewState = false, reopen = false } = {}) {
    const page = {
        ...buildCurrentPage(),
        resetViewState,
    };

    if (!runtimeState.pageOpen || reopen) {
        await runtimeState.api.shell.openPage(page);
        runtimeState.pageOpen = true;
        return;
    }

    await runtimeState.api.shell.updatePage(page);
}

async function moveCommand(commandId, delta) {
    const commands = [...getCommands()];
    const index = commands.findIndex((command) => command.id === commandId);
    if (index === -1) {
        return false;
    }

    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= commands.length) {
        runtimeState.api.ui.showToast(t('ui.status_no_move'));
        return false;
    }

    const [command] = commands.splice(index, 1);
    commands.splice(nextIndex, 0, command);
    await persistEnvelope({
        ...runtimeState.commandEnvelope,
        commands,
    });
    beginEditCommand(command.id);
    runtimeState.api.ui.showToast(t('ui.status_reordered', [command.name]));
    await renderCurrentPage({ resetViewState: true });
    return true;
}

async function deleteCommand(commandId) {
    const commands = [...getCommands()];
    const index = commands.findIndex((command) => command.id === commandId);
    if (index === -1) {
        runtimeState.api.ui.showToast(t('ui.error_nothing_to_delete'));
        return false;
    }

    const [removed] = commands.splice(index, 1);
    await persistEnvelope({
        ...runtimeState.commandEnvelope,
        commands,
    });

    if (commands[index]) {
        beginEditCommand(commands[index].id);
    } else if (commands[index - 1]) {
        beginEditCommand(commands[index - 1].id);
    } else {
        beginCreateCommand();
    }

    runtimeState.api.ui.showToast(t('ui.status_deleted', [removed.name]));
    await renderCurrentPage({ resetViewState: true });
    return true;
}

async function saveCurrentCommand(values) {
    const sourceValues = cloneFieldValues(values || runtimeState.editorValues);
    const existing = runtimeState.editorMode === 'edit' ? getSelectedCommand() : null;
    const nextCommand = readCommandFromValues(sourceValues, existing);
    const commands = [...getCommands()];

    if (runtimeState.editorMode === 'edit' && existing) {
        const index = commands.findIndex((command) => command.id === existing.id);
        if (index >= 0) {
            commands[index] = nextCommand;
        }
    } else {
        commands.push(nextCommand);
    }

    await persistEnvelope({
        ...runtimeState.commandEnvelope,
        commands,
    });
    beginEditCommand(nextCommand.id);
    runtimeState.api.ui.showToast(t('ui.status_saved', [nextCommand.name]));
    await renderCurrentPage({ resetViewState: true });
}

async function resetDefaults() {
    const seedPrompts = await loadSeedPrompts();
    const nextEnvelope = buildSeedEnvelopeFromLocale(seedPrompts, runtimeState.commandEnvelope);
    await persistEnvelope(nextEnvelope);
    if (nextEnvelope.commands[0]) {
        beginEditCommand(nextEnvelope.commands[0].id);
    } else {
        beginCreateCommand();
    }
    runtimeState.api.ui.showToast(t('ui.status_reset_done'));
    await renderCurrentPage({ resetViewState: true });
}

async function importEnvelopeFromText(rawText) {
    if (!normalizeString(rawText)) {
        throw new Error(t('ui.error_json_required'));
    }

    let nextEnvelope = null;
    try {
        nextEnvelope = parseImportedEnvelope(rawText, runtimeState.commandEnvelope);
    } catch (error) {
        throw new Error(t('ui.error_json_parse', [error?.message || String(error)]));
    }

    await persistEnvelope(nextEnvelope);
    runtimeState.importText = '';
    if (nextEnvelope.commands[0]) {
        beginEditCommand(nextEnvelope.commands[0].id);
    } else {
        beginCreateCommand();
    }
    runtimeState.pageMode = 'manage';
    runtimeState.pageViewRevision += 1;
    runtimeState.api.ui.showToast(t('ui.status_imported', [nextEnvelope.commands.length]));
    await renderCurrentPage({ resetViewState: true, reopen: true });
}

async function copyExportText(text) {
    const payload = String(text ?? buildExportText());
    try {
        await navigator.clipboard.writeText(payload);
        runtimeState.api.ui.showToast(t('ui.status_exported_copied'));
    } catch {
        runtimeState.api.ui.showToast(t('ui.status_exported_textarea'));
    }
}

function updateDraftValues(values = {}) {
    runtimeState.editorValues = cloneFieldValues({
        ...runtimeState.editorValues,
        ...values,
    });
}

async function handleManageAction(event) {
    const actionId = normalizeString(event?.actionId);
    const itemId = normalizeString(event?.itemId);
    const values = event?.values && typeof event.values === 'object' ? event.values : {};

    if (actionId === 'create-command') {
        beginCreateCommand();
        await renderCurrentPage({ resetViewState: true });
        return;
    }

    if (actionId === 'reset-defaults') {
        await resetDefaults();
        return;
    }

    if (actionId === 'open-import') {
        runtimeState.pageMode = 'import';
        runtimeState.pageViewRevision += 1;
        await renderCurrentPage({ resetViewState: true, reopen: true });
        return;
    }

    if (actionId === 'open-export') {
        runtimeState.pageMode = 'export';
        runtimeState.importText = buildExportText();
        runtimeState.pageViewRevision += 1;
        await renderCurrentPage({ resetViewState: true, reopen: true });
        return;
    }

    if (actionId === 'select-command') {
        beginEditCommand(itemId);
        await renderCurrentPage({ resetViewState: true });
        return;
    }

    if (actionId === 'move-up') {
        await moveCommand(itemId, -1);
        return;
    }

    if (actionId === 'move-down') {
        await moveCommand(itemId, 1);
        return;
    }

    if (actionId === 'delete-command') {
        await deleteCommand(itemId);
        return;
    }

    if (actionId === 'save-command') {
        await saveCurrentCommand(values);
        return;
    }

    if (actionId === 'move-current-up' && runtimeState.selectedCommandId) {
        await moveCommand(runtimeState.selectedCommandId, -1);
        return;
    }

    if (actionId === 'move-current-down' && runtimeState.selectedCommandId) {
        await moveCommand(runtimeState.selectedCommandId, 1);
        return;
    }

    if (actionId === 'delete-current' && runtimeState.selectedCommandId) {
        await deleteCommand(runtimeState.selectedCommandId);
    }
}

async function handleImportAction(event) {
    const actionId = normalizeString(event?.actionId);
    if (actionId === 'back-manage') {
        runtimeState.pageMode = 'manage';
        runtimeState.pageViewRevision += 1;
        ensureEditorSelection();
        await renderCurrentPage({ resetViewState: true, reopen: true });
        return;
    }

    if (actionId === 'apply-import-file') {
        const firstFile = Array.isArray(event?.files) ? event.files[0] : null;
        await importEnvelopeFromText(firstFile?.text || '');
        return;
    }

    if (actionId === 'apply-import') {
        const values = event?.values && typeof event.values === 'object' ? event.values : {};
        await importEnvelopeFromText(values['import-json'] ?? runtimeState.importText);
    }
}

async function handleExportAction(event) {
    const actionId = normalizeString(event?.actionId);
    if (actionId === 'back-manage') {
        runtimeState.pageMode = 'manage';
        runtimeState.importText = '';
        runtimeState.pageViewRevision += 1;
        ensureEditorSelection();
        await renderCurrentPage({ resetViewState: true, reopen: true });
        return;
    }

    if (actionId === 'copy-export') {
        const values = event?.values && typeof event.values === 'object' ? event.values : {};
        await copyExportText(values['export-json'] ?? runtimeState.importText);
    }
}

async function handlePageEvent(event = {}) {
    if (event?.type === 'open') {
        runtimeState.pageOpen = true;
        return;
    }

    if (event?.type === 'close') {
        runtimeState.pageOpen = false;
        return;
    }

    if (event?.type === 'change') {
        if (runtimeState.pageMode === 'manage') {
            updateDraftValues({
                [event.fieldId]: event.value,
            });
            return;
        }

        if (runtimeState.pageMode === 'import' && event.fieldId === 'import-json') {
            runtimeState.importText = String(event.value ?? '');
            return;
        }

        if (runtimeState.pageMode === 'export' && event.fieldId === 'export-json') {
            runtimeState.importText = String(event.value ?? '');
        }
        return;
    }

    if (event?.type !== 'action') {
        return;
    }

    try {
        if (runtimeState.pageMode === 'manage') {
            await handleManageAction(event);
            return;
        }
        if (runtimeState.pageMode === 'import') {
            await handleImportAction(event);
            return;
        }
        if (runtimeState.pageMode === 'export') {
            await handleExportAction(event);
        }
    } catch (error) {
        runtimeState.api.ui.showToast(error?.message || String(error));
    }
}

async function reloadLocale(locale) {
    runtimeState.currentLocale = normalizeString(locale, 'en');
    await loadPluginLocale(runtimeState.currentLocale);

    const changed = refreshSeedCommandsForLocale(runtimeState.commandEnvelope);
    if (changed) {
        await writeStoredEnvelope(runtimeState.commandEnvelope);
    }

    await syncSlashCommands();
    await syncMenuItems();
    if (runtimeState.pageOpen) {
        runtimeState.pageViewRevision += 1;
        ensureEditorSelection();
        await renderCurrentPage({ resetViewState: true, reopen: true });
    }
}

async function openManagePage() {
    runtimeState.pageMode = 'manage';
    runtimeState.pageViewRevision += 1;
    ensureEditorSelection();
    await renderCurrentPage({ resetViewState: true, reopen: true });
}

export default {
    id: 'local.slash-commands',

    async setup(api) {
        runtimeState.api = api;
        runtimeState.currentLocale = await Promise.resolve(api.i18n?.getLocale?.());
        await loadPluginLocale(runtimeState.currentLocale || 'en');

        runtimeState.commandEnvelope = await loadInitialEnvelope();
        ensureEditorSelection();
        await syncSlashCommands();
        await syncMenuItems();

        const stopMenuActions = api.shell.onMenuAction(async ({ itemId } = {}) => {
            if (itemId !== 'open-slash-commands') {
                return;
            }
            await openManagePage();
        });

        const stopPageEvents = api.shell.onPageEvent((event) => {
            void handlePageEvent(event);
        });

        const stopLocale = api.i18n?.onLocaleChanged?.(({ locale } = {}) => {
            void reloadLocale(locale || runtimeState.currentLocale || 'en');
        });

        runtimeState.stopHandles = [stopMenuActions, stopPageEvents, stopLocale].filter(Boolean);

        return async () => {
            while (runtimeState.stopHandles.length > 0) {
                const stop = runtimeState.stopHandles.pop();
                try {
                    stop?.();
                } catch {
                    // ignore
                }
            }

            await api.shell.clearSlashCommands?.();
            await api.shell.clearMenuItems?.();
            if (runtimeState.pageOpen) {
                await api.shell.closePage?.('stop');
            }
        };
    },
};
