import { createShellInputActionManager } from './shell-input-action-manager.js';
import { createShellMenuManager } from './shell-menu-manager.js';
import { createShellModalManager } from './shell-modal-manager.js';
import { createShellPageManager } from './shell-page-manager.js';
import { createShellSlashCommandManager } from './shell-slash-command-manager.js';

function normalizeString(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

export function createShellHostManager({
    inputActionsContainer = null,
    menuItemsContainer = null,
    slashCommandsContainer = null,
    messageInput = null,
    inputContainer = null,
    editor = null,
    pageElements = {},
    logger = console,
    onLayoutSync = null,
} = {}) {
    const inputActionManager = createShellInputActionManager({
        container: inputActionsContainer,
        logger,
    });
    const menuManager = createShellMenuManager({
        container: menuItemsContainer,
        logger,
    });
    const slashCommandManager = createShellSlashCommandManager({
        container: slashCommandsContainer,
        messageInput,
        inputContainer,
        editor,
        logger,
        onLayoutSync,
    });
    const modalManager = createShellModalManager();
    const pageManager = createShellPageManager({
        ...pageElements,
        logger,
    });

    const syncLayout = () => {
        if (typeof onLayoutSync === 'function') {
            onLayoutSync();
        }
    };

    return {
        setInputActions(pluginId, actions = []) {
            const nextActions = inputActionManager.setActions(pluginId, actions);
            syncLayout();
            return nextActions;
        },
        clearInputActions(pluginId) {
            const cleared = inputActionManager.clearActions(pluginId);
            syncLayout();
            return cleared;
        },
        onInputAction(pluginId, callback) {
            return inputActionManager.addListener(pluginId, callback);
        },
        setMenuItems(pluginId, items = []) {
            return menuManager.setItems(pluginId, items);
        },
        clearMenuItems(pluginId) {
            return menuManager.clearItems(pluginId);
        },
        onMenuAction(pluginId, callback) {
            return menuManager.addListener(pluginId, callback);
        },
        setSlashCommands(pluginId, commands = [], options = {}) {
            const nextCommands = slashCommandManager.setCommands(pluginId, commands, options);
            syncLayout();
            return nextCommands;
        },
        clearSlashCommands(pluginId) {
            const cleared = slashCommandManager.clearCommands(pluginId);
            syncLayout();
            return cleared;
        },
        onSlashCommandEvent(callback) {
            return slashCommandManager.addListener(callback);
        },
        showModal(pluginId, mountElement, options = {}) {
            const modalHandle = modalManager.present(pluginId, mountElement, options);
            syncLayout();
            return modalHandle;
        },
        updateModal(pluginId, options = {}) {
            const modalHandle = modalManager.update(pluginId, options);
            syncLayout();
            return modalHandle;
        },
        hideModal(pluginId) {
            const dismissed = modalManager.dismiss(pluginId);
            syncLayout();
            return dismissed;
        },
        openPage(pluginId, mountElement, page = {}) {
            const pageHandle = pageManager.present(pluginId, mountElement, page);
            syncLayout();
            return pageHandle;
        },
        updatePage(pluginId, page = {}) {
            return pageManager.update(pluginId, page);
        },
        closePage(pluginId, reason = 'programmatic') {
            const dismissed = pageManager.dismiss(pluginId, normalizeString(reason, 'programmatic'));
            syncLayout();
            return dismissed;
        },
        closeActivePage(reason = 'programmatic') {
            const dismissed = pageManager.dismissActive(normalizeString(reason, 'programmatic'));
            syncLayout();
            return dismissed;
        },
        hasOpenPage(pluginId = '') {
            return pageManager.isOpen(pluginId);
        },
        onPageEvent(pluginId, callback) {
            return pageManager.addListener(pluginId, callback);
        },
        removePlugin(pluginId) {
            inputActionManager.removePlugin(pluginId);
            menuManager.removePlugin(pluginId);
            slashCommandManager.removePlugin(pluginId);
            modalManager.dismiss(pluginId);
            pageManager.removePlugin(pluginId);
            syncLayout();
            return true;
        },
    };
}
