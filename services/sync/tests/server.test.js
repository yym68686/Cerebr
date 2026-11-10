import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/auth.js';
if (!new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Tests require a database name ending in _test');
let app,database,base,admin,one,two;
const password='Test-only-password-29!';
const req=async(method,url,body,token)=>{
 const r=await app.inject({method,url,payload:body,headers:token?{authorization:`Bearer ${token}`}:{}});return{status:r.statusCode,...r.json()};
};
before(async()=>{
 ({app,database}=await createApp({logger:false,admin:{username:'admin_test',password}}));
 await database.query('TRUNCATE audit_log,traffic,revisions,records,devices,sessions,sync_events,users CASCADE');
 await database.initialize({username:'admin_test',password});
 await app.listen({host:'127.0.0.1',port:0});base=`ws://127.0.0.1:${app.server.address().port}/sync`;
 admin=await req('POST','/api/auth/login',{username:'admin_test',password});
 one=await req('POST','/api/auth/register',{username:'first_user@example.test',password});
 two=await req('POST','/api/auth/register',{username:'second_user@example.test',password});
});
after(async()=>{await app.close();});
async function connect(token,name,url=base,origin){
 const socket=new WebSocket(url,{origin}),inbox=[],waiters=[];
 socket.on('message',raw=>{const m=JSON.parse(raw);const index=waiters.findIndex(w=>w.test(m));if(index>=0){const [w]=waiters.splice(index,1);clearTimeout(w.timer);w.resolve(m);}else inbox.push(m);});
 const receive=(test)=>{const index=inbox.findIndex(test);if(index>=0)return Promise.resolve(inbox.splice(index,1)[0]);return new Promise((resolve,reject)=>{const w={test,resolve,timer:setTimeout(()=>reject(new Error('Socket timeout')),5000)};waiters.push(w);});};
 await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
 const send=m=>socket.send(JSON.stringify(m));send({type:'auth',token,client:{id:randomUUID(),name,platform:'test',version:'test'}});
 await receive(m=>m.type==='authenticated');return{socket,send,receive,inbox};
}
test('share snapshots are public, isolated, explicit, revocable and preserve large attachments', async () => {
 const snapshot = {version:1,chat:{id:'private',title:'Shared PDF',modelSelection:{configId:'secret'},apiKey:'secret',messages:[
  {role:'user',content:[{type:'text',text:'x'.repeat(300000)},{type:'image_url',image_url:{url:'data:image/png;base64,aGVsbG8='}}],
   textFiles:[{id:'pdf',name:'paper.pdf',size:3,textLength:3,originalPdf:'data:application/pdf;base64,YWJj'}],selectionQuotes:['quoted text'],selectionQuestion:'question',apiKey:'secret'},
  {role:'assistant',content:'answer',reasoning_content:'reasoning',requestId:'private'}]},
  pages:[{url:'https://example.test/',title:'Article',content:'Cached article',tabId:42,isCurrent:true}],credentials:'secret'};
 assert.equal((await req('POST','/api/shares',{chatId:'private',snapshot})).status,401);
 assert.equal((await req('POST','/api/shares',{chatId:'private',snapshot:{...snapshot,version:2}},one.token)).status,400);
 const localFile={...snapshot,pages:[{url:'file:///Users/owner/private.pdf',title:'Local file',content:'private'}]};
 assert.equal((await req('POST','/api/shares',{chatId:'private',snapshot:localFile},one.token)).status,400);
 const created=await req('POST','/api/shares',{chatId:'private',snapshot},one.token);
 assert.equal(created.status,200);assert.match(created.shareId,/^[0-9a-f]{48}$/);
 const path=`/api/shares/${created.shareId}`;
 const publicRead=await app.inject({method:'GET',url:path,headers:{origin:'https://another-cerebr.example'}});
 assert.equal(publicRead.statusCode,200);assert.equal(publicRead.headers['access-control-allow-origin'],'*');
 const published=publicRead.json().snapshot;
 assert.equal(published.chat.messages[0].content[0].text.length,300000);
 assert.equal(published.chat.messages[0].textFiles[0].originalPdf,'data:application/pdf;base64,YWJj');
 assert.equal(published.chat.messages[1].reasoning_content,'reasoning');
 assert.deepEqual(published.pages,[{url:'https://example.test/',title:'Article',content:'Cached article'}]);
 assert.equal(JSON.stringify(published).includes('secret'),false);assert.equal(published.chat.id,undefined);
 const changed={...snapshot,chat:{...snapshot.chat,title:'Explicit update'}};
 assert.equal((await req('POST','/api/shares',{chatId:'private',snapshot:changed},one.token)).shareId,created.shareId);
 assert.equal((await req('GET',path)).snapshot.chat.title,'Shared PDF');
 assert.equal((await req('PUT',path,{snapshot:changed},two.token)).status,404);
 assert.equal((await req('DELETE',path,undefined,two.token)).status,404);
 assert.equal((await req('PUT',path,{snapshot:changed},one.token)).status,200);
 assert.equal((await req('GET',path)).snapshot.chat.title,'Explicit update');
 const other=await req('POST','/api/shares',{chatId:'private',snapshot},two.token);
 assert.notEqual(other.shareId,created.shareId);
 assert.equal((await req('DELETE',path,undefined,one.token)).status,200);
 assert.equal((await req('GET',path)).status,404);
 const recreated=await req('POST','/api/shares',{chatId:'private',snapshot},one.token);
 assert.notEqual(recreated.shareId,created.shareId);
 assert.equal((await req('GET','/api/shares/private')).status,404);
 const disallowed=await app.inject({method:'GET',url:'/api/sync/status',headers:{origin:'https://another-cerebr.example'}});
 assert.equal(disallowed.headers['access-control-allow-origin'],undefined);
});
test('official web origin can preflight, receive registration errors, and authenticate sync',async()=>{
 const origin='https://cerebr.fugue.pro';
 const preflight=await app.inject({method:'OPTIONS',url:'/api/auth/register',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type,authorization'}});
 assert.equal(preflight.statusCode,204);
 assert.equal(preflight.headers['access-control-allow-origin'],origin);
 assert.match(preflight.headers['access-control-allow-methods'],/POST/);
 assert.match(preflight.headers['access-control-allow-headers'].toLowerCase(),/content-type/);
 assert.match(preflight.headers['access-control-allow-headers'].toLowerCase(),/authorization/);
 const invalid=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin},payload:{username:'cors-check@example.test',password:''}});
 assert.equal(invalid.statusCode,400);
 assert.equal(invalid.headers['access-control-allow-origin'],origin);
 assert.match(invalid.json().error,/密码/);
 const client=await connect(one.token,'official-web',base,origin);
 client.socket.close();
});
test('untrusted web origins cannot preflight or connect to sync',async()=>{
 const origin='https://cerebr.fugue.pro.example.test';
 const preflight=await app.inject({method:'OPTIONS',url:'/api/auth/register',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type'}});
 assert.equal(preflight.statusCode,404);
 assert.equal(preflight.headers['access-control-allow-origin'],undefined);
 const socket=new WebSocket(base,{origin});
 try {
  const status=await new Promise((resolve,reject)=>{socket.once('unexpected-response',(_request,response)=>{response.resume();resolve(response.statusCode);});socket.once('open',()=>reject(new Error('Untrusted origin connected')));socket.once('error',reject);});
  assert.equal(status,403);
 }finally{socket.terminate();}
});
test('passwords are hashed, ordinary users cannot access admin, and sessions revoke',async()=>{
 assert.equal(one.status,201);assert.equal((await req('GET','/api/admin/dashboard',undefined,one.token)).status,403);
 assert.equal((await req('POST','/api/auth/login',{username:'first_user@example.test',password:'wrong-password'})).status,401);
 const stored=(await database.query('SELECT password_hash FROM users WHERE id=$1',[one.user.id])).rows[0].password_hash;
 assert.match(stored,/^scrypt:/);assert.equal(stored.includes(password),false);
 const login=await req('POST','/api/auth/login',{username:'second_user@example.test',password});
 await req('POST','/api/auth/logout',{},login.token);assert.equal((await req('GET','/api/auth/me',undefined,login.token)).status,401);
});
test('requires email for registration while existing username accounts can still log in',async()=>{
 const username='legacy_user',id=randomUUID();
 const registration=await req('POST','/api/auth/register',{username,password});
 assert.equal(registration.status,400);assert.match(registration.error,/邮箱/);
 assert.equal((await database.query('SELECT id FROM users WHERE username=$1',[username])).rowCount,0);
 await database.query('INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)',[id,username,await hashPassword(password)]);
 const login=await req('POST','/api/auth/login',{username,password});
 assert.equal(login.status,200);assert.equal(login.user.id,id);
});
test('email accounts register, sign in case-insensitively, and reject duplicate registration',async()=>{
 const username='reader+sync@example.test';
 const registered=await req('POST','/api/auth/register',{username,password:username});
 assert.equal(registered.status,201);assert.equal(registered.user.username,username);
 assert.equal((await req('GET','/api/auth/me',undefined,registered.token)).user.id,registered.user.id);
 await req('POST','/api/auth/logout',{},registered.token);
 const login=await req('POST','/api/auth/login',{username:` ${username.toUpperCase()} `,password:username});
 assert.equal(login.status,200);assert.equal(login.user.id,registered.user.id);
 assert.equal((await req('POST','/api/auth/login',{username,password:'wrong-password'})).status,401);
 assert.equal((await req('POST','/api/auth/register',{username:username.toUpperCase(),password:username})).status,409);
 const longEmail='longer-than-the-old-username-limit@example.test';
 const longAccount=await req('POST','/api/auth/register',{username:longEmail,password});
 assert.equal(longAccount.status,201);
 assert.equal((await req('POST','/api/auth/login',{username:longEmail,password})).user.id,longAccount.user.id);
});
test('broadcasts deletion and large live frames to clients on another server instance',async()=>{
 const second=await createApp({logger:false});
 await second.app.listen({host:'127.0.0.1',port:0});
 const url=`ws://127.0.0.1:${second.app.server.address().port}/sync`;
 const a=await connect(one.token,'instance-a'),b=await connect(one.token,'instance-b',url);
 try{
  const frame={chatId:'cross-instance',requestId:'live',sequence:1,startedAt:Date.now(),phase:'replying',chat:{id:'cross-instance',title:'Cross instance',messages:[{role:'assistant',content:'x'.repeat(12000)}]}};
  a.send({type:'live-chat',frame});
  assert.equal((await b.receive(m=>m.type==='live-chat')).frame.chat.messages[0].content.length,12000);
  const record={key:'cerebr_chat_v2_cross-instance',value:frame.chat,deleted:false,version:{clock:1,actor:'a'}};
  a.send({type:'put',record});assert.equal((await b.receive(m=>m.type==='record')).record.deleted,false);
  b.send({type:'put',record:{...record,value:null,deleted:true,version:{clock:2,actor:'b'}}});
  assert.equal((await a.receive(m=>m.type==='record'&&m.record.deleted)).record.deleted,true);
 }finally{a.socket.close();b.socket.close();await second.app.close();}
});
test('sync is isolated by account, live frames arrive before writes, deletes survive stale records, usage is measured',async()=>{
 const a=await connect(one.token,'web-a'),b=await connect(one.token,'desktop-b'),other=await connect(two.token,'other-account');
 try{
  const frame={chatId:'hello',requestId:'request',sequence:1,startedAt:Date.now(),phase:'thinking',chat:{id:'hello',title:'Unicode 测试',messages:[{role:'user',content:'question'}]}};
  a.send({type:'live-chat',frame});assert.equal((await b.receive(m=>m.type==='live-chat')).frame.phase,'thinking');
  a.send({type:'live-chat',frame:{...frame,chat:undefined,sequence:2,phase:'replying',index:1,message:{role:'assistant',content:'partial'}}});
  assert.equal((await b.receive(m=>m.type==='live-chat')).frame.message.content,'partial');
  const record={key:'cerebr_chat_v2_hello',value:{...frame.chat,messages:[...frame.chat.messages,{role:'assistant',content:'answer',reasoning_content:'**think**'}]},deleted:false,version:{clock:1,actor:'a'}};
  a.send({type:'put',record});await a.receive(m=>m.type==='record');assert.deepEqual((await b.receive(m=>m.type==='record')).record.value,record.value);
  other.send({type:'hello'});assert.deepEqual((await other.receive(m=>m.type==='manifest')).records,[]);
  a.send({type:'client-stats',chats:1,messages:2});a.send({type:'barrier',id:'check',verify:true});const summary=(await a.receive(m=>m.type==='caught-up'&&m.id==='check')).summary;assert.equal(summary.messages,2);assert.equal(summary.digest.length,64);
  assert.equal(summary.digest,(await database.summary(one.user.id,true)).digest);
  const dashboard=await req('GET','/api/admin/dashboard',undefined,admin.token);assert.equal(dashboard.clients.online,3);assert.ok(Number(dashboard.traffic.bytes_in)>0);
  b.send({type:'put',record:{...record,value:null,deleted:true,version:{clock:2,actor:'b'}}});await b.receive(m=>m.type==='record');await a.receive(m=>m.type==='record');
  a.send({type:'put',record});assert.equal((await a.receive(m=>m.type==='record')).record.deleted,true);
  assert.equal((await database.summary(one.user.id)).chats,0);
 }finally{for(const c of[a,b,other])c.socket.close();}
});
test('syncs webpage content and deletion tombstones without restoring stale documents',async()=>{
 const a=await connect(one.token,'webpage-desktop'),b=await connect(one.token,'webpage-extension');
 const record={key:'cerebr_webpage_source_v1_test:'+ 'a'.repeat(64),value:{url:'https://example.test/article',title:'Article',content:'Full cached webpage'},version:{clock:1,actor:'desktop'},deleted:false};
 try{
  a.send({type:'put',record});
  assert.deepEqual((await b.receive(m=>m.type==='record'&&m.record.key===record.key)).record.value,record.value);
  await a.receive(m=>m.type==='record'&&m.record.key===record.key);
  b.send({type:'put',record:{...record,value:null,deleted:true,version:{clock:2,actor:'extension'}}});
  assert.equal((await a.receive(m=>m.type==='record'&&m.record.key===record.key)).record.deleted,true);
  await b.receive(m=>m.type==='record'&&m.record.key===record.key);
  a.send({type:'put',record});
  assert.equal((await a.receive(m=>m.type==='record'&&m.record.key===record.key)).record.deleted,true);
 }finally{a.socket.close();b.socket.close();}
});
test('pause disconnects sync, ban revokes login, resume preserves records and audit',async()=>{
 const c=await connect(one.token,'paused-client');const closed=new Promise(resolve=>c.socket.once('close',resolve));
 assert.equal((await req('PATCH',`/api/admin/users/${one.user.id}`,{status:'paused'},admin.token)).status,200);assert.equal(await closed,4003);
 assert.equal((await req('GET','/api/auth/me',undefined,one.token)).user.status,'paused');
 await req('PATCH',`/api/admin/users/${one.user.id}`,{status:'banned'},admin.token);
 assert.equal((await req('POST','/api/auth/login',{username:'first_user@example.test',password})).status,403);
 await req('PATCH',`/api/admin/users/${one.user.id}`,{status:'active'},admin.token);
 assert.equal((await req('POST','/api/auth/login',{username:'first_user@example.test',password})).status,200);
 assert.equal((await req('PATCH',`/api/admin/users/${admin.user.id}`,{status:'banned'},admin.token)).status,400);
 assert.equal((await req('GET','/api/admin/audit',undefined,admin.token)).events.length,3);
});
test('migrates legacy audit rows to retain usernames after account deletion',async()=>{
 const id=randomUUID(),username='audit-migration@example.test';
 await database.query('INSERT INTO users(id,username,password_hash) VALUES($1,$2,$3)',[id,username,await hashPassword(password)]);
 await database.query('INSERT INTO audit_log(admin_id,user_id,username,action) VALUES($1,$2,$3,$4)',[admin.user.id,id,username,'paused']);
 await database.query('UPDATE audit_log SET username=NULL WHERE user_id=$1',[id]);
 await database.query('ALTER TABLE audit_log ALTER COLUMN user_id SET NOT NULL');
 await database.query('ALTER TABLE audit_log DROP CONSTRAINT audit_log_user_id_fkey; ALTER TABLE audit_log ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id)');
 await database.initialize({});
 assert.equal((await database.query("SELECT is_nullable FROM information_schema.columns WHERE table_name='audit_log' AND column_name='user_id'")).rows[0].is_nullable,'YES');
 assert.equal((await database.query('DELETE FROM users WHERE id=$1',[id])).rowCount,1);
 const audit=(await database.query("SELECT username,action,user_id FROM audit_log WHERE username=$1",[username])).rows[0];
 assert.equal(audit.username,username);assert.equal(audit.action,'paused');assert.equal(audit.user_id,null);
});
test('admin deletion requires the exact username and permanently removes user data across instances',async()=>{
 const userId=one.user.id,username=one.user.username,deviceId=randomUUID();
 const session=await req('POST','/api/auth/login',{username,password});
 assert.equal(session.status,200);
 const remote=await createApp({logger:false});
 await remote.app.listen({host:'127.0.0.1',port:0});
 const a=await connect(session.token,'delete-local'),b=await connect(session.token,'delete-remote',`ws://127.0.0.1:${remote.app.server.address().port}/sync`);
 try{
  assert.equal((await req('DELETE',`/api/admin/users/${userId}`,{username})).status,401);
  assert.equal((await req('DELETE',`/api/admin/users/${userId}`,{username},two.token)).status,403);
  assert.equal((await req('DELETE','/api/admin/users/invalid',{username},admin.token)).status,400);
  assert.equal((await req('DELETE',`/api/admin/users/${randomUUID()}`,{username},admin.token)).status,404);
  await database.query('INSERT INTO records(user_id,key,body,clock,actor,deleted,byte_size,chats,messages) VALUES($1,$2,$3,1,$4,false,10,1,1)',[userId,'delete-test',{key:'delete-test',value:{id:'delete-test',messages:[]},version:{clock:1,actor:'test'}},'test']);
  await database.query('INSERT INTO revisions(user_id,key,clock,actor,body) VALUES($1,$2,1,$3,$4)',[userId,'delete-test','test',{value:'old'}]);
  await database.query('INSERT INTO devices(user_id,id,name,platform) VALUES($1,$2,$3,$4)',[userId,deviceId,'delete-test','test']);
  await database.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'1 day\')',['extra-delete-session',userId]);
  await database.query('INSERT INTO traffic(user_id,device_id,hour,bytes_in) VALUES($1,$2,date_trunc(\'hour\',now()),99)',[userId,deviceId]);
  await database.query('INSERT INTO sync_events(user_id,message) VALUES($1,$2)',[userId,{type:'delete-test'}]);
  const wrongName=await req('DELETE',`/api/admin/users/${userId}`,{username:'wrong@example.test'},admin.token);
  assert.equal(wrongName.status,400);
  assert.equal((await req('DELETE',`/api/admin/users/${admin.user.id}`,{username:'admin_test'},admin.token)).status,400);
  await database.query("CREATE FUNCTION reject_test_user_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test deletion failure'; END $$; CREATE TRIGGER reject_test_user_delete BEFORE DELETE ON devices FOR EACH ROW EXECUTE FUNCTION reject_test_user_delete()");
  try{
   assert.equal((await req('DELETE',`/api/admin/users/${userId}`,{username},admin.token)).status,500);
   assert.equal((await req('GET','/api/auth/me',undefined,session.token)).status,200);
   assert.equal((await database.query('SELECT 1 FROM records WHERE user_id=$1 AND key=$2',[userId,'delete-test'])).rowCount,1);
   assert.equal((await database.query("SELECT 1 FROM audit_log WHERE username=$1 AND action='deleted'",[username])).rowCount,0);
  }finally{await database.query('DROP TRIGGER reject_test_user_delete ON devices; DROP FUNCTION reject_test_user_delete()');}
  const closedA=new Promise(resolve=>a.socket.once('close',code=>resolve(code)));
  const closedB=new Promise(resolve=>b.socket.once('close',code=>resolve(code)));
  const deleted=await req('DELETE',`/api/admin/users/${userId}`,{username},admin.token);
  assert.equal(deleted.status,200);assert.equal(deleted.user.username,username);
  assert.equal(await closedA,4001);assert.equal(await closedB,4001);
  assert.equal((await database.query('SELECT id FROM users WHERE id=$1',[userId])).rowCount,0);
  for(const table of ['sessions','sync_events','traffic','revisions','records','devices'])
   assert.equal((await database.query(`SELECT 1 FROM ${table} WHERE user_id=$1 LIMIT 1`,[userId])).rowCount,0,`${table} should be removed`);
  const audit=(await database.query('SELECT username,action,user_id FROM audit_log WHERE admin_id=$1 AND username=$2 ORDER BY id DESC LIMIT 1',[admin.user.id,username])).rows[0];
  assert.equal(audit.username,username);assert.equal(audit.action,'deleted');assert.equal(audit.user_id,null);
  assert.equal((await req('GET','/api/auth/me',undefined,session.token)).status,401);
  assert.equal((await req('GET','/api/auth/me',undefined,two.token)).status,200);
  assert.equal((await req('POST','/api/auth/login',{username,password})).status,401);
  assert.equal((await req('DELETE',`/api/admin/users/${userId}`,{username},admin.token)).status,404);
  assert.equal((await req('GET','/api/admin/audit',undefined,admin.token)).events[0].action,'deleted');
  const registered=await req('POST','/api/auth/register',{username,password});
  assert.equal(registered.status,201);assert.notEqual(registered.user.id,userId);
  assert.equal((await database.summary(registered.user.id)).records,0);
 }finally{a.socket.terminate();b.socket.terminate();await remote.app.close();}
});
