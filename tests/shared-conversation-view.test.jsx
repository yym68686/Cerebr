import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({ importConversation: vi.fn() }));
vi.mock('../src/runtime/chat/conversation-share.js', () => ({
    importConversation: service.importConversation,
    shareIdFromHash: (hash) => /^#\/share\/([a-f0-9]{48})$/.exec(hash)?.[1],
}));
vi.mock('../src/utils/i18n.js', () => ({ t: (key) => key }));
vi.mock('../src/app/state/ui-store.js', () => ({ openPage: vi.fn() }));
import { useSharedConversation, SharedConversationStatus } from '../src/app/components/SharedConversation.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const id = 'a'.repeat(48);
const chat = { id: 'local-copy', messages: [{ role: 'assistant', content: 'Readable shared answer' }] };
let host, root, session;
function View() {
    const shared = useSharedConversation(session);
    return <main>
        <SharedConversationStatus shared={shared} />
        <article>{shared.chat?.messages[0].content}</article>
        <input data-composer disabled={shared.pending} />
    </main>;
}
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
beforeEach(() => {
    vi.clearAllMocks();
    history.replaceState(null, '', `/#/share/${id}`);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    session = { switchChat: vi.fn(async () => {
        document.dispatchEvent(new CustomEvent('cerebr:chatSwitched'));
    }) };
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    history.replaceState(null, '', '/');
});
const render = async () => {
    await act(async () => root.render(<View />));
    await act(async () => {
        await vi.waitFor(() => expect(service.importConversation).toHaveBeenCalled());
    });
};

it('shows the conversation while saving silently, without a modal or import status', async () => {
    const save = deferred();
    service.importConversation.mockImplementation(async (_id, { onPreview }) => {
        onPreview(chat);
        return save.promise;
    });
    await render();
    expect(host.textContent).toBe('Readable shared answer');
    expect(host.querySelector('[role="dialog"],[role="status"]')).toBeNull();
    expect(session.switchChat).not.toHaveBeenCalled();
    expect(host.querySelector('[data-composer]').disabled).toBe(true);
    await act(async () => { save.resolve(chat.id); await save.promise; });
    expect(session.switchChat).toHaveBeenCalledWith(chat.id, { restoreReadingProgress: false });
    expect(location.hash).toBe('');
    expect(host.querySelector('[data-composer]').disabled).toBe(false);
});

it('keeps readable content after a save failure and retries without showing a modal', async () => {
    const save = deferred();
    service.importConversation.mockImplementationOnce(async (_id, { onPreview }) => {
        onPreview(chat);
        return save.promise;
    }).mockResolvedValue(chat.id);
    await render();
    await act(async () => { save.reject(new Error('share_import_failed')); });
    expect(host.querySelector('article').textContent).toBe('Readable shared answer');
    expect(host.querySelector('[role="alert"]').textContent).toBe('share_import_failed');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(session.switchChat).not.toHaveBeenCalled();
    await act(async () => host.querySelector('.shared-conversation-actions button:last-child').click());
    expect(session.switchChat).toHaveBeenCalledWith(chat.id, { restoreReadingProgress: false });
});

it('cancels a pending link when the user navigates to another conversation', async () => {
    const save = deferred();
    let signal;
    service.importConversation.mockImplementation(async (_id, options) => {
        signal = options.signal;
        return save.promise;
    });
    await render();
    expect(host.querySelector('[role="status"]')).not.toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => document.dispatchEvent(new CustomEvent('cerebr:chatSwitched')));
    expect(signal.aborted).toBe(true);
    expect(location.hash).toBe('');
    await act(async () => { save.resolve(chat.id); await save.promise; });
    expect(session.switchChat).not.toHaveBeenCalled();
});

it('shows an inline error when loading fails before any preview is available', async () => {
    service.importConversation.mockRejectedValue(new Error('share_unavailable'));
    await render();
    expect(host.querySelector('[role="alert"]').textContent).toBe('share_unavailable');
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => host.querySelector('.shared-conversation-actions button').click());
    expect(location.hash).toBe('');
    expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('restores reading progress when reopening an existing imported copy', async () => {
    service.importConversation.mockResolvedValue(chat.id);
    await render();
    expect(session.switchChat).toHaveBeenCalledWith(chat.id, { restoreReadingProgress: true });
});
