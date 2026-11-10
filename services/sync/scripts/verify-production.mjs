// Uses only synthetic, visibly named records; never deletes real user history.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
const env=Object.fromEntries((await readFile(new URL('../.env',import.meta.url),'utf8')).trim().split('\n').map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
const base='https://cerebr-sync.fugue.pro';
async function request(path,body,token){const r=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;}
const auth=await request('/auth/login',{username:env.ADMIN_USERNAME,password:env.ADMIN_PASSWORD});
const socket=new WebSocket(base.replace('https','wss')+'/sync'),inbox=[],waiters=[];
socket.on('message',raw=>{const data=JSON.parse(raw);const i=waiters.findIndex(w=>w.predicate(data));if(i<0)inbox.push(data);else{const [w]=waiters.splice(i,1);clearTimeout(w.timer);w.resolve(data);}});
const receive=predicate=>{const i=inbox.findIndex(predicate);if(i>=0)return Promise.resolve(inbox.splice(i,1)[0]);return new Promise((resolve,reject)=>{const w={predicate,resolve,timer:setTimeout(()=>reject(new Error('Production sync timeout')),30000)};waiters.push(w);});};
const send=m=>socket.send(JSON.stringify(m));
try{
 await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
 send({type:'auth',token:auth.token,client:{id:randomUUID(),name:'Cerebr protocol acceptance (temporary)',platform:'verification',version:'1.0.0'}});await receive(m=>m.type==='authenticated');
 const id='protocol-qa-'+randomUUID(),key='cerebr_chat_v2_'+id,clock=Date.now();
 const record={key,value:{id,title:'[临时验收] 多端图片、引用与删除',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[{role:'user',content:[{type:'text',text:'Synthetic verification'},{type:'image_url',image_url:{url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9sAAAAASUVORK5CYII='}}],selectionQuotes:['验收引用']},{role:'assistant',content:'**Markdown answer**',reasoning_content:'*Reasoning*',updating:false}]},deleted:false,version:{clock,actor:'acceptance'}};
 send({type:'put',record});assert.deepEqual((await receive(m=>m.type==='record'&&m.record.key===key)).record,record);
 const deleted={...record,value:null,deleted:true,version:{clock:clock+1,actor:'acceptance'}};send({type:'put',record:deleted});assert.equal((await receive(m=>m.type==='record'&&m.record.key===key)).record.deleted,true);
 send({type:'put',record});assert.equal((await receive(m=>m.type==='record'&&m.record.key===key)).record.deleted,true);
 send({type:'barrier',id:'final',verify:true});const final=(await receive(m=>m.type==='caught-up'&&m.id==='final')).summary;
 const users=await request('/admin/users',undefined,auth.token);const devices=await request(`/admin/users/${auth.user.id}/clients`,undefined,auth.token);
 const report={checkedAt:new Date().toISOString(),base,syntheticRecord:key,checks:{imageAndQuoteRoundTrip:true,reasoningRoundTrip:true,deleteTombstone:true,staleReplayRejected:true},summary:final,users:users.users.map(({id,username,clients,chats,messages,onlineClients})=>({id,username,clients,chats,messages,onlineClients})),clients:devices.clients.map(({name,platform,origin,app_version,chats,messages,online,bytes_in,bytes_out})=>({name,platform,origin,app_version,chats,messages,online,bytes_in,bytes_out}))};
 await writeFile(new URL('../artifacts/production-verification.json',import.meta.url),JSON.stringify(report,null,2));
 console.log(JSON.stringify({checks:report.checks,summary:final,clients:report.clients.map(c=>({name:c.name,online:c.online}))}));
}finally{socket.close();await request('/auth/logout',{},auth.token);}
