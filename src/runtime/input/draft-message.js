import { buildMessageContent } from './native-editor.js';
import { quotedText } from './draft-quotes.js';
import { withTextFiles, textFileMetadata } from './draft-files.js';

export function composeDraftMessage(draft) {
    return {
        content: buildMessageContent(withTextFiles(quotedText(draft.text, draft.quotes), draft.textFiles), draft.imageTags),
        ...(draft.quotes?.length ? { selectionQuotes: [...draft.quotes], selectionQuestion: draft.text } : {}),
        ...(draft.textFiles?.length ? { textFiles: textFileMetadata(draft.textFiles) } : {}),
    };
}
