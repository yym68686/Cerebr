import { afterEach, expect, it, vi } from 'vitest';
import { createPageUserScriptService } from '../src/plugin/page/page-user-script-service.js';

vi.mock('../src/plugin/dev/local-plugin-service.js', () => ({
    getInstalledScriptPlugins: async () => [{
        id: 'test.page', enabled: true, compatible: true, runtimeSupported: true,
        sourceType: 'registry', manifest: { id: 'test.page', kind: 'script', scope: 'page' },
    }],
}));
vi.mock('../src/plugin/dev/developer-mode.js', () => ({
    readDeveloperModePreference: async () => false,
    subscribeDeveloperModePreference: () => () => {},
}));
vi.mock('../src/plugin/shared/plugin-store.js', () => ({ subscribePluginSettings: () => () => {} }));
vi.mock('../src/plugin/page/page-user-script-compiler.js', () => ({
    getPageUserScriptRegistrationId: (id) => `cerebr.page.user-script.${id}`,
    buildPageUserScriptRegistration: async () => ({ id: 'cerebr.page.user-script.test.page' }),
}));
vi.mock('../src/plugin/page/page-user-script-support.js', () => ({
    getPageUserScriptCompatibilityIssues: () => [],
    isUserScriptCompatiblePagePlugin: () => true,
}));
vi.mock('../src/plugin/core/plugin-i18n.js', () => ({
    createPluginHostLocaleStore: () => ({ start: async () => 'en', subscribe: () => () => {}, stop() {} }),
    createPluginRuntimeI18nApi: () => ({}),
}));
afterEach(() => vi.unstubAllGlobals());

it('registers after permission is granted, reports revocation and recovers when granted again', async () => {
    let granted = false;
    const event = () => {
        const listeners = new Set();
        return {
            addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn),
            emit: () => listeners.forEach((fn) => fn({ permissions: ['userScripts'] })), listeners,
        };
    };
    const permissions = { contains: vi.fn(async () => granted), onAdded: event(), onRemoved: event() };
    const userScripts = {
        configureWorld: vi.fn(async () => {}), getScripts: vi.fn(async () => []),
        register: vi.fn(async (scripts) => scripts),
        unregister: vi.fn(async () => { if (!granted) throw new Error('Permission revoked'); }),
    };
    vi.stubGlobal('chrome', { permissions, userScripts });
    const service = createPageUserScriptService();
    await service.start();
    expect(service.getDiagnostics()[0].preflight.errors[0].code).toBe('userscripts-permission-required');
    expect(userScripts.register).not.toHaveBeenCalled();

    granted = true;
    permissions.onAdded.emit();
    await vi.waitFor(() => expect(userScripts.register).toHaveBeenCalledOnce());
    expect(service.getDiagnostics()[0].state).toBe('registered');

    granted = false;
    permissions.onRemoved.emit();
    await vi.waitFor(() => expect(service.getDiagnostics()[0].preflight.errors[0]?.code)
        .toBe('userscripts-permission-required'));

    granted = true;
    permissions.onAdded.emit();
    await vi.waitFor(() => expect(userScripts.register).toHaveBeenCalledTimes(2));
    expect(userScripts.configureWorld).toHaveBeenCalledTimes(2);
    await service.stop();
    expect(permissions.onAdded.listeners.size).toBe(0);
    expect(permissions.onRemoved.listeners.size).toBe(0);
});
