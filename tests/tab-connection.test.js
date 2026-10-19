import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTabConnection } from '../src/host/background/tab-connection.js';
let api, logger, connection;
beforeEach(() => {
    vi.useFakeTimers();
    api = {
        tabs: { get: vi.fn(async id => ({ id })), sendMessage: vi.fn(async () => ({ type: 'PONG' })) },
        scripting: { executeScript: vi.fn(async () => {}) },
    };
    logger = { error: vi.fn() };
    connection = createTabConnection({ api, logger });
});
afterEach(() => vi.useRealTimers());

describe('content script recovery', () => {
    it('shares concurrent injection and waits for the queued PING response', async () => {
        let ready;
        api.tabs.sendMessage.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
        const first = connection.reinjectContentScript(7, 'dist/content.js');
        const second = connection.reinjectContentScript(7, 'dist/content.js');
        await vi.advanceTimersByTimeAsync(0);
        expect(api.scripting.executeScript).toHaveBeenCalledExactlyOnceWith({ target: { tabId: 7 }, files: ['dist/content.js'] });
        ready({ type: 'PONG' });
        expect(await first).toBe(true);
        expect(await second).toBe(true);
        api.tabs.sendMessage.mockResolvedValue({ type: 'PONG' });
        expect(await connection.reinjectContentScript(7, 'content.js')).toBe(true);
        expect(api.scripting.executeScript).toHaveBeenCalledTimes(2);
    });

    it('stops if the tab closed before injection', async () => {
        api.tabs.get.mockRejectedValue(new Error('No tab with id: 7'));
        expect(await connection.reinjectContentScript(7, 'content.js')).toBe(false);
        expect(api.scripting.executeScript).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('handles a tab closing during injection without masking real failures', async () => {
        api.scripting.executeScript.mockRejectedValueOnce(new Error('No tab with id: 7'));
        expect(await connection.reinjectContentScript(7, 'content.js')).toBe(false);
        expect(logger.error).not.toHaveBeenCalled();
        const failure = new Error('Cannot access contents of this page');
        api.scripting.executeScript.mockRejectedValueOnce(failure);
        expect(await connection.reinjectContentScript(7, 'content.js')).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.any(String), failure);
    });

    it('bounds an abandoned message and clears successful PING timers', async () => {
        api.tabs.sendMessage.mockReturnValueOnce(new Promise(() => {}));
        const pending = connection.isTabConnected(7);
        await vi.advanceTimersByTimeAsync(5000);
        expect(await pending).toBe(false);
        expect(await connection.isTabConnected(7)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});
