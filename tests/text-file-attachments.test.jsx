import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ComposerFiles, TextFiles } from '../src/app/components/ComposerFiles.jsx';
import { useComposerDraft } from '../src/app/hooks/useComposerDraft.js';
import { createEditorController } from '../src/runtime/input/editor-controller.js';
import { addFilesToDraft } from '../src/runtime/input/file-drop.js';
import { setDraftFiles, splitTextFileMessage } from '../src/runtime/input/draft-files.js';
import { composeDraftMessage } from '../src/runtime/input/draft-message.js';
import { splitQuotedMessage } from '../src/runtime/input/draft-quotes.js';
import { setMessageInputContent } from '../src/runtime/input/native-editor.js';
import { serializeDraftSnapshot } from '../src/runtime/input/draft-snapshot.js';
let host, root, input, editor;
beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: () => ({width: 1}) });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    function Composer() {
        const ref = useRef(null), row = useRef(null);
        const draft = useComposerDraft(ref, row);
        return <div data-composer data-expanded={draft.expanded} data-empty={draft.empty}>
            <ComposerFiles files={draft.textFiles} inputRef={ref} />
            <div data-composer-attachments />
            <div ref={row}><div className="message-input-shell"><div ref={ref} contentEditable suppressContentEditableWarning /></div></div>
        </div>;
    }
    await act(async () => root.render(<Composer />));
    input = host.querySelector('[contenteditable]'); editor = createEditorController({messageInput: input});
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 45)); });

it('keeps TXT out of editable DOM, expands even for file-only drafts, and collapses on removal', async () => {
    const text = '<script>literal</script>\n'.repeat(40000);
    await act(async () => addFilesToDraft(input, [new File([text], 'large.txt', {type:'text/plain'})]));
    await settle();
    expect(input.textContent).toBe('');
    expect(input.childNodes).toHaveLength(0);
    expect(host.querySelector('[data-composer]').dataset.expanded).toBe('true');
    expect(host.querySelector('[data-composer]').dataset.empty).toBe('false');
    expect(host.textContent).toContain('large.txt');
    expect(host.textContent.length).toBeLessThan(100);
    expect(structuredClone(serializeDraftSnapshot(editor.getDraftSnapshot())).textFiles[0].text).toBe(text);
    await act(async () => host.querySelector('.text-file-remove').click());
    await settle();
    expect(editor.hasDraft()).toBe(false);
    expect(host.querySelector('[data-composer]').dataset.expanded).toBe('false');
});

it('round-trips file contents, quote, images and question through storage, send and message chips', async () => {
    const files = [{id:'f1', name:'notes.txt', text:'first\n---\n\nlast', size:18}, {id:'f2',name:'empty.txt',text:'',size:0}];
    setMessageInputContent(input, [{type:'text',text:'Question'}, {type:'image_url',image_url:{url:'data:image/png;base64,AQ=='}}], {}, ['Quote'], files);
    const draft = editor.getDraftSnapshot();
    const stored = structuredClone({content:draft.text, quotes:draft.quotes, textFiles:draft.textFiles});
    editor.clear();
    setMessageInputContent(input, stored.content, {}, stored.quotes, stored.textFiles);
    expect(editor.getDraftSnapshot().textFiles).toEqual(files);
    const message = composeDraftMessage(draft);
    expect(message.content[0].text).toContain(files[0].text);
    expect(JSON.stringify(message.textFiles)).not.toContain('first');
    const attached = splitTextFileMessage(structuredClone(message));
    expect(attached.files).toEqual(files);
    expect(splitQuotedMessage({...message, content:attached.content})).toMatchObject({quotes:['Quote'],content:[{type:'text',text:'Question'},{type:'image_url',image_url:{url:'data:image/png;base64,AQ=='}}]});
    await act(async () => root.render(<TextFiles files={attached.files} />));
    expect(host.textContent).toContain('notes.txt');
    expect(host.textContent).not.toContain('first');
    expect(splitTextFileMessage({...message,content:'Plugin rewrote the message'})).toEqual({content:'Plugin rewrote the message',files:[]});
});

it('discards delayed TXT reads after navigation rather than attaching to the next chat', async () => {
    let reader;
    vi.stubGlobal('FileReader', class { constructor() {reader=this;} readAsText() {} });
    const importing = addFilesToDraft(input, [new File(['old'], 'old.txt')]);
    editor.setDraft('New chat');
    reader.result='old'; reader.onload();
    await importing;
    expect(editor.getDraftSnapshot().textFiles).toEqual([]);
    expect(editor.getDraft()).toBe('New chat');
});
