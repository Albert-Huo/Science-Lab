(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory();
  else root.ScienceAiChat=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function requestSnapshot(view,frame,path,signal){
    if(!/^physics-middle\/初中物理实验\d+(?:-\d+)?\.html$/.test(path)||!frame||!frame.contentWindow||signal?.aborted) return Promise.resolve(null);
    const target=frame.contentWindow,origin=new URL(frame.src,view.location.href).origin;
    if(origin==='null') return Promise.resolve(null);
    const channel='science-lab.experiment-state.v1',requestId=view.crypto.randomUUID();
    return new Promise(resolve=>{
      let timer;
      function finish(state){
        view.clearTimeout(timer);view.removeEventListener('message',receive);
        frame.removeEventListener('load',cancel);signal?.removeEventListener('abort',cancel);
        resolve(state);
      }
      function cancel(){finish(null);}
      function receive(event){
        const data=event.data;
        if(event.source!==target||event.origin!==origin||!data||data.channel!==channel||
          data.type!=='snapshot'||data.requestId!==requestId) return;
        const raw=data.state;
        if(!raw||raw.version!==1||raw.experimentPath!==path||!Number.isSafeInteger(raw.capturedAt)||
          Math.abs(Date.now()-raw.capturedAt)>5000) return;
        const state={version:1,experimentPath:path,capturedAt:raw.capturedAt};
        for(const [key,max] of Object.entries({mode:100,status:160,step:80,task:240,hint:240})){
          if(typeof raw[key]!=='string'||raw[key].length>max) return;
          state[key]=raw[key];
        }
        if(!state.mode||!state.step||!Array.isArray(raw.readouts)||raw.readouts.length>16) return;
        state.readouts=[];
        for(const row of raw.readouts){
          if(!row||typeof row.label!=='string'||row.label.length>40||typeof row.value!=='string'||row.value.length>100) return;
          state.readouts.push({label:row.label,value:row.value});
        }
        finish(state);
      }
      view.addEventListener('message',receive);frame.addEventListener('load',cancel);
      signal?.addEventListener('abort',cancel);
      timer=view.setTimeout(cancel,800);
      try{target.postMessage({channel,type:'snapshot-request',requestId,experimentPath:path},origin);}
      catch(error){console.warn('实验状态通信不可用：'+error.name);finish(null);}
    });
  }
  function selectMessages(messages){
    const current=messages[messages.length-1];
    if(!current||current.role!=='user'||typeof current.content!=='string'||!current.content.trim()) throw new Error('请输入问题');
    if(current.content.length>4000) throw new Error('问题不能超过 4000 字符，请缩短后发送');
    const pairs=[];
    for(let i=0;i<messages.length-1;i++){
      const user=messages[i], assistant=messages[i+1];
      if(user.role==='user'&&assistant&&assistant.role==='assistant'){
        if(!user.incomplete&&!assistant.incomplete&&typeof user.content==='string'&&typeof assistant.content==='string'&&user.content&&assistant.content&&user.content.length<=4000&&assistant.content.length<=4000) pairs.push([user,assistant]);
        i++;
      }
    }
    let budget=12000-current.content.length;
    const selected=[];
    for(let i=pairs.length-1;i>=0&&selected.length<5;i--){
      const size=pairs[i][0].content.length+pairs[i][1].content.length;
      if(size>budget) break;
      budget-=size; selected.unshift(pairs[i]);
    }
    return [...selected.flat(),current].map(({role,content})=>({role,content}));
  }
  function validateEndpoint(value){
    let url;
    try{ url=new URL(value); }catch(error){ throw new Error('请输入有效的接口地址'); }
    if(url.username||url.password) throw new Error('接口地址不能包含凭据');
    const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&local)) throw new Error('接口必须使用 HTTPS（localhost 调试除外）');
    return url.href;
  }
  function createSseParser(onText){
    let buffer='', text='', done=false, finish='';
    function line(value){
      if(done||!value.startsWith('data:')) return;
      const payload=value.slice(5).trim();
      if(!payload) return;
      if(payload==='[DONE]'){ done=true; return; }
      let data;
      try{ data=JSON.parse(payload); }catch(error){ throw new Error('流式响应格式异常'); }
      if(data.error) throw new Error(typeof data.error==='string'?data.error:(data.error.message||'模型服务返回错误'));
      const choice=data.choices&&data.choices[0];
      if(!choice) return;
      if(choice.finish_reason) finish=choice.finish_reason;
      const delta=choice.delta&&choice.delta.content;
      if(typeof delta==='string'&&delta){
        const available=24000-text.length;
        text+=delta.slice(0,available);
        if(onText) onText(text);
        if(delta.length>available) throw new Error('回答内容过长，已停止生成');
      }
    }
    return {
      push(chunk){
        buffer+=chunk;
        let end;
        while((end=buffer.indexOf('\n'))>=0){ const value=buffer.slice(0,end).replace(/\r$/,''); buffer=buffer.slice(end+1); line(value); }
        if(buffer.length>256000) throw new Error('流式响应数据过长');
      },
      end(){
        if(buffer){ line(buffer.replace(/\r$/,'')); buffer=''; }
        if(finish==='length') throw new Error('回答达到长度上限，内容尚未完成');
        if(finish&&finish!=='stop') throw new Error('回答未正常完成（'+finish+'）');
        if(!done) throw new Error('流式响应意外中断');
        if(!text.trim()) throw new Error('模型未返回文字，请重试');
        return text;
      },
      get done(){ return done; },
      get text(){ return text; }
    };
  }
  function retryText(headers){
    const value=headers.get('Retry-After');
    if(!value) return '';
    const seconds=/^\d+$/.test(value)?Number(value):Math.ceil((Date.parse(value)-Date.now())/1000);
    return Number.isFinite(seconds)&&seconds>0?' 请在 '+seconds+' 秒后重试。':'';
  }
  async function responseError(response){
    const known={429:'请求过于频繁或可用额度已用完。',503:'AI 服务暂时繁忙，请稍后重试。',504:'AI 服务响应超时，请稍后重试。',401:'认证失败，请检查 API Key 或联系管理员。',403:'当前请求无权使用此服务。'};
    if(known[response.status]) return known[response.status]+retryText(response.headers);
    let detail='';
    if((response.headers.get('content-type')||'').includes('application/json')){
      try{
        const data=await response.json();
        detail=data.message||(typeof data.error==='string'?data.error:data.error&&data.error.message)||'';
      }catch(error){ detail='响应内容无法解析'; }
    }
    return '请求失败（HTTP '+response.status+'）'+(detail?'：'+String(detail).slice(0,300):'，请稍后重试。')+retryText(response.headers);
  }
  function quotaText(headers){
    const rawLimit=headers.get('X-AI-Quota-Limit'),rawRemaining=headers.get('X-AI-Quota-Remaining');
    if(rawLimit===null||rawRemaining===null) return '';
    const limit=Number(rawLimit),remaining=Number(rawRemaining),reset=Number(headers.get('X-AI-Quota-Reset'));
    if(!Number.isFinite(limit)||!Number.isFinite(remaining)||limit<0||remaining<0) return '';
    const scope={session_day:'会话额度',ip_day:'网络额度',global_day:'全站额度',ip_minute:'当前网络每分钟',concurrency:'同时请求'}[headers.get('X-AI-Quota-Scope')]||'当前';
    return scope+'剩余 '+remaining+' / '+limit+(reset>0?' · '+new Date(reset*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})+' 重置':'');
  }
  return {requestSnapshot,selectMessages,validateEndpoint,createSseParser,responseError,quotaText};
});
