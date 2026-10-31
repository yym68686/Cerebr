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
import { API_CONFIG_PREFIX, API_SELECTION, isSyncedKey } from '../src/runtime/sync/protocol.js';
import { DEFAULT_MODEL, LEGACY_MODEL, writeDefaultModel } from '../src/runtime/sync/model-preferences.js';
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
 await projectApiSettingsToLegacy(shared);expect(state.native.apiConfigs[0].apiKey).toBe('rotated-test-key');expect(state.native.selectedConfigIndex).toBeUndefined();expect(state.local.selectedConfigIndex).toBe(0);
});

it('keeps this device’s model when logging in merges another device and an old global selection',async()=>{
 state.db=await database();state.native={apiConfigs:[config('desktop','gemini-4-argon')],selectedConfigIndex:0};
 await ensureApiReplica();
 await applyRemoteRecord(state.db,{key:API_CONFIG_PREFIX+'phone',value:{config:config('phone','gemini-3.1-pro'),order:-1},deleted:false,version:{clock:100,actor:'phone'}});
 await applyRemoteRecord(state.db,{key:API_SELECTION,value:'phone',deleted:false,version:{clock:200,actor:'phone'}});
 const merged=await readApiReplica();
 expect(merged.configs[merged.selected].id).toBe('desktop');
 expect(merged.defaultSelection.modelName).toBe('gemini-4-argon');
 await projectApiSettingsToLegacy(merged);
 expect(state.native.selectedConfigIndex).toBe(0); // never projected into Chrome sync
 expect(isSyncedKey(DEFAULT_MODEL)).toBe(false);expect(isSyncedKey(LEGACY_MODEL)).toBe(false);
 const before=await replicaRecords(state.db);
 await writeDefaultModel(config('phone','gemini-3.1-pro'));
 const switched=await readApiReplica();
 expect(switched.defaultSelection.modelName).toBe('gemini-3.1-pro');
 expect(switched.legacySelection.modelName).toBe('gemini-4-argon');
 expect(await replicaRecords(state.db)).toEqual(before); // explicit model selection has no global sync write
});

it('saves just edited API IDs without deleting or reverting a concurrent remote addition',async()=>{
 state.db=await database();await writeApiReplica([config('a','model-a')],0);
 await applyRemoteRecord(state.db,{key:API_CONFIG_PREFIX+'remote',value:{config:config('remote','model-remote'),order:1},deleted:false,version:{clock:Date.now()+1000,actor:'remote'}});
 await writeApiReplica([{...config('a','model-a'),apiKey:'rotated'}],undefined,{changedIds:['a'],removedIds:[]});
 const saved=await readApiReplica();expect(saved.configs.map(c=>c.id).sort()).toEqual(['a','remote']);
 expect(saved.configs.find(c=>c.id==='a').apiKey).toBe('rotated');
 expect((await replicaRecords(state.db)).some(r=>r.key===API_SELECTION)).toBe(false);
});

it('syncs model-less connections without sharing the device’s discovered model selection',async()=>{
 state.db=await database();await writeApiReplica([config('auto','')],0);
 const before=await replicaRecords(state.db);
 expect((await readApiReplica()).configs[0].modelName).toBe('');
 await writeDefaultModel(config('auto','discovered-model'));
 const selected=await readApiReplica();
 expect(selected.defaultSelection).toEqual({configId:'auto',modelName:'discovered-model'});
 expect(selected.configs[0].modelName).toBe('');
 expect(await replicaRecords(state.db)).toEqual(before);
 await projectApiSettingsToLegacy(selected);
 expect(state.native.apiConfigs[0].modelName).toBe('');
 expect(JSON.stringify(state.native)).not.toContain('discovered-model');
});
