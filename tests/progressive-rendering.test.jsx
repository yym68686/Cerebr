import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useProgressiveCount } from '../src/app/hooks/useProgressiveCount.js';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
it('finishes long histories and cancels pending rows when switching chats', async () => {
    const idle = new Map();
    let id = 0;
    vi.stubGlobal('requestIdleCallback', (callback) => {
        idle.set(++id, callback);
        return id;
    });
    vi.stubGlobal('cancelIdleCallback', (token) => idle.delete(token));
    function Rows({ chat, total }) {
        const count = useProgressiveCount(chat, total);
        return (
            <div data-chat={chat}>
                {Array.from({ length: count }, (_, i) => (
                    <p key={i}>
                        {chat}:{i}
                    </p>
                ))}
            </div>
        );
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Rows chat="large" total={1000} />));
    expect(host.querySelectorAll('p').length).toBeLessThan(1000);
    while (idle.size) {
        const callbacks = [...idle.values()];
        idle.clear();
        await act(async () => callbacks.forEach((callback) => callback()));
    }
    expect(host.querySelectorAll('p')).toHaveLength(1000);
    await act(async () => root.render(<Rows chat="another-large" total={500} />));
    await act(async () => root.render(<Rows chat="small" total={3} />));
    while (idle.size) {
        const callbacks = [...idle.values()];
        idle.clear();
        await act(async () => callbacks.forEach((callback) => callback()));
    }
    expect(host.querySelectorAll('p')).toHaveLength(3);
    expect(host.textContent).not.toContain('large');
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});
