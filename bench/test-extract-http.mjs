// Pure Node: exercises the real HTTP request/parser path with mock fetch, no browser/key.
const { strict: assert } = await import('node:assert');
const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const dir = mkdtempSync(join(tmpdir(), 'extract-http-'));
process.env.TYPESAFE_TEXT_MODEL_FILE = join(dir, 'absent');
const { callTextModelForExtraction: call, validateSchema, normalizeExtractionSchema, resolveExtractionModel, extract, settle } = await import('../scripts/decider-loop.mjs');
let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log('ok ' + name); };
const original = globalThis.fetch;
const cfg = { kind:'openai-compatible',baseUrl:'http://localhost:11434/v1',model:'local' };
let requests = [];
const reply = (data, extra = {}) => ({ choices:[{ finish_reason:'stop',message:{content:JSON.stringify({data})}, ...extra }] });
let payload = reply([1,2,3]);
globalThis.fetch = async (url, init) => { requests.push({url,...init,body:JSON.parse(init.body)}); return {ok:true,json:async()=>payload}; };
const schema = {type:'array',minItems:3,maxItems:3,items:{type:'number'}};
try {
  const r = await call('page','first 3',schema,{deciderConfig:cfg});
  check('no-key local HTTP envelope returns 3 items',()=>assert.deepEqual(r.data,[1,2,3]));
  check('local has no Authorization/TypeSafe fallback',()=>assert.equal(requests[0].headers.Authorization,undefined));
  check('array uses structured JSON mode',()=>assert.match(requests[0].body.messages[0].content,/JSON/));
  // Direct output wins if valid; only a valid single-data-field candidate may unwrap.
  for (const [name, raw, expectedSchema, expectedData] of [
    ['direct data field', {data:'expected field'}, {data:'string'}, {data:'expected field'}],
    ['nested direct data fields', {data:{data:'nested'}}, {data:{data:'string'}}, {data:{data:'nested'}}],
    ['wrapped object with data field', {data:{data:'expected field'}}, {data:'string'}, {data:'expected field'}],
    ['array envelope', {data:[1,2,3]}, schema, [1,2,3]],
    ['primitive string envelope', {data:'value'}, {type:'string'}, 'value'],
    ['primitive number envelope', {data:42}, {type:'number'}, 42],
    ['primitive null envelope', {data:null}, {type:'null'}, null],
    ['no schema unwraps single data field once', {data:{data:'nested'}}, null, {data:'nested'}],
    ['no schema preserves other objects', {data:'field',other:1}, null, {data:'field',other:1}],
  ]) {
    payload = reply(null,{message:{content:JSON.stringify(raw)}});
    const actual = await call('page','read',expectedSchema,{textModel:cfg});
    check(name,()=>{ assert.equal(actual.success,true); assert.deepEqual(actual.data,expectedData); });
  }
  for (const raw of [{data:'bad'}, {data:[1,2,3],extra:true}, {data:{data:[1,2,3]}}]) {
    payload = reply(null,{message:{content:JSON.stringify(raw)}});
    const actual = await call('page','read',schema,{textModel:cfg});
    check('invalid/ambiguous envelope fails',()=>assert.equal(actual.reason,'schema_validation_failed'));
  }
  payload = reply([1]);
  check('HTTP underfull list fails minItems',()=>{});
  assert.equal((await call('page','3',schema,{deciderConfig:cfg})).reason,'schema_validation_failed');
  payload = reply([1,2,3,4]);
  assert.equal((await call('page','3',schema,{deciderConfig:cfg})).success,false); pass++;
  payload = reply({title:'one'});
  assert.equal((await call('page','3',schema,{deciderConfig:cfg})).success,false); pass++;
  for (const p of [reply([1,2,3],{finish_reason:'length'}),reply([1,2,3],{finish_reason:'content_filter'}),reply([1,2,3],{message:{refusal:'no',content:'{"data":[1,2,3]}'}}),{error:{message:'failed'},...reply([1,2,3])},reply([1,2,3],{finish_reason:null})]) {
    payload=p; assert.equal((await call('p','x',schema,{deciderConfig:cfg})).reason,'model_response_failed'); pass++;
  }
  for (const content of ['{"title":"x"}','{"data":[1,2,3],"extra":true}','prefix {"data":[1,2,3]}','{"data":']) {
    payload={choices:[{finish_reason:'stop',message:{content}}]}; assert.equal((await call('p','x',schema,{deciderConfig:cfg})).success,false);pass++;
  }
  globalThis.fetch=async()=>({ok:false,status:503});
  assert.equal((await call('p','x',schema,{deciderConfig:cfg})).reason,'api_error');pass++;
  for (const [value,s] of [[Array(50).fill(1).concat('bad'),{type:'array',items:{type:'number'}}],['x',{type:'null'}],['wrong',{type:'string',enum:['ok']}],[[],{type:'array',minItems:1}],[[1,'bad'],['number']],[[null,'bad'],['null']]]) {
    assert.equal(validateSchema(value,s).valid,false);pass++;
  }
  assert.equal(validateSchema([null,null],['null']).valid,true);pass++;
  for (const s of [{type:'string',pattern:'a'},{type:'array',minItems:-1},{type:['null','string']},{type:'array',items:false}]) {
    assert.throws(()=>normalizeExtractionSchema(s));pass++;
  }
  writeFileSync(join(dir,'key'),'local-test-key\n');
  globalThis.fetch=async(url,init)=>{ assert.equal(init.headers.Authorization,'Bearer local-test-key');return {ok:true,json:async()=>reply([1,2,3])}; };
  assert.equal((await call('p','x',schema,{deciderConfig:{...cfg,apiKeyFile:join(dir,'key')}})).success,true);pass++;
  // File config + partial overrides; never read or print real user credentials.
  process.env.EGO_JEV_DECIDER_FILE=join(dir,'decider.json');
  writeFileSync(process.env.EGO_JEV_DECIDER_FILE,JSON.stringify({...cfg,model:'file-model'}));
  const merged=resolveExtractionModel({deciderConfig:{baseUrl:'http://localhost:99/v1',model:undefined}});
  assert.equal(merged.model,'file-model'); assert.equal(merged.baseUrl,'http://localhost:99/v1');pass++;
  for (const error of [Object.assign(new Error('user takeover'),{code:'EGO_USER_TAKEOVER'}),Object.assign(new Error('evaluation safety timeout'),{executionStopped:false,mayHaveLateEffects:true,pageResponsive:false}),new Error('unknown evaluation failure')]) {
    for (const method of [settle,(p)=>extract(p,'read',{injectedExtractor:()=>{throw new Error('must not call model');}})]) {
      let calls=0;
      await assert.rejects(()=>method({evaluate:async()=>{calls++;throw error;}}),e=>e===error);
      assert.equal(calls,1);pass++;
    }
  }
  let modelCalls=0;
  const invalid=await extract({evaluate:async()=>{throw new Error('must not observe');}},'read',{schema:{type:'string',pattern:'x'},injectedExtractor:()=>{modelCalls++;}});
  assert.equal(invalid.reason,'invalid_schema');assert.equal(modelCalls,0);pass++;
  console.log(`HTTP/schema/control: ${pass} passed`);
} finally { globalThis.fetch=original;rmSync(dir,{recursive:true,force:true}); }
