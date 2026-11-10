// @vitest-environment node
import { expect, it } from 'vitest';
import { createWebpageTabRegistry } from '../src/host/background/webpage-tab-registry.js';

it('distinguishes identical URLs across worker restarts without exposing browser IDs in source identities', async () => {
    let memory = {};
    const storage = { get: async () => structuredClone(memory), set: async (value) => { memory = structuredClone(value); } };
    const tabs = [1, 2].map((id) => ({ id, url: 'https://cerebr.fugue.pro/' }));
    const identify = createWebpageTabRegistry(storage);
    const initial = await identify(tabs);
    expect(initial[0].sourceId).toBeUndefined();
    expect(initial[1].sourceId).toMatch(/^[\da-f-]{36}$/);
    expect(await createWebpageTabRegistry(storage)(tabs)).toEqual(initial);
    expect(await identify([tabs[1]])).toEqual([initial[1]]);
    const next = await identify([tabs[1], { id: 3, url: tabs[0].url }]);
    expect(next[0]).toEqual(initial[1]);
    expect(next[1].sourceId).toBeUndefined();
    const navigated = await identify([{ ...tabs[1], url: 'https://example.test/' }, { id: 3, url: tabs[0].url }]);
    expect(navigated[0].sourceId).toBeUndefined();
});
