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
import { hasPendingFileImports } from '../src/runtime/input/file-import-state.js';
import { DOCX_MIME, DOCX_TOTAL_TEXT } from '../src/runtime/input/docx-limits.js';
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
            <ComposerFiles files={draft.textFiles} reading={draft.readingFiles} inputRef={ref} />
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

function mockWorker() {
    const workers = [];
    vi.stubGlobal('Worker', class {
        constructor() { workers.push(this); }
        postMessage() {}
        terminate = vi.fn();
    });
    return workers;
}

it('imports DOCX via a worker, previews literal text without executing markup, and downloads Markdown', async () => {
    const workers = mockWorker();
    const file = new File(['zip'], 'report.DOCX', { type: DOCX_MIME });
    const text = '# Report\n\n<script>literal</script>\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
    const importing = addFilesToDraft(input, [file]);
    expect(hasPendingFileImports(input)).toBe(true);
    await settle();
    expect(host.querySelector('[role=status]')).not.toBeNull();
    await act(async () => { workers[0].onmessage({ data: { text } }); await importing; });
    await settle();
    expect(hasPendingFileImports(input)).toBe(false);
    expect(input.textContent).toBe('');
    expect(editor.getDraftSnapshot().textFiles[0]).toMatchObject({ name: 'report.DOCX', text });
    const message = composeDraftMessage(editor.getDraftSnapshot());
    expect(splitTextFileMessage(structuredClone(message)).files[0].text).toBe(text);
    expect(message.content).toContain(text);
    await act(async () => host.querySelector('.text-file-label').click());
    const dialog = document.querySelector('dialog');
    expect(dialog.querySelector('pre').textContent).toBe(text);
    expect(dialog.querySelector('script')).toBeNull();
    // No format-limitation banners in the composer or preview.
    expect(dialog.querySelector('p')).toBeNull();
    vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:test'); static revokeObjectURL = vi.fn(); });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
        expect(this.download).toBe('report.DOCX.md');
    });
    await act(async () => dialog.querySelector(':scope > button').click());
    expect(clicked).toHaveBeenCalledOnce();
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true})));
    expect(document.querySelector('dialog')).toBeNull();
});

it('cancels stale DOCX imports on draft replacement without locking the next chat', async () => {
    const workers = mockWorker();
    const old = addFilesToDraft(input, [new File(['zip'], 'old.docx')]);
    editor.setDraft('Next chat');
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(hasPendingFileImports(input)).toBe(false);
    const next = addFilesToDraft(input, [new File(['zip'], 'next.docx')]);
    await old;
    expect(hasPendingFileImports(input)).toBe(true);
    await act(async () => { workers[1].onmessage({ data: { text: 'New document' } }); await next; });
    expect(editor.getDraftSnapshot().textFiles.map(file => file.name)).toEqual(['next.docx']);
    expect(editor.getDraft()).toBe('Next chat');
    expect(hasPendingFileImports(input)).toBe(false);
});

it('rejects aggregate DOCX text overflow and preserves existing attachments', async () => {
    const workers = mockWorker();
    setDraftFiles(input, [{ name: 'large.txt', text: 'a'.repeat(DOCX_TOTAL_TEXT), size: DOCX_TOTAL_TEXT }]);
    const rejected = expect(addFilesToDraft(input, [new File(['zip'], 'more.docx')])).rejects.toThrow();
    workers[0].onmessage({ data: { text: 'Too much' } });
    await rejected;
    expect(editor.getDraftSnapshot().textFiles).toHaveLength(1);
    expect(hasPendingFileImports(input)).toBe(false);
});

it.each([
    ['paper.PDF', 'application/pdf', 'paper.PDF'],
    ['document', 'application/pdf', 'document.pdf'],
    ['no-mime.pdf', '', 'no-mime.pdf'],
])('imports PDF %s, persists it as text and previews/downloads without mounting markup', async (name, type, savedName) => {
    const workers = mockWorker();
    const text = 'First page\n<script>literal text</script>\n\n第二页';
    editor.setDraft('Summarize this');
    const importing = addFilesToDraft(input, [new File(['%PDF-1.7'], name, {type})]);
    expect(hasPendingFileImports(input)).toBe(true);
    await act(async () => {
        workers[0].onmessage({data:{type:'cerebr:pdf-result',text}});
        await importing;
    });
    await settle();
    expect(editor.getDraft()).toBe('Summarize this');
    const stored = structuredClone(serializeDraftSnapshot(editor.getDraftSnapshot()));
    expect(stored.textFiles[0]).toMatchObject({name:savedName,text});
    editor.clear();
    setMessageInputContent(input, stored.content, {}, stored.quotes, stored.textFiles);
    const message = composeDraftMessage(editor.getDraftSnapshot());
    const parsed = splitTextFileMessage(structuredClone(message));
    expect(parsed.files[0]).toMatchObject({name:savedName,text});
    expect(message.content).toContain(text);
    expect(JSON.stringify(message.textFiles)).not.toContain('First page');
    await act(async () => root.render(<TextFiles files={parsed.files} />));
    await act(async () => host.querySelector('.text-file-label').click());
    const dialog = document.querySelector('dialog');
    expect(dialog.querySelector('pre').textContent).toBe(text);
    expect(dialog.querySelector('script')).toBeNull();
    expect(dialog.querySelector('p')).toBeNull();
    vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:pdf'); static revokeObjectURL = vi.fn(); });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
        expect(this.download).toBe(`${savedName}.txt`);
    });
    await act(async () => dialog.querySelector(':scope > button').click());
    expect(clicked).toHaveBeenCalledOnce();
    await act(async () => dialog.querySelector('header button').click());
    expect(document.querySelector('dialog')).toBeNull();
});

it('cancels PDF parsing on navigation and allows the next chat to import another PDF', async () => {
    const workers = mockWorker();
    const old = addFilesToDraft(input, [new File(['%PDF'], 'old.pdf')]);
    editor.setDraft('Next chat');
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(hasPendingFileImports(input)).toBe(false);
    const next = addFilesToDraft(input, [new File(['%PDF'], 'next.pdf')]);
    workers[0].onmessage({data:{type:'cerebr:pdf-result',text:'Stale PDF'}});
    await old;
    expect(hasPendingFileImports(input)).toBe(true);
    await act(async () => { workers[1].onmessage({data:{type:'cerebr:pdf-result',text:'New PDF'}}); await next; });
    expect(editor.getDraftSnapshot().textFiles.map(file => file.name)).toEqual(['next.pdf']);
    expect(editor.getDraft()).toBe('Next chat');
    expect(hasPendingFileImports(input)).toBe(false);
});

it('preserves existing attachments and unlocks sending after PDF parsing fails', async () => {
    const workers = mockWorker();
    setDraftFiles(input, [{name:'existing.txt',text:'Keep me',size:7}]);
    const rejected = expect(addFilesToDraft(input, [new File(['%PDF'], 'locked.pdf')])).rejects.toThrow();
    workers[0].onmessage({data:{type:'cerebr:pdf-result',error:'pdf_password'}});
    await rejected;
    expect(editor.getDraftSnapshot().textFiles.map(file => file.name)).toEqual(['existing.txt']);
    expect(hasPendingFileImports(input)).toBe(false);
});

it.each(['more.pdf', 'more.docx', 'more.txt'])('enforces the shared PDF/DOCX/TXT text budget when adding %s', async (name) => {
    const workers = mockWorker();
    setDraftFiles(input, [{name:'existing.pdf',text:'x'.repeat(DOCX_TOTAL_TEXT),size:100}]);
    const rejected = expect(addFilesToDraft(input, [new File(['More text'], name)])).rejects.toThrow();
    if (name.endsWith('.pdf')) workers[0].onmessage({data:{type:'cerebr:pdf-result',text:'More text'}});
    if (name.endsWith('.docx')) workers[0].onmessage({data:{text:'More text'}});
    await rejected;
    expect(editor.getDraftSnapshot().textFiles).toHaveLength(1);
    expect(hasPendingFileImports(input)).toBe(false);
});
