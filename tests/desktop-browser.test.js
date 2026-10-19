// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserBroker } from '../desktop/src/browser-broker.ts';
import { validateBrowserRequest } from '../src/runtime/sync/browser-protocol.js';
afterEach(()=>vi.useRealTimers());
it('only routes browser requests to their paired session and rejects responses from other peers',()=>{
    vi.useFakeTimers();const post=vi.fn(),send=vi.fn(),broker=new BrowserBroker(post,send);
    const a={},b={};broker.add(a);const session=broker.session;broker.add(b);
    broker.request('request',{session,message:{type:'GET_PAGE_CONTENT_FROM_SIDEBAR',tabId:5}});
    const [{id}]=send.mock.calls.map(call=>call[1]);
    expect(send.mock.calls[0][0]).toBe(a);
    broker.response(b,{id,result:'wrong'});expect(post).not.toHaveBeenCalled();
    broker.response(a,{id,result:{content:'Selected page'}});
    expect(post).toHaveBeenCalledWith({requestId:'request',result:{content:'Selected page'}});
    broker.remove(a);broker.request('old',{session,message:{type:'GET_ALL_TABS'}});
    expect(post).toHaveBeenCalledWith({requestId:'old',error:'Browser extension disconnected'});
});
it('fails pending extraction on disconnect and relays only events from the active browser',()=>{
    vi.useFakeTimers();const post=vi.fn(),send=vi.fn(),broker=new BrowserBroker(post,send);
    const a={},b={};broker.add(a);broker.add(b);
    broker.event(b,{type:'tabs-changed'});expect(post).not.toHaveBeenCalled();
    broker.event(a,{type:'selection-changed',chatId:'chat'});
    expect(post).toHaveBeenCalledWith({event:'browser-event',payload:{type:'selection-changed',chatId:'chat'}});
    broker.request('pending',{session:broker.session,message:{type:'GET_CURRENT_TAB'}});broker.remove(a);
    expect(post).toHaveBeenCalledWith({requestId:'pending',error:'Browser extension disconnected'});
    expect(broker.pending.size).toBe(0);
});
it('limits the bridge to tab reads, content extraction and explicit source selection',()=>{
    expect(()=>validateBrowserRequest({type:'EXECUTE_SCRIPT',tabId:1,code:'secret'})).toThrow();
    expect(()=>validateBrowserRequest({type:'GET_PAGE_CONTENT_FROM_SIDEBAR',tabId:'1'})).toThrow();
    expect(()=>validateBrowserRequest({type:'UPDATE_WEBPAGE_SWITCHES',chatId:'a',patch:{apiKey:true}})).toThrow();
    expect(validateBrowserRequest({type:'UPDATE_WEBPAGE_SWITCHES',chatId:'a',patch:{1:true}})).toEqual({type:'UPDATE_WEBPAGE_SWITCHES',chatId:'a',patch:{1:true}});
});
