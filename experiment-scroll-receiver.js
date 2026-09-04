(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  else api.createReceiver(root);
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const CHANNEL='science-lab.scroll.v1';
  function allowedParent(origin,contentOrigin){
    if(origin==='https://lab.xingnian.net.cn') return true;
    try{
      const parent=new URL(origin),content=new URL(contentOrigin),local=new Set(['localhost','127.0.0.1']);
      return local.has(parent.hostname)&&local.has(content.hostname)&&
        ['http:','https:'].includes(parent.protocol)&&['http:','https:'].includes(content.protocol);
    }catch(error){return false;}
  }
  function createReceiver(view,options={}){
    if(view.parent===view) return {destroy(){}};
    const doc=view.document;
    const getTarget=options.getTarget||(()=>doc.scrollingElement);
    let connection=null,pending=0,resizeObserver=null,modalObserver=null;
    function blocked(){
      return Array.from(doc.querySelectorAll('dialog[open],[aria-modal="true"],.modal.show,.modal.open,.modal-mask')).some(el=>{
        const style=view.getComputedStyle(el);
        return style.display!=='none'&&style.visibility!=='hidden'&&style.opacity!=='0'&&el.getBoundingClientRect().height>0;
      });
    }
    function metrics(){
      const target=getTarget();
      if(!target) return null;
      const viewport=target.clientHeight,max=Math.max(0,target.scrollHeight-viewport);
      return {top:Math.max(0,Math.min(max,target.scrollTop)),max,viewport,blocked:blocked()};
    }
    function report(){
      pending=0;
      const state=metrics();
      if(connection&&state&&state.viewport>0) view.parent.postMessage({channel:CHANNEL,type:'state',session:connection.session,...state},connection.origin);
    }
    function schedule(){if(connection&&!pending) pending=view.requestAnimationFrame(report);}
    function disconnect(){
      connection=null;
      if(pending) view.cancelAnimationFrame(pending);
      pending=0;
      resizeObserver?.disconnect(); modalObserver?.disconnect();
      resizeObserver=null; modalObserver=null;
      view.removeEventListener('scroll',schedule,true); view.removeEventListener('resize',schedule);
    }
    function connect(event,data){
      disconnect(); connection={origin:event.origin,session:data.session};
      view.addEventListener('scroll',schedule,true); view.addEventListener('resize',schedule);
      if(view.ResizeObserver){
        resizeObserver=new view.ResizeObserver(schedule);
        for(const element of new Set([doc.body,getTarget()])) if(element) resizeObserver.observe(element);
      }
      if(view.MutationObserver){
        modalObserver=new view.MutationObserver(schedule);
        for(const modal of doc.querySelectorAll('dialog,[aria-modal],.modal,.modal-mask')) modalObserver.observe(modal,{attributes:true,attributeFilter:['class','style','hidden','open']});
      }
      schedule();
    }
    function receive(event){
      const data=event.data;
      if(event.source!==view.parent||!allowedParent(event.origin,view.location.origin)||!data||
        data.channel!==CHANNEL||typeof data.session!=='string'||!data.session||data.session.length>96) return;
      if(data.type==='connect'){connect(event,data);return;}
      if(!connection||event.origin!==connection.origin||data.session!==connection.session) return;
      if(data.type==='disconnect'){disconnect();return;}
      const isScroll=data.type==='scroll'&&Number.isFinite(data.delta)&&Math.abs(data.delta)<=4096;
      const isJump=data.type==='jump'&&['top','bottom'].includes(data.edge);
      if(!isScroll&&!isJump) return;
      const state=metrics();
      if(!state||state.blocked) return;
      getTarget().scrollTop=isJump?(data.edge==='top'?0:state.max):Math.max(0,Math.min(state.max,state.top+data.delta));
      schedule();
    }
    view.addEventListener('message',receive);
    view.addEventListener('pagehide',disconnect);
    return {destroy(){disconnect();view.removeEventListener('message',receive);view.removeEventListener('pagehide',disconnect);}};
  }
  return {createReceiver,allowedParent};
});
