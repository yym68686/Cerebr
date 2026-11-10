import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { Database } from './database.js';
import { createSyncBus } from './sync-bus.js';
import { credentials, hashPassword, checkPassword, newToken, tokenHash } from './auth.js';
import { SHARE_ID, normalizeShareSnapshot } from './share-snapshot.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicUser = ({ id, username, role, status }) => ({ id, username, role, status });
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export async function createApp(options = {}) {
    const database = options.database || new Database(process.env.DATABASE_URL);
    await database.initialize(options.admin || { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD });
    const app = Fastify({ logger: options.logger ?? { redact: ['req.headers.authorization','req.headers.cookie','req.body.password'] }, bodyLimit: 262144, trustProxy: false });
    const clients = new Set(), live = new Map(), traffic = new Map();
    const origins = ['https://cerebr.yym68686.top', ...(process.env.ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean)];
    const allowed = (origin) => !origin || origin === 'https://cerebr.fugue.pro' || origin === 'https://cerebr-sync.fugue.pro' || origins.includes(origin) || origin === 'cerebr://app' || /^(chrome-extension|moz-extension):\/\//.test(origin) || (process.env.NODE_ENV !== 'production' && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
    await app.register(cors, { origin: (origin, cb) => cb(null, allowed(origin)), allowedHeaders: ['Content-Type','Authorization'], methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'] });
    await app.register(rateLimit, { max: 180, timeWindow: '1 minute' });
    app.addHook('onSend', async (_req, reply, payload) => {
        reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy','no-referrer');
        reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
        return payload;
    });
    app.setErrorHandler((error, req, reply) => {
        const status = error.statusCode || 500;
        if (status >= 500) req.log.error({ message: error.message }, 'Request failed');
        reply.code(status).send({ error: status >= 500 ? '服务暂时不可用，请稍后重试。' : error.message });
    });
    async function authenticate(token) {
        if (typeof token !== 'string' || token.length > 200) throw fail('请先登录。',401);
        const result = await database.query('SELECT u.*,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>now()', [tokenHash(token)]);
        const user = result.rows[0];
        if (!user) throw fail('登录已失效，请重新登录。',401);
        if (user.status === 'banned') throw fail('账号已被封禁。',403);
        return user;
    }
    const auth = async (req) => { req.user = await authenticate(req.headers.authorization?.replace(/^Bearer /,'')); };
    const admin = async (req) => { await auth(req); if(req.user.role !== 'admin') throw fail('需要管理员权限。',403); };
    async function session(user) {
        const token = newToken(), expiresAt = new Date(Date.now() + 30 * 86400000);
        await database.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [tokenHash(token), user.id, expiresAt]);
        await database.query('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]);
        return { token, expiresAt, user: publicUser(user) };
    }
    const dummy = await hashPassword(newToken());
    app.get('/healthz', async () => { await database.query('SELECT 1'); return { ok: true, service: 'cerebr-sync', protocol: 1 }; });
    app.post('/api/auth/register', { config: { rateLimit: { max: 8, timeWindow: '1 hour' } } }, async (req, reply) => {
        const { username, password } = credentials(req.body);
        const user = { id: randomUUID(), username, role: 'user', status: 'active' };
        try { await database.query('INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)', [user.id, username, await hashPassword(password)]); }
        catch (e) { if(e.code === '23505') throw fail('此用户名已被使用。',409); throw e; }
        reply.code(201); return session(user);
    });
    app.post('/api/auth/login', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (req) => {
        const { username, password } = credentials(req.body, { allowLegacyUsername: true });
        const user = (await database.query('SELECT * FROM users WHERE username=$1', [username])).rows[0];
        const matches = await checkPassword(password, user?.password_hash || dummy);
        if (!user || !matches) throw fail('用户名或密码不正确。',401);
        if (user.status === 'banned') throw fail('账号已被封禁。',403);
        return session(user);
    });
    app.get('/api/auth/me', { preHandler: auth }, async (req) => ({ user: publicUser(req.user) }));
    app.post('/api/auth/logout', { preHandler: auth }, async (req) => {
        const hash = tokenHash(req.headers.authorization.slice(7));
        await database.query('DELETE FROM sessions WHERE token_hash=$1',[hash]);
        for (const c of clients) if (c.tokenHash === hash) c.socket.close(4001,'Signed out');
        await bus.publish(req.user.id, { type: 'invalidate-session', tokenHash: hash, code: 4001 });
        return { ok: true };
    });
    app.get('/api/sync/status', { preHandler: auth }, async (req) => ({ user: publicUser(req.user), summary: await database.summary(req.user.id) }));

    const shareOptions = { preHandler: auth, bodyLimit: 160 * 1024 ** 2, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
    const shareId = (req) => { if (!SHARE_ID.test(req.params.id)) throw fail('共享链接不存在或已停止共享。', 404); return req.params.id; };
    const shareSnapshot = (req) => {
        if (req.user.status !== 'active') throw fail('账号已被暂停。', 403);
        try { return normalizeShareSnapshot(req.body?.snapshot); }
        catch { throw fail('共享对话数据格式无效。'); }
    };
    app.post('/api/shares', shareOptions, async (req) => {
        const chatId = req.body?.chatId;
        if (typeof chatId !== 'string' || !chatId.length || chatId.length > 200) throw fail('Invalid conversation');
        return { shareId: await database.createShare(req.user.id, chatId, shareSnapshot(req)) };
    });
    app.put('/api/shares/:id', shareOptions, async (req) => {
        const id = shareId(req), snapshot = shareSnapshot(req);
        if (!await database.updateShare(req.user.id, id, snapshot)) throw fail('共享链接不存在或不属于此账号。', 404);
        return { shareId: id };
    });
    app.delete('/api/shares/:id', { preHandler: auth }, async (req) => {
        if (!await database.revokeShare(req.user.id, shareId(req))) throw fail('共享链接不存在或不属于此账号。', 404);
        return { ok: true };
    });
    app.get('/api/shares/:id', { onSend: async (_req, reply, payload) => {
        // Only this public snapshot endpoint is readable from arbitrary hosts.
        reply.header('Access-Control-Allow-Origin', '*');
        return payload;
    } }, async (req) => {
        const id = shareId(req), snapshot = await database.getShare(id);
        if (!snapshot) throw fail('共享链接不存在或已停止共享。', 404);
        return { shareId: id, snapshot };
    });

    const onlineIds = () => new Set([...clients].map((c) => `${c.user.id}:${c.id}`));
    app.get('/api/admin/dashboard', { preHandler: admin }, async () => {
        await flushTraffic();
        const [users, records, devices, series, totals] = await Promise.all([
            database.query('SELECT count(*)::int total,count(*) FILTER(WHERE status=\'active\')::int active,count(*) FILTER(WHERE status=\'paused\')::int paused,count(*) FILTER(WHERE status=\'banned\')::int banned FROM users'),
            database.query('SELECT coalesce(sum(chats),0)::bigint chats,coalesce(sum(messages),0)::bigint messages,coalesce(sum(byte_size),0)::bigint storage_bytes FROM records'),
            database.query('SELECT count(*)::int total FROM devices'),
            database.query("SELECT date_trunc('day',hour) AS \"day\",sum(bytes_in)::bigint bytes_in,sum(bytes_out)::bigint bytes_out FROM traffic WHERE hour>now()-interval '30 days' GROUP BY 1 ORDER BY 1"),
            database.query('SELECT coalesce(sum(bytes_in),0)::bigint bytes_in,coalesce(sum(bytes_out),0)::bigint bytes_out FROM devices'),
        ]);
        return { users: users.rows[0], records: records.rows[0], clients: { total: devices.rows[0].total, online: onlineIds().size }, traffic: totals.rows[0], series: series.rows, updatedAt: new Date() };
    });
    app.get('/api/admin/users', { preHandler: admin }, async (req) => {
        const search = String(req.query.search || '').slice(0,80), page = Math.max(0, Math.min(100000, Number(req.query.page) || 0));
        const rows = (await database.query(`SELECT u.id,u.username,u.role,u.status,u.created_at,u.last_login_at,
            coalesce(r.chats,0)::int chats,coalesce(r.messages,0)::int messages,coalesce(r.bytes,0)::bigint storage_bytes,
            coalesce(d.clients,0)::int clients,coalesce(d.bytes_in,0)::bigint bytes_in,coalesce(d.bytes_out,0)::bigint bytes_out,
            count(*) OVER()::int total
            FROM users u LEFT JOIN LATERAL(SELECT sum(chats) chats,sum(messages) messages,sum(byte_size) bytes FROM records WHERE user_id=u.id) r ON true
            LEFT JOIN LATERAL(SELECT count(*) clients,sum(bytes_in) bytes_in,sum(bytes_out) bytes_out FROM devices WHERE user_id=u.id) d ON true
            WHERE u.username ILIKE $1 ORDER BY u.created_at DESC LIMIT 50 OFFSET $2`, [`%${search}%`,page*50])).rows;
        const online = onlineIds();
        return { users: rows.map((u)=>({...u,onlineClients:[...online].filter((id)=>id.startsWith(u.id+':')).length})), total: rows[0]?.total || 0, page };
    });
    app.get('/api/admin/users/:id/clients', { preHandler: admin }, async (req) => {
        if(!uuid.test(req.params.id))throw fail('Invalid user');
        const rows = (await database.query('SELECT * FROM devices WHERE user_id=$1 ORDER BY last_seen_at DESC',[req.params.id])).rows;
        const online=onlineIds();
        return { clients: rows.map((d)=>({...d,online:online.has(`${d.user_id}:${d.id}`)})) };
    });
    app.patch('/api/admin/users/:id', { preHandler: admin }, async (req) => {
        const {id}=req.params, status=req.body?.status;
        if(!uuid.test(id)||!['active','paused','banned'].includes(status))throw fail('Invalid status');
        if(id===req.user.id && status!=='active')throw fail('不能暂停或封禁自己的管理员账号。');
        const result=await database.query('UPDATE users SET status=$2 WHERE id=$1 RETURNING id,username,role,status',[id,status]);
        if(!result.rowCount)throw fail('用户不存在。',404);
        await database.query('INSERT INTO audit_log(admin_id,user_id,username,action) VALUES($1,$2,$3,$4)',[req.user.id,id,result.rows[0].username,status]);
        if(status==='banned')await database.query('DELETE FROM sessions WHERE user_id=$1',[id]);
        if(status!=='active')for(const c of clients)if(c.user.id===id)c.socket.close(4003,status);
        if(status!=='active')await bus.publish(id, { type: 'invalidate-session', code: 4003 });
        return {user:result.rows[0]};
    });
    app.delete('/api/admin/users/:id', { preHandler: admin }, async (req) => {
        const { id } = req.params;
        if (!uuid.test(id)) throw fail('Invalid user');
        const user = await database.deleteUser(req.user.id, id, req.body?.username);
        disconnectDeletedUser(id);
        await bus.publish(id, { type: 'invalidate-session', code: 4001, deleted: true });
        return { ok: true, user: publicUser(user) };
    });
    app.get('/api/admin/audit', {preHandler:admin}, async()=>({events:(await database.query("SELECT a.created_at,a.action,coalesce(a.username,u.username,'已删除用户') username,actor.username actor FROM audit_log a LEFT JOIN users u ON u.id=a.user_id JOIN users actor ON actor.id=a.admin_id ORDER BY a.id DESC LIMIT 50")).rows}));

    const wss = new WebSocketServer({ noServer: true, maxPayload: 128*1024**2, perMessageDeflate: false });
    app.server.on('upgrade',(req,socket,head)=>{
        if(req.url!=='/sync'||!allowed(req.headers.origin)){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
        wss.handleUpgrade(req,socket,head,(ws)=>wss.emit('connection',ws,req));
    });
    function meter(c,direction,bytes){
        if(c.revoked)return;
        const key=`${c.user.id}:${c.id}`, value=traffic.get(key)||{user:c.user.id,id:c.id,in:0,out:0};
        value[direction]+=bytes;traffic.set(key,value);
    }
    let flushing;
    async function flushTraffic(){
        if(flushing)return flushing;
        flushing=(async()=>{
            for(const [key,value]of [...traffic]){
                traffic.delete(key);
                const connection=await database.pool.connect();
                try{
                    await connection.query('BEGIN');
                    const user=await connection.query('SELECT id FROM users WHERE id=$1 FOR KEY SHARE',[value.user]);
                    if(!user.rowCount){await connection.query('COMMIT');continue;}
                    await connection.query('UPDATE devices SET bytes_in=bytes_in+$3,bytes_out=bytes_out+$4,last_seen_at=now() WHERE user_id=$1 AND id=$2',[value.user,value.id,value.in,value.out]);
                    await connection.query(`INSERT INTO traffic(user_id,device_id,hour,bytes_in,bytes_out) VALUES($1,$2,date_trunc('hour',now()),$3,$4) ON CONFLICT(user_id,device_id,hour) DO UPDATE SET bytes_in=traffic.bytes_in+excluded.bytes_in,bytes_out=traffic.bytes_out+excluded.bytes_out`,[value.user,value.id,value.in,value.out]);
                    await connection.query('COMMIT');
                }catch(e){await connection.query('ROLLBACK');const pending=traffic.get(key)||{...value,in:0,out:0};pending.in+=value.in;pending.out+=value.out;traffic.set(key,pending);throw e;}finally{connection.release();}
            }
        })().finally(()=>{flushing=null;});return flushing;
    }
    function send(c,message){
        if(c.socket.readyState!==1)return;
        if(c.socket.bufferedAmount>32*1024**2){c.socket.close(4008,'Slow client; reconnect');return;}
        const text=JSON.stringify(message);meter(c,'out',Buffer.byteLength(text));c.socket.send(text);
    }
    async function sendHistory(c,message){
        if(c.socket.readyState!==1)return;
        const text=JSON.stringify(message);meter(c,'out',Buffer.byteLength(text));
        await new Promise((resolve,reject)=>c.socket.send(text,(error)=>error?reject(error):resolve()));
    }
    function broadcast(c,message){for(const peer of clients)if(peer!==c&&peer.user.id===c.user.id)send(peer,message);}
    function disconnectDeletedUser(userId) {
        for (const [key, value] of traffic) if (value.user === userId) traffic.delete(key);
        for (const [key, value] of live) if (value.userId === userId) live.delete(key);
        for (const c of clients) if (c.user.id === userId) { c.revoked = true; c.socket.close(4001, 'Account deleted'); }
    }
    const bus = await createSyncBus(database, {
        logger: app.log,
        unavailable: () => { for (const c of clients) c.socket.close(1012, 'Sync service reconnecting'); },
        receive: async (userId, message) => {
            if (message.type === 'invalidate-session' && message.deleted) { disconnectDeletedUser(userId); return; }
            const peers = [...clients].filter(c => c.user.id === userId);
            if (!peers.length) return;
            if (message.type === 'invalidate-session') {
                for (const c of peers) if (!message.tokenHash || c.tokenHash === message.tokenHash) c.socket.close(message.code, 'Session changed');
                return;
            }
            if (message.type === 'record-key') {
                const record = await database.get(userId, message.key);
                if (record) message = { type: 'record', record };
                else return;
            }
            for (const peer of peers) send(peer, message);
        },
    });
    async function relay(c, message) {
        if (c.revoked) return;
        broadcast(c, message);
        await bus.publish(c.user.id, message.type === 'record' ? { type: 'record-key', key: message.record.key } : message);
    }
    wss.on('connection',(socket,req)=>{
        let c,queue=Promise.resolve(),pendingBytes=0;
        const timer=setTimeout(()=>socket.close(4001,'Authentication required'),5000);
        socket.on('message',(raw)=>{
            pendingBytes+=raw.length;
            if(pendingBytes>160*1024**2){socket.close(4008,'Backpressure');return;}
            queue=queue.then(async()=>{
                if(socket.readyState!==1||c?.revoked)return;
                const m=JSON.parse(raw.toString());
                if(!c){
                    if(m.type!=='auth'||!uuid.test(m.client?.id))throw fail('Invalid authentication',401);
                    const user=await authenticate(m.token);
                    if(user.status==='paused')throw fail('同步已被管理员暂停。',403);
                    c={socket,user,id:m.client.id,tokenHash:tokenHash(m.token),alive:true};
                    await database.query(`INSERT INTO devices(user_id,id,name,platform,origin,app_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,platform=excluded.platform,origin=excluded.origin,app_version=excluded.app_version,last_seen_at=now()`,[user.id,c.id,String(m.client.name||'Client').slice(0,120),String(m.client.platform||'web').slice(0,32),String(req.headers.origin||m.client.origin||'').slice(0,200),String(m.client.version||'').slice(0,32)]);
                    clients.add(c);clearTimeout(timer);send(c,{type:'authenticated',user:publicUser(user)});return;
                }
                meter(c,'in',raw.length);c.alive=true;
                if(m.type==='hello'){
                    await sendHistory(c,{type:'manifest',records:await database.manifest(c.user.id),protocol:1});
                    for(const entry of live.values())if(entry.userId===c.user.id&&entry.source!==c)send(c,{type:'live-chat',frame:entry.frame});
                }else if(m.type==='put'){
                    const result=await database.put(c.user.id,m.record);await sendHistory(c,{type:'record',record:result.record});
                    if(result.changed)await relay(c,{type:'record',record:result.record});
                }else if(m.type==='get'&&Array.isArray(m.keys)&&m.keys.length<=100000){
                    for(const key of m.keys){if(typeof key!=='string')continue;const record=await database.get(c.user.id,key);if(record)await sendHistory(c,{type:'record',record});}
                    send(c,{type:'caught-up',id:m.id});
                }else if(m.type==='barrier'){
                    send(c,{type:'caught-up',id:m.id,summary:await database.summary(c.user.id,m.verify===true)});
                }else if(m.type==='client-stats'){
                    if(Number.isSafeInteger(m.chats)&&Number.isSafeInteger(m.messages)&&m.chats>=0&&m.messages>=0)
                        await database.query('UPDATE devices SET chats=$3,messages=$4,last_seen_at=now() WHERE user_id=$1 AND id=$2',[c.user.id,c.id,Math.min(m.chats,2147483647),Math.min(m.messages,2147483647)]);
                }else if(m.type==='progress'&&typeof m.progress?.chatId==='string'&&['thinking','replying','idle'].includes(m.progress.phase))await relay(c,m);
                else if(m.type==='live-chat'){
                    const f=m.frame,key=`${c.user.id}:${f?.chatId}`,old=live.get(key);
                    if(typeof f?.chatId!=='string'||typeof f.requestId!=='string'||!Number.isSafeInteger(f.sequence)||!Number.isFinite(f.startedAt)||!['thinking','replying','idle'].includes(f.phase))return;
                    if(old&&(old.frame.startedAt>f.startedAt||(old.frame.requestId===f.requestId&&old.frame.sequence>=f.sequence)))return;
                    let chat=f.chat||(old?.frame.requestId===f.requestId?old?.frame.chat:null);
                    if(!chat||chat.id!==f.chatId||!Array.isArray(chat.messages))return;
                    if(f.message&&Number.isSafeInteger(f.index)&&f.index>=0&&f.index<=chat.messages.length)chat={...chat,messages:[...chat.messages.slice(0,f.index),f.message]};
                    live.set(key,{userId:c.user.id,source:c,frame:{...f,chat}});await relay(c,m);
                    if(f.phase==='idle')live.delete(key);
                }else if(m.type==='ping')send(c,{type:'pong'});
            }).catch((error)=>{
                if(c)send(c,{type:'error',error:error.statusCode?error.message:'同步暂时失败，请重新连接。'});
                else socket.send(JSON.stringify({type:'auth-error',error:error.statusCode?error.message:'连接失败。',status:error.statusCode||500}));
                socket.close(error.statusCode===403?4003:4001,'Sync error');
                app.log.warn({message:error.message},'Sync request failed');
            }).finally(()=>{pendingBytes-=raw.length;});
        });
        socket.on('pong',()=>{if(c)c.alive=true;});
        socket.on('close',()=>{
            clearTimeout(timer);if(!c)return;clients.delete(c);
            for(const [key,entry]of live)if(entry.source===c){live.delete(key);void relay(c,{type:'progress',progress:{chatId:entry.frame.chatId,phase:'idle'}}).catch(()=>{});}
        });
        socket.on('error',()=>socket.close());
    });
    const interval=setInterval(()=>{
        for(const c of clients){if(!c.alive||new Date(c.user.expires_at)<new Date()){c.socket.terminate();continue;}c.alive=false;c.socket.ping();}
        void flushTraffic().catch((e)=>app.log.error({message:e.message},'Traffic flush failed'));
    },15000);interval.unref();
    const root=fileURLToPath(new URL('../dist',import.meta.url));
    if(existsSync(root))await app.register(staticFiles,{root,maxAge:0});
    app.addHook('onClose',async()=>{clearInterval(interval);for(const c of clients)c.socket.terminate();wss.close();await flushTraffic();await bus.close();await database.close();});
    return {app,database,flushTraffic,clients};
}
