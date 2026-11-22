import { useEffect, useState } from 'react';
import { isLegacyQuestionTitle } from '../../domain/chat/chat-title.js';
import { subscribeLocalChanges, subscribeRemoteChanges } from '../../runtime/sync/replica.js';
import { readCachedWebpageTitles, webpageSourceChatId } from '../../runtime/sync/webpage-sources.js';
import { withDb } from '../../utils/storage-adapter.js';

export function useLegacyChatTitles(loaded, chats) {
    const [titles, setTitles] = useState(() => new Map());
    useEffect(() => {
        if (!loaded) return;
        let active = true, reading = false, queued = false;
        const refresh = async () => {
            if (reading) {
                queued = true;
                return;
            }
            reading = true;
            do {
                queued = false;
                const result = await withDb(readCachedWebpageTitles).catch(() => null);
                if (active && result) setTitles(result);
            } while (active && queued);
            reading = false;
        };
        const onChange = (keys) => {
            if (keys.some((key) => {
                const id = webpageSourceChatId(key);
                // A source may arrive from sync before its chat does.
                return id && (!chats.has(id) || isLegacyQuestionTitle(chats.get(id)));
            })) void refresh();
        };
        const offLocal = subscribeLocalChanges(onChange);
        const offRemote = subscribeRemoteChanges(onChange);
        void refresh();
        return () => {
            active = false;
            offLocal();
            offRemote();
        };
    }, [loaded, chats]);
    return titles;
}
