'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const vm=require('vm');
const html=fs.readFileSync(path.resolve(__dirname,'../../../index.html'),'utf8');
const start=html.indexOf("const hint=document.getElementById('hint');");
const end=html.indexOf('/* ---------- init ---------- */',start);
assert(start>=0&&end>start);
function exercise(seen){
 const elements={};
 function el(id){return elements[id]||(elements[id]={events:{},hidden:false,classes:new Set(id==='hint'?['hide']:[]),classList:{add(x){elements[id].classes.add(x);},remove(x){elements[id].classes.delete(x);}},addEventListener(name,handler){this.events[name]=handler;},focus(){this.focused=true;},querySelector(){return {open:false};}});}
 const saved=[];
 const context=vm.createContext({document:{getElementById:el},safeGet:()=>seen,safeSet:(key,value)=>saved.push([key,value]),LS:{hint:'welcome'},updateScrollBand(){},closePanels(){}});
 vm.runInContext(html.slice(start,end),context);
 const visible=()=>!el('hint').classes.has('hide');
 assert.strictEqual(visible(),!seen,'首次打开显示简短欢迎，重访不重复');
 el('hintOk').events.click();assert(!visible());assert.deepStrictEqual(saved,[['welcome','1']]);
 assert(el('operationHelp').events.click,'主动帮助入口必须能重新打开欢迎');
 el('operationHelp').events.click();assert(visible());assert(el('hintOk').focused,'重开帮助应移入键盘焦点');
 el('hintOk').events.click();assert(!visible());
}
exercise(null);exercise('1');
assert.match(html,/id="operationHelp"/);
const welcome=html.slice(html.indexOf('<div id="hint"'),html.indexOf('<div id="toast"'));
assert.match(welcome,/当前任务/);assert.match(welcome,/💡/);
assert(!welcome.includes('我的 / AI'),'首次说明只讲当前任务和帮助');
console.log('✓ 首次欢迎、重访不重复、主动重看帮助通过');
const navStart=html.indexOf('let wheelLock=0;');
const navEnd=html.indexOf('/* ---------- hint & toast ---------- */',navStart);
const handlers={},moves=[];
const nav=vm.createContext({window:{addEventListener:(name,handler)=>handlers[name]=handler},document:{querySelector:selector=>selector.includes('#hint')?{}:null,activeElement:{tagName:'BUTTON'}},next:()=>moves.push('next'),prev:()=>moves.push('prev'),closePanels(){}});
vm.runInContext(html.slice(navStart,navEnd),nav);
handlers.keydown({key:'ArrowDown'});handlers.keydown({key:'PageDown'});handlers.wheel({deltaY:200});
assert.deepStrictEqual(moves,[],'帮助打开时不能通过方向键或滚轮翻动背景实验');
console.log('✓ 欢迎与操作帮助阻止背景翻页');
