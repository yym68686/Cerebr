import { expect, it, vi } from 'vitest';
import { getChatModelSelection, modelSelection, resolveChatApiConfig } from '../src/domain/chat/model-selection.js';
const memory = vi.hoisted(() => new Map());
vi.mock('../src/utils/storage-adapter.js', () => ({
    isExtensionEnvironment: false, browserAdapter: {},
    storageAdapter: {
        get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(memory.get(k))])),
        set: async values => { for (const [k,v] of Object.entries(values)) memory.set(k,structuredClone(v)); },
        remove: async keys => { for (const k of Array.isArray(keys) ? keys : [keys]) memory.delete(k); },
    },
}));
vi.mock('../src/utils/default-chat.js', () => ({
    DEFAULT_CHAT_KIND:'default', buildDefaultChatSeedMessages:()=>[], getDefaultChatTitle:()=> 'Default', resolveDefaultChatLocale:async()=> 'en',
}));
import { ChatManager, chatManager } from '../src/domain/chat/chat-store.js';
const a = { id:'a', modelName:'gemini-4-argon', apiKey:'secret-a', baseUrl:'https://example.test/v1' };
const b = { id:'b', modelName:'gemini-3.1-pro', apiKey:'secret-b', baseUrl:'https://example.test/v1' };

it('uses each conversation’s model after manual changes, navigation and reload; new chats inherit the new default',async()=>{
    await chatManager.initialize();await chatManager.flushNow();
    const manager=new ChatManager();await manager.initialize();await manager.loadAllChats();
    let selected=a;
    manager.getDefaultModelSelection=()=>modelSelection(selected);
    const first=manager.createNewChat('First');
    await manager.switchChat(first.id);
    await manager.addMessageToCurrentChat({role:'user',content:'First'});
    const second=manager.createNewChat('Second');
    await manager.switchChat(second.id);
    const previousTime=second.updatedAt;
    selected=b;
    const saved=manager.setChatModel(second.id,modelSelection(b));await manager.flushNow();await saved;
    expect(second.updatedAt).toBe(previousTime);
    await manager.addMessageToCurrentChat({role:'user',content:'Second'});
    const third=manager.createNewChat('Third');
    await manager.switchChat(third.id);
    await manager.addMessageToCurrentChat({role:'user',content:'Third'});
    await manager.flushNow();
    expect(first.modelSelection).toEqual(modelSelection(a));
    expect(second.modelSelection).toEqual(modelSelection(b));
    expect(third.modelSelection).toEqual(modelSelection(b));
    const state={configs:[a,b],selected:1,defaultSelection:modelSelection(b),legacySelection:modelSelection(a)};
    await manager.switchChat(first.id);await manager.flushNow();
    expect(resolveChatApiConfig(manager.getCurrentChat(),state).modelName).toBe(a.modelName);
    expect(selected).toBe(b); // navigation never rewrites the new-chat default
    const reloaded=new ChatManager();await reloaded.initialize();await reloaded.loadAllChats();
    expect(reloaded.chats.get(first.id).modelSelection).toEqual(modelSelection(a));
    expect(reloaded.chats.get(third.id).modelSelection).toEqual(modelSelection(b));
    expect(JSON.stringify(first.modelSelection)).not.toContain('secret');
    await reloaded.flushNow();
});

it('preserves legacy chats through later default changes, refreshes keys, and never substitutes a removed model',()=>{
    const legacy={id:'legacy',messages:[{role:'user',content:'old'}]};
    const state={configs:[b,{...a,apiKey:'rotated',modelName:'changed-remotely'}],selected:0,defaultSelection:modelSelection(b),legacySelection:modelSelection(a)};
    expect(getChatModelSelection(legacy,state)).toEqual(modelSelection(a));
    expect(resolveChatApiConfig(legacy,state)).toMatchObject({modelName:a.modelName,apiKey:'rotated'});
    const pinned={...legacy,modelSelection:modelSelection(a)};
    expect(resolveChatApiConfig(pinned,{...state,configs:[b]})).toBeUndefined();
    expect(getChatModelSelection(pinned,{...state,configs:[b]}).modelName).toBe(a.modelName);
});
