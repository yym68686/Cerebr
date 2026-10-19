import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

// Exercise the bundled Node worker, including dependency resolution, over a real
// loopback socket. The temporary profile cannot touch the user's history.
const root = path.dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'cerebr-desktop-check-'));
await writeFile(
    path.join(temporary, 'bootstrap.cjs'),
    `const {EventEmitter}=require('node:events');process.parentPort=new EventEmitter();process.parentPort.postMessage=m=>process.send(m);process.on('message',data=>process.parentPort.emit('message',{data}));require(${JSON.stringify(path.join(root, '.vite/sync-service.cjs'))});`
);
const worker = fork(path.join(temporary, 'bootstrap.cjs'), [path.join(temporary, 'history.sqlite')], {
    env: { ...process.env, CEREBR_SYNC_TEST_PORT: '0' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
});
let logs = '';
worker.stderr.on('data', (chunk) => {
    logs += chunk;
});
const inbox = [],
    waiters = [];
worker.on('message', (message) => {
    const at = waiters.findIndex((w) => w.test(message));
    if (at >= 0) {
        const [w] = waiters.splice(at, 1);
        clearTimeout(w.timer);
        w.resolve(message);
    } else inbox.push(message);
});
function receive(test) {
    const at = inbox.findIndex(test);
    if (at >= 0) return Promise.resolve(inbox.splice(at, 1)[0]);
    return new Promise((resolve, reject) => {
        const waiter = {
            test,
            resolve,
            timer: setTimeout(() => reject(new Error('Worker timeout: ' + logs)), 10000),
        };
        waiters.push(waiter);
    });
}
let socket;
try {
    const ready = await receive((m) => m.event === 'ready');
    worker.send({ kind: 'status', requestId: 'status' });
    const { result: status } = await receive((m) => m.requestId === 'status');
    socket = new WebSocket(`ws://127.0.0.1:${ready.port}`, {
        origin: 'chrome-extension://' + 'a'.repeat(32),
    });
    const responses = [],
        waiting = [];
    socket.on('message', (raw) => {
        const msg = JSON.parse(raw);
        const at = waiting.findIndex((w) => w.test(msg));
        if (at >= 0) {
            const [w] = waiting.splice(at, 1);
            clearTimeout(w.timer);
            w.resolve(msg);
        } else responses.push(msg);
    });
    function response(test) {
        const at = responses.findIndex(test);
        if (at >= 0) return Promise.resolve(responses.splice(at, 1)[0]);
        return new Promise((resolve, reject) =>
            waiting.push({
                test,
                resolve,
                timer: setTimeout(() => reject(new Error('Socket timeout: ' + logs)), 10000),
            })
        );
    }
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'pair', code: status.pairingCode }));
    assert.ok((await response((m) => m.type === 'paired')).token);
    socket.send(JSON.stringify({type:'browser-ready',version:1}));
    const browserStatus=await receive(message=>message.event==='status'&&message.status.browserSession);
    worker.send({kind:'browser-request',requestId:'tabs',payload:{session:browserStatus.status.browserSession,message:{type:'GET_ALL_TABS'}}});
    const tabRequest=await response(message=>message.type==='browser-request');
    socket.send(JSON.stringify({type:'browser-response',id:tabRequest.id,result:[{id:1,title:'Test page',url:'https://example.com'}]}));
    assert.equal((await receive(message=>message.requestId==='tabs')).result[0].title,'Test page');
    socket.send(JSON.stringify({type:'progress',progress:{chatId:'progress-test',phase:'replying'}}));
    await receive(m=>m.event==='sync-message'&&m.message.type==='progress'&&m.message.progress.phase==='replying');
    socket.send(JSON.stringify({type:'progress',progress:{chatId:'progress-test',phase:'idle'}}));
    await receive(m=>m.event==='sync-message'&&m.message.type==='progress'&&m.message.progress.phase==='idle');
    worker.send({kind:'message',message:{type:'progress',progress:{chatId:'desktop-reply',phase:'replying'}}});
    await response(m=>m.type==='progress'&&m.progress.phase==='replying');
    worker.send({kind:'clear-desktop-progress'});
    await response(m=>m.type==='progress'&&m.progress.chatId==='desktop-reply'&&m.progress.phase==='idle');
    // A live question and partial answer must cross the bridge before any put
    // reaches SQLite, in both directions.
    for (const source of ['extension', 'desktop']) {
        const frame = { chatId: 'live-' + source, requestId: source, sequence: 1, startedAt: 100,
            phase: 'thinking', chat: { id: 'live-' + source, title: 'Live test', messages: [{ role: 'user', content: 'Question' }] } };
        const deliver = (value) => source === 'extension'
            ? socket.send(JSON.stringify({ type: 'live-chat', frame: value }))
            : worker.send({ kind: 'message', message: { type: 'live-chat', frame: value } });
        const next = (sequence) => source === 'extension'
            ? receive((m) => m.event === 'sync-message' && m.message.type === 'live-chat' && m.message.frame.chatId === frame.chatId && m.message.frame.sequence === sequence).then((m) => m.message.frame)
            : response((m) => m.type === 'live-chat' && m.frame.chatId === frame.chatId && m.frame.sequence === sequence).then((m) => m.frame);
        deliver(frame);
        assert.equal((await next(1)).chat.messages[0].content, 'Question');
        deliver({ ...frame, chat: undefined, sequence: 2, phase: 'replying', index: 1, message: { role: 'assistant', content: 'Partial', reasoning_content: '**Reasoning**' } });
        assert.equal((await next(2)).message.content, 'Partial');
        deliver({ ...frame, sequence: 3, phase: 'idle' });
        assert.equal((await next(3)).phase, 'idle');
    }
    const record = {
        key: 'cerebr_chat_v2_smoke',
        value: {
            id: 'smoke',
            title: 'Desktop build check',
            messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }],
        },
        deleted: false,
        version: { actor: 'test', clock: 1 },
    };
    socket.send(JSON.stringify({ type: 'put', record }));
    assert.deepEqual((await response((m) => m.type === 'record')).record, record);
    worker.send({ kind: 'message', message: { type: 'hello' } });
    assert.equal(
        (await receive((m) => m.event === 'sync-message' && m.message.type === 'manifest')).message.records
            .length,
        1
    );
    socket.send(JSON.stringify({ type: 'barrier', id: 'check', verify: true }));
    const { summary } = await response((m) => m.type === 'caught-up' && m.id === 'check');
    assert.equal(summary.chats, 1);
    assert.equal(summary.messages, 1);
    assert.match(summary.digest, /^[a-f0-9]{64}$/);
    console.log(
        'Bundled desktop worker passed pairing, large-message round trip, desktop IPC and integrity checks.'
    );
} finally {
    socket?.terminate();
    worker.kill();
    await new Promise((resolve) => worker.once('exit', resolve));
    for (const waiter of waiters) clearTimeout(waiter.timer);
    await rm(temporary, { recursive: true, force: true });
}
