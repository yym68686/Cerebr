// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
const state=vi.hoisted(()=>({db:null,native:{},local:{}}));
vi.mock('../src/utils/storage-adapter.js',()=>({
 isExtensionEnvironment:true,getDb:async()=>state.db,
 storageAdapter:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,state.local[key]])),set:async values=>Object.assign(state.local,structuredClone(values))},
 syncStorageAdapter:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,state.native[key]])),set:async values=>Object.assign(state.native,structuredClone(values))},
}));
import { ensureApiReplica, readApiReplica, writeApiReplica, projectApiSettingsToLegacy } from '../src/runtime/sync/api-settings.js';
import { upgradeReplica, replicaRecords, applyRemoteRecord } from '../src/runtime/sync/replica.js';
import { API_CONFIG_PREFIX } from '../src/runtime/sync/protocol.js';
const databases=[];
async function database(){const factory=new IDBFactory();const db=await new Promise((resolve,reject)=>{const request=factory.open('test',2);request.onupgradeneeded=()=>{request.result.createObjectStore('keyValueStore');upgradeReplica(request.result);};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});databases.push(db);return db;}
const config=(id,model)=>({id,baseUrl:'https://api.example/v1/chat/completions',apiKey:'test-only-key',modelName:model,advancedSettings:{temperature:0.3}});
beforeEach(()=>{vi.stubGlobal('IDBKeyRange',IDBKeyRange);state.native={};state.local={};});
afterEach(()=>{databases.splice(0).forEach(db=>db.close());vi.unstubAllGlobals();});
it('seeds full API settings including long local prompts and merges existing config IDs on first connection',async()=>{
 const a=await database(),b=await database();state.db=a;state.native={apiConfigs:[config('a','model-a')],selectedConfigIndex:0,apiConfigSystemPromptLocalOnly_a:true};state.local={apiConfigSystemPrompt_a:'local long prompt '.repeat(600)};
 await ensureApiReplica(a);const original=await readApiReplica();const firstRecords=await replicaRecords(a);
 expect(original.configs[0].advancedSettings.systemPrompt).toBe(state.local.apiConfigSystemPrompt_a);
 state.db=b;state.native={apiConfigs:[config('b','model-b')],selectedConfigIndex:0};state.local={};await ensureApiReplica(b);
 for(const record of firstRecords)await applyRemoteRecord(b,record);
 expect((await readApiReplica()).configs.map(config=>config.id).sort()).toEqual(['a','b']);
 expect((await readApiReplica()).configs.find(config=>config.id==='a').apiKey).toBe('test-only-key');
 expect(firstRecords.every(record=>record.version.clock===0)).toBe(true);
});
it('does not seed an unconfigured desktop placeholder and propagates config edits, selection and deletion',async()=>{
 state.db=await database();await ensureApiReplica();expect(await readApiReplica()).toBeNull();expect(await replicaRecords(state.db)).toEqual([]);
 await writeApiReplica([config('a','first'),config('b','second')],1);expect((await readApiReplica()).selected).toBe(1);
 await writeApiReplica([{...config('b','updated'),apiKey:'rotated-test-key'}],0);
 const shared=await readApiReplica();expect(shared.configs).toHaveLength(1);expect(shared.configs[0].modelName).toBe('updated');
 const removed=(await replicaRecords(state.db)).find(record=>record.key===API_CONFIG_PREFIX+'a');expect(removed.deleted).toBe(true);
 await projectApiSettingsToLegacy(shared);expect(state.native.apiConfigs[0].apiKey).toBe('rotated-test-key');expect(state.native.selectedConfigIndex).toBe(0);
});
