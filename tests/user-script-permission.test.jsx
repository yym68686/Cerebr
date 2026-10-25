import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { UserScriptPermission } from '../src/app/components/UserScriptPermission.jsx';

vi.mock('../src/utils/i18n.js', () => ({ t: (key) => key }));
vi.mock('../src/app/state/ui-store.js', () => ({ notify: vi.fn() }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, host;
afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    vi.unstubAllGlobals();
});

it('requests only on a click, allows a denied request to be retried, and reflects revocation', async () => {
    let granted = false;
    const events = () => {
        const listeners = new Set();
        return {
            addListener: (listener) => listeners.add(listener),
            removeListener: (listener) => listeners.delete(listener),
            emit: () => listeners.forEach((listener) => listener({ permissions: ['userScripts'] })),
            listeners,
        };
    };
    const api = {
        contains: vi.fn(async () => granted),
        request: vi.fn(async () => granted),
        onAdded: events(), onRemoved: events(),
    };
    vi.stubGlobal('chrome', { permissions: api });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<UserScriptPermission visible />));
    expect(api.request).not.toHaveBeenCalled();
    expect(host.querySelector('button')).not.toBeNull();
    await act(async () => {
        host.querySelector('button').click();
        expect(api.request).toHaveBeenCalledWith({ permissions: ['userScripts'] });
    });
    expect(host.querySelector('button').disabled).toBe(false);
    granted = true;
    await act(async () => host.querySelector('button').click());
    expect(host.querySelector('button')).toBeNull();
    granted = false;
    await act(async () => api.onRemoved.emit());
    expect(host.querySelector('button')).not.toBeNull();
    await act(async () => root.render(<UserScriptPermission visible={false} />));
    expect(host.querySelector('button')).toBeNull();
    expect(api.onAdded.listeners.size).toBe(0);
    expect(api.onRemoved.listeners.size).toBe(0);
});

it('does not show a browser permission prompt in the web or desktop host', async () => {
    vi.stubGlobal('chrome', undefined);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<UserScriptPermission visible />));
    expect(host.textContent).toBe('');
});
