import { serializeDraftSnapshot } from '../src/runtime/input/draft-snapshot.js';
import { describe, expect, it } from 'vitest';
import { createEditorController } from '../src/runtime/input/editor-controller.js';
import { buildMessageContent, setMessageInputContent } from '../src/runtime/input/native-editor.js';
describe('native editor data boundary', () => {
    it('preserves multiple image parts and text through editing, snapshots and draft restoration', () => {
        const input = document.createElement('div');
        document.body.append(input);
        const content = [
            { type: 'text', text: '第一行\n第二行' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,Ag==' } },
        ];
        setMessageInputContent(input, content);
        const editor = createEditorController({ messageInput: input });
        const snapshot = editor.getDraftSnapshot();
        expect(snapshot.imageTags).toHaveLength(2);
        expect(structuredClone(serializeDraftSnapshot(snapshot)).imageTags.map((t) => t.dataUrl)).toEqual(
            content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url)
        );
        expect(snapshot.empty).toBe(false);
        expect(buildMessageContent(snapshot.text, snapshot.imageTags)).toEqual(content);
        editor.clear();
        expect(editor.getDraftSnapshot().empty).toBe(true);
        input.remove();
    });
});
