import { randomUUID } from 'node:crypto';
import { validateBrowserRequest } from '../../src/runtime/sync/browser-protocol.js';

// Each request belongs to the exact paired connection that supplied the tabs.
// A disconnected/replaced browser must never receive another browser's tab IDs.
export class BrowserBroker {
    peers = new Map<any, string>();
    pending = new Map<string, { peer: any; requestId: string; timer: ReturnType<typeof setTimeout> }>();
    constructor(
        private post: (message: any) => void,
        private send: (peer: any, message: any) => void
    ) {}
    get session() {
        return this.peers.values().next().value || null;
    }
    add(peer: any) {
        if (!this.peers.has(peer)) this.peers.set(peer, randomUUID());
    }
    remove(peer: any) {
        this.peers.delete(peer);
        for (const [id, pending] of this.pending)
            if (pending.peer === peer) {
                clearTimeout(pending.timer);
                this.pending.delete(id);
                this.post({ requestId: pending.requestId, error: 'Browser extension disconnected' });
            }
    }
    request(requestId: string, payload: any) {
        try {
            const message = validateBrowserRequest(payload?.message);
            const peer = [...this.peers].find(([, session]) => session === payload?.session)?.[0];
            if (!peer) throw new Error('Browser extension disconnected');
            const id = randomUUID();
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.post({ requestId, error: 'Browser page request timed out' });
            }, 45000);
            this.pending.set(id, { peer, requestId, timer });
            this.send(peer, { type: 'browser-request', id, message });
        } catch (error: any) {
            this.post({ requestId, error: error.message });
        }
    }
    response(peer: any, message: any) {
        const pending = this.pending.get(message.id);
        if (!pending || pending.peer !== peer) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        this.post({
            requestId: pending.requestId,
            ...(message.error ? { error: String(message.error) } : { result: message.result }),
        });
    }
    event(peer: any, event: any) {
        if (this.peers.get(peer) !== this.session) return;
        if (event?.type === 'tabs-changed' || event?.type === 'selection-changed')
            this.post({
                event: 'browser-event',
                payload: {
                    type: event.type,
                    chatId: typeof event.chatId === 'string' ? event.chatId : undefined,
                },
            });
    }
}
