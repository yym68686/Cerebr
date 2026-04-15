import { clearMessageInput, getFormattedMessageContent } from '../../components/message-input.js';

export function createDraftController({
    messageInput,
    uiConfig,
    storageAdapter,
    chatManager,
    getReadingProgressManager,
    draftKeyForChatId,
}) {
    let draftChatId = chatManager.getCurrentChat()?.id || null;
    let draftSaveTimer = null;
    let pendingReadingProgressChatId = null;
    let readingProgressRestoring = false;
    let readingProgressRestoredForChatId = null;

    const saveDraftNow = async (chatId = draftChatId) => {
        if (!chatId) return;
        const { message } = getFormattedMessageContent(messageInput);
        const draftText = (message || '').trimEnd();

        if (!draftText) {
            await storageAdapter.remove(draftKeyForChatId(chatId));
            return;
        }
        await storageAdapter.set({ [draftKeyForChatId(chatId)]: draftText });
    };

    const queueDraftSave = (chatId = draftChatId) => {
        clearTimeout(draftSaveTimer);
        draftSaveTimer = setTimeout(() => void saveDraftNow(chatId), 400);
    };

    const restoreDraft = async (chatId = draftChatId) => {
        if (!chatId) return;
        const key = draftKeyForChatId(chatId);
        const result = await storageAdapter.get(key);
        const draftText = result[key];
        const { message, imageTags } = getFormattedMessageContent(messageInput);
        const isInputEmpty = !message.trim() && imageTags.length === 0;
        if (!isInputEmpty || !draftText) return;

        messageInput.textContent = draftText;
        messageInput.dispatchEvent(new Event('input'));
    };

    const tryRestoreReadingProgress = async (chatId) => {
        if (!chatId) return;
        if (chatId !== chatManager.getCurrentChat()?.id) return;
        if (readingProgressRestoredForChatId === chatId) return;
        if (readingProgressRestoring) return;

        readingProgressRestoring = true;
        try {
            const ok = await getReadingProgressManager()?.restore(chatId);
            if (ok) {
                readingProgressRestoredForChatId = chatId;
                if (pendingReadingProgressChatId === chatId) pendingReadingProgressChatId = null;
            }
        } finally {
            readingProgressRestoring = false;
        }
    };

    const attach = () => {
        messageInput.addEventListener('input', () => {
            queueDraftSave(draftChatId);
        });

        void restoreDraft(draftChatId);

        document.addEventListener('cerebr:chatSwitched', (event) => {
            const nextChatId = event?.detail?.chatId;
            void (async () => {
                if (draftChatId && draftChatId !== nextChatId) {
                    await saveDraftNow(draftChatId);
                }
                draftChatId = nextChatId || null;
                clearMessageInput(messageInput, uiConfig);
                await restoreDraft(draftChatId);
                pendingReadingProgressChatId = draftChatId;
                readingProgressRestoredForChatId = null;
            })();
        });

        document.addEventListener('cerebr:chatContentChunk', (event) => {
            const chatId = event?.detail?.chatId;
            if (!chatId) return;
            if (pendingReadingProgressChatId !== chatId) return;
            void tryRestoreReadingProgress(chatId);
        });
    };

    return {
        attach,
        saveDraftNow,
        restoreDraft,
        getDraftChatId: () => draftChatId,
    };
}
