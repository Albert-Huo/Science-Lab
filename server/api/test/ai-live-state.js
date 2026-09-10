'use strict';
const assert=require('node:assert/strict');
const {sanitizeLiveState,liveStatePrompt}=require('../ai-live-state');
const {createAiPolicy}=require('../ai-policy');
const ai=require('../../../ai-chat');
const path='physics-middle/初中物理实验2.html';
const state={version:1,experimentPath:path,capturedAt:Date.now(),mode:'演示模式 · 自动运行',status:'状态：加热',
  step:'关卡 1 / 3',task:'启动水浴加热',hint:'观察温度计',readouts:[{label:'温度',value:'35.0℃'}]};
assert.deepEqual(sanitizeLiveState(state,path),state);
for(const raw of [null,{}, {...state,experimentPath:'physics-middle/初中物理实验1.html'},
  {...state,capturedAt:Date.now()-31000},{...state,capturedAt:Date.now()+6000},
  {...state,mode:'x'.repeat(101)},{...state,readouts:Array(17).fill(state.readouts[0])},
  {...state,readouts:[{label:'t',value:{}}]}]) assert.equal(sanitizeLiveState(raw,path),null);
assert.equal(sanitizeLiveState({...state,experimentPath:'physics-popular/test.html'},'physics-popular/test.html'),null);
assert.equal(sanitizeLiveState({...state,secret:'must not forward'},path).secret,undefined);
assert.match(liveStatePrompt(state,path),/35.0℃/);
assert.match(liveStatePrompt(null,path),/未取得有效/);
const policy=createAiPolicy(require('../ai-context.json'),'test-model');
const request={context:{experimentPath:path,liveState:state},messages:[{role:'user',content:'我现在第几关？'}]};
assert.match(policy(request).value.messages[0].content,/35.0℃/);
assert.ok(!policy({...request,context:{experimentPath:path}}).value.messages[0].content.includes('35.0℃'));
assert.match(policy({...request,context:{experimentPath:path,liveState:{...state,capturedAt:1}}}).value.messages[0].content,/未取得有效/);

function harness(){
  const events=new Map(),timers=new Map(),loads=new Map();let sent;
  const target={postMessage(data,origin){sent={data,origin};}};
  const frame={contentWindow:target,src:'https://html.xingnian.net.cn/'+path,
    addEventListener:(name,fn)=>loads.set(name,fn),removeEventListener:name=>loads.delete(name)};
  const view={location:{href:'https://lab.xingnian.net.cn/'},crypto:{randomUUID:()=> 'test-session'},
    addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name),
    setTimeout:(fn,ms)=>{assert.equal(ms,800);timers.set(1,fn);return 1;},clearTimeout:id=>timers.delete(id)};
  function reply(overrides={},dataOverrides={}){events.get('message')?.({source:target,origin:'https://html.xingnian.net.cn',
    data:{channel:sent.data.channel,type:'snapshot',requestId:sent.data.requestId,state,...dataOverrides},...overrides});}
  return {view,frame,reply,events,timers,loads,get sent(){return sent;}};
}
async function main(){
  const h=harness(),controller=new AbortController();
  let resolved=false;
  const pending=ai.requestSnapshot(h.view,h.frame,path,controller.signal).then(x=>{resolved=true;return x;});
  assert.equal(h.sent.origin,'https://html.xingnian.net.cn');
  h.reply({origin:'https://evil.example'});h.reply({source:{}});h.reply({}, {requestId:'old-session'});
  h.reply({}, {state:{...state,experimentPath:'physics-middle/初中物理实验3.html'}});
  await Promise.resolve();assert.equal(resolved,false);
  h.reply({}, {state:{...state,secret:'private',readouts:[{...state.readouts[0],secret:'private'}]}});
  assert.deepEqual(await pending,state);assert.equal(h.events.size,0);assert.equal(h.timers.size,0);assert.equal(h.loads.size,0);
  for(const kind of ['timeout','load','abort']){
    const f=harness(),abort=new AbortController();const result=ai.requestSnapshot(f.view,f.frame,path,abort.signal);
    if(kind==='timeout') f.timers.get(1)();else if(kind==='load') f.loads.get('load')();else abort.abort();
    assert.equal(await result,null);assert.equal(f.events.size,0);assert.equal(f.timers.size,0);
  }
  const f=harness();assert.equal(await ai.requestSnapshot(f.view,f.frame,'physics-popular/test.html'),null);assert.equal(f.sent,undefined);
  console.log('✓ 实时状态：白名单、来源/窗口/请求隔离、过期/超长回退、取消清理及提示词');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
