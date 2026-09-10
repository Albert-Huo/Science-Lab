'use strict';
// Read-only content integration checks. Pass the sibling public content checkout explicitly.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(process.argv[2]||'../HTML-');
const receiver=require(path.join(root,'experiment-ai-state.v1.js'));
const manifest=require('../manifest.json');
const experiments=manifest.filter(item=>item.path.startsWith('physics-middle/'));
for(const item of experiments){
  const html=fs.readFileSync(path.join(root,item.path),'utf8');
  assert.equal((html.match(/<script src="\.\.\/experiment-ai-state\.v1\.js" data-science-lab-ai-state><\/script>/g)||[]).length,1,item.path);
  assert.match(html,/id="(?:modeTag|modeChip)"/,item.path);
  assert.match(html,/id="(?:taskStep|stepNo)"/,item.path);
  assert.equal(receiver.experimentPath('/'+encodeURI(item.path)),item.path);
}
for(const item of manifest.filter(item=>!item.path.startsWith('physics-middle/'))){
  assert.ok(!fs.readFileSync(path.join(root,item.path),'utf8').includes('data-science-lab-ai-state'),item.path);
}
assert.equal(receiver.experimentPath('/physics-popular/初中物理实验2.html'),null);
assert.equal(receiver.experimentPath('/physics-middle/%ZZ'),null);
assert.equal(receiver.allowedParent('https://lab.xingnian.net.cn.evil.example','https://html.xingnian.net.cn'),false);
const doc={getElementById(id){
  const content={modeTag:'自由模式',taskStep:'关卡 2 / 3',tempText:'35.0℃',coldPill:'冷水扩散: 10%',
    taskText:'  当前\n任务  ',taskHint:'请观察',statusTag:'状态：运行',powerText:'PRIVATE INPUT',pillA:'路程:0.50m'};
  return id in content?{textContent:content[id],matches:()=>id==='powerText',querySelector:()=>null}:null;
}};
const snapshot=receiver.collect(doc,'physics-middle/初中物理实验13.html',123);
assert.equal(snapshot.task,'当前 任务');
assert.equal(snapshot.capturedAt,123);
assert.ok(snapshot.readouts.some(row=>row.label==='冷水扩散'));
assert.ok(snapshot.readouts.some(row=>row.label==='路程'&&row.value==='0.50m'));
assert.ok(!JSON.stringify(snapshot).includes('PRIVATE'));
const listeners=new Map(),messages=[];
const parent={postMessage:(data,origin)=>messages.push({data,origin})};
const view={parent,document:doc,location:{pathname:'/physics-middle/初中物理实验13.html',origin:'https://html.xingnian.net.cn'},
  addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
const installed=receiver.install(view);
const request={channel:receiver.CHANNEL,type:'snapshot-request',requestId:'test-1',experimentPath:'physics-middle/初中物理实验13.html'};
const receive=(source,origin,data=request)=>listeners.get('message')({source,origin,data});
receive({},'https://lab.xingnian.net.cn');receive(parent,'https://evil.example');
receive(parent,'https://lab.xingnian.net.cn',{...request,experimentPath:'physics-middle/初中物理实验2.html'});
assert.equal(messages.length,0);
receive(parent,'https://lab.xingnian.net.cn');assert.equal(messages.length,1);
assert.equal(messages[0].origin,'https://lab.xingnian.net.cn');
installed.destroy();assert.equal(listeners.size,0);
console.log(`✓ ${experiments.length} 个初中物理实验接入；其他目录排除；接收端来源、路径、字段与隐私检查通过`);
