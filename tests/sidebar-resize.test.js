import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ sidebar: null }));
vi.mock('../src/plugin/page/page-plugin-runtime.js', () => ({
    createPagePluginRuntime: ({sidebar}) => { runtime.sidebar = sidebar; return {start:async()=>{}}; },
}));
vi.mock('../src/host/content/page-selection-actions.jsx', () => ({mountPageSelectionActions:()=>{}}));
let cleanup, local, sync;
beforeEach(async () => {
    vi.resetModules(); vi.useFakeTimers(); runtime.sidebar=null; cleanup=[]; local={}; sync={};
    for (const target of [window,document]) {
        const add=target.addEventListener.bind(target);
        vi.spyOn(target,'addEventListener').mockImplementation((type,listener,options)=>{
            cleanup.push(()=>target.removeEventListener(type,listener,options)); add(type,listener,options);
        });
    }
    vi.stubGlobal('MutationObserver',class {observe(){} disconnect(){}});
    const storage = memory => ({get:async()=>structuredClone(memory),set:async values=>Object.assign(memory,structuredClone(values)),remove:async key=>delete memory[key]});
    vi.stubGlobal('chrome', {runtime:{getManifest:()=>({background:{service_worker:'dist/background.js'}}),getURL:path=>`chrome-extension://test/${path}`,sendMessage:async()=>({})},storage:{local:storage(local),sync:storage(sync)}});
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('/* sidebar CSS */')));
    (await import('../src/host/content/content-script.js')).bootContentScript();
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.sidebar).not.toBeNull();
    const sidebar=runtime.sidebar;
    vi.spyOn(sidebar.sidebar,'getBoundingClientRect').mockImplementation(()=>{
        const width=parseFloat(sidebar.sidebar.style.width),height=parseFloat(sidebar.sidebar.style.height);
        const left=sidebar.sidebar.style.left==='auto'?innerWidth-20-width:parseFloat(sidebar.sidebar.style.left);
        const top=parseFloat(sidebar.sidebar.style.top);
        return {left,top,width,height,right:left+width,bottom:top+height};
    });
});
afterEach(()=>{
    cleanup.forEach(remove=>remove());
    document.querySelectorAll('cerebr-root').forEach(node=>node.parentNode.removeChild(node));
    vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();
});
const pointer=(target,type,clientX,clientY)=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX,clientY}));
const reset=direction=>runtime.sidebar.sidebar.querySelector(`[data-direction="${direction}"]`).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
it('keeps the right edge fixed when resetting after widening from the left, and saves the corrected position',async()=>{
    const sidebar=runtime.sidebar,handle=sidebar.sidebar.querySelector('[data-direction="left"]');
    const before=sidebar.sidebar.getBoundingClientRect();
    pointer(handle,'pointerdown',before.left,100);
    pointer(window,'pointermove',before.left-370,100);
    pointer(window,'pointerup',before.left-370,100);
    const wide=sidebar.sidebar.getBoundingClientRect();
    expect(wide.width).toBe(800);expect(wide.right).toBe(before.right);
    reset('left');
    expect(sidebar.sidebar.getBoundingClientRect()).toMatchObject({width:430,left:before.left,right:before.right});
    await vi.advanceTimersByTimeAsync(300);
    expect(sync.panelSiteOverridesV1[sidebar.siteKey].sidebarWidth).toBe(430);
    expect(local.cerebr_sidebar_positions_v1[sidebar.positionKey]).toMatchObject({left:before.left,top:before.top});
    sidebar.sidebarLeft=0;sidebar.sidebarTop=0;
    await sidebar.loadWidth();await sidebar.loadPosition();sidebar.applySidebarDimensions();
    expect(sidebar.sidebar.getBoundingClientRect()).toMatchObject({width:430,left:before.left,right:before.right});
});
it.each(['top-left','bottom-left','top-right','bottom-right'])('keeps the opposite corner and stays inside the viewport on %s reset',direction=>{
    const sidebar=runtime.sidebar;
    Object.assign(sidebar,{sidebarLeft:100,sidebarTop:100,sidebarWidth:800,sidebarHeight:500});sidebar.applySidebarDimensions();
    const before=sidebar.sidebar.getBoundingClientRect();
    reset(direction);
    const after=sidebar.sidebar.getBoundingClientRect();
    if(direction.includes('left'))expect(after.right).toBe(before.right);else expect(after.left).toBe(before.left);
    if(direction.includes('top'))expect(after.bottom).toBe(before.bottom);else expect(after.top).toBe(before.top);
    expect(after.width).toBe(430);expect(after.left).toBeGreaterThanOrEqual(8);expect(after.top).toBeGreaterThanOrEqual(8);
    expect(after.bottom).toBeLessThanOrEqual(innerHeight-8);
});

const dragMessage = (sidebar, type, coordinates = {}, source = sidebar.iframe.contentWindow) =>
    window.dispatchEvent(new MessageEvent('message', { source, data: { type, ...coordinates } }));

it('anchors iframe drags to pointerdown without accumulating drift at viewport edges or repeated events', async () => {
    const sidebar = runtime.sidebar;
    sidebar.open();
    Object.assign(sidebar, { sidebarLeft: 200, sidebarTop: 100, sidebarHeight: 400 });
    sidebar.applySidebarDimensions();
    const iframe = sidebar.iframe;
    iframe.style.pointerEvents = 'auto';
    const before = sidebar.sidebar.getBoundingClientRect();
    const origin = { screenX: 500, screenY: 300 };
    dragMessage(sidebar, 'CEREBR_SIDEBAR_DRAG_START', origin);
    expect(iframe.style.pointerEvents).toBe('auto');
    for (const [x, y] of [[530, 320], [560, 350], [-1000, -1000], [530, 320], [530, 320], [10000, 10000], [500, 300]]) {
        dragMessage(sidebar, 'CEREBR_SIDEBAR_DRAG_MOVE', { screenX: x, screenY: y });
        const position = sidebar.sidebar.getBoundingClientRect();
        expect(position.left).toBe(before.left + x - origin.screenX);
        expect(position.top).toBe(before.top + y - origin.screenY);
    }
    expect(sidebar.sidebar.getBoundingClientRect()).toMatchObject({ left: before.left, top: before.top });
    dragMessage(sidebar, 'CEREBR_SIDEBAR_DRAG_END');
    await vi.advanceTimersByTimeAsync(300);
    expect(iframe.style.pointerEvents).toBe('auto');
    expect(local.cerebr_sidebar_positions_v1[sidebar.positionKey]).toMatchObject({ left: before.left, top: before.top });
});

it('keeps the grab point fixed on a full-height sidebar and restores viewport bounds only after release', () => {
    const sidebar = runtime.sidebar;
    sidebar.open();
    const before = sidebar.sidebar.getBoundingClientRect();
    dragMessage(sidebar, 'CEREBR_SIDEBAR_DRAG_START', { screenX: 700, screenY: 200 });
    dragMessage(sidebar, 'CEREBR_SIDEBAR_DRAG_MOVE', { screenX: 750, screenY: 450 });
    expect(sidebar.sidebar.getBoundingClientRect()).toMatchObject({ left: before.left + 50, top: before.top + 250 });
    dragMessage(sidebar, 'CEREBR_SIDEBAR_DRAG_END');
    const after = sidebar.sidebar.getBoundingClientRect();
    expect(after.left).toBeGreaterThanOrEqual(8);
    expect(after.top).toBeGreaterThanOrEqual(8);
    expect(after.right).toBeLessThanOrEqual(innerWidth - 8);
    expect(after.bottom).toBeLessThanOrEqual(innerHeight - 8);
});

it('rejects foreign and invalid drag coordinates and stops moving when the sidebar closes', () => {
    const sidebar = runtime.sidebar;
    sidebar.open();
    const before = sidebar.sidebar.getBoundingClientRect();
    dragMessage(sidebar, 'CEREBR_SIDEBAR_DRAG_START', { screenX: 500, screenY: 300 }, window);
    dragMessage(sidebar, 'CEREBR_SIDEBAR_DRAG_START', { screenX: NaN, screenY: 300 });
    expect(sidebar.dragging).toBe(false);
    dragMessage(sidebar, 'CEREBR_SIDEBAR_DRAG_START', { screenX: 500, screenY: 300 });
    dragMessage(sidebar, 'CEREBR_SIDEBAR_DRAG_MOVE', { screenX: 550, screenY: Infinity });
    expect(sidebar.sidebar.getBoundingClientRect()).toMatchObject({ left: before.left, top: before.top });
    sidebar.toggle();
    expect(sidebar.dragging).toBe(false);
    sidebar.open();
    dragMessage(sidebar, 'CEREBR_SIDEBAR_DRAG_MOVE', { screenX: 550, screenY: 300 });
    expect(sidebar.sidebar.getBoundingClientRect()).toMatchObject({ left: before.left, top: before.top });
});
