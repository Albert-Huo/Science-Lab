(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.ExperimentScroll=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const CHANNEL='science-lab.scroll.v1';
  function validState(data){
    return data&&data.type==='state'&&typeof data.blocked==='boolean'&&
      ['top','max','viewport'].every(key=>Number.isFinite(data[key])&&data[key]>=0&&data[key]<=1e7)&&
      data.viewport>0&&data.top<=data.max;
  }
  function createClient(view,onState){
    let active=null,state=null;
    function notify(value){state=value;onState(value);}
    function post(type,fields={}){
      if(active) active.target.postMessage({channel:CHANNEL,session:active.session,type,...fields},active.origin);
    }
    function activate(frame){
      post('disconnect'); active=null; notify(null);
      if(!frame||!frame.contentWindow) return;
      const origin=new URL(frame.src,view.location.href).origin;
      if(origin==='null') return;
      active={target:frame.contentWindow,origin,session:view.crypto.randomUUID()};
      post('connect');
    }
    function receive(event){
      const data=event.data;
      if(!active||event.source!==active.target||event.origin!==active.origin||!data||
        data.channel!==CHANNEL||data.session!==active.session||!validState(data)) return;
      notify({top:data.top,max:data.max,viewport:data.viewport,blocked:data.blocked});
    }
    function scroll(delta){
      if(!active||!state||state.blocked||state.max<=0||!Number.isFinite(delta)||Math.abs(delta)>4096) return false;
      post('scroll',{delta}); return true;
    }
    function jump(edge){
      if(!active||!state||state.blocked||state.max<=0||!['top','bottom'].includes(edge)) return false;
      post('jump',{edge}); return true;
    }
    view.addEventListener('message',receive);
    return {activate,scroll,jump,getState:()=>state,destroy(){activate(null);view.removeEventListener('message',receive);}};
  }

  function bindBand(element,options){
    let gesture=null;
    const handlers=[];
    function listen(type,fn){element.addEventListener(type,fn,type==='wheel'?{passive:false}:undefined);handlers.push([type,fn]);}
    function cancel(){
      const previous=gesture; gesture=null; element.classList.remove('active');
      if(previous&&element.hasPointerCapture(previous.id)) element.releasePointerCapture(previous.id);
    }
    listen('pointerdown',event=>{
      if(!options.enabled()||gesture||event.isPrimary===false||(event.pointerType==='mouse'&&event.button!==0)) return;
      try{element.setPointerCapture(event.pointerId);}
      catch(error){console.warn('内容滚动带无法捕获触摸：'+error.message);return;}
      gesture={id:event.pointerId,x:event.clientX,y:event.clientY,lastY:event.clientY,axis:null};
      element.classList.add('active'); event.preventDefault();
    });
    listen('pointermove',event=>{
      if(!gesture||event.pointerId!==gesture.id) return;
      if(!options.enabled()){cancel();return;}
      const dx=event.clientX-gesture.x,dy=event.clientY-gesture.y;
      if(!gesture.axis&&Math.max(Math.abs(dx),Math.abs(dy))>=8) gesture.axis=Math.abs(dy)>=Math.abs(dx)?'y':'x';
      if(gesture.axis==='y'){
        options.scroll(Math.max(-4096,Math.min(4096,gesture.lastY-event.clientY)));
        gesture.lastY=event.clientY;
      }
      event.preventDefault();
    });
    listen('pointerup',event=>{
      if(!gesture||event.pointerId!==gesture.id) return;
      cancel();
      event.preventDefault();
    });
    listen('pointercancel',event=>{if(gesture&&event.pointerId===gesture.id) cancel();});
    listen('lostpointercapture',event=>{if(gesture&&event.pointerId===gesture.id) cancel();});
    listen('wheel',event=>{
      if(!options.enabled()) return;
      event.stopPropagation();
      // Preserve browser pinch-to-zoom without bubbling into experiment navigation.
      if(event.ctrlKey) return;
      event.preventDefault();
      const unit=event.deltaMode===1?16:event.deltaMode===2?options.state().viewport:1;
      const delta=event.deltaY*unit;
      if(Number.isFinite(delta)) options.scroll(Math.max(-4096,Math.min(4096,delta)));
    });
    listen('keydown',event=>{
      if(!options.enabled()) return;
      const state=options.state();
      const deltas={ArrowDown:60,ArrowUp:-60,PageDown:state.viewport*.8,PageUp:-state.viewport*.8};
      if(event.key==='Home'||event.key==='End') options.jump(event.key==='Home'?'top':'bottom');
      else if(Object.hasOwn(deltas,event.key)) options.scroll(Math.max(-4096,Math.min(4096,deltas[event.key])));
      else return;
      event.preventDefault();event.stopPropagation();
    });
    return {cancel,destroy(){cancel();for(const [type,fn] of handlers) element.removeEventListener(type,fn);}};
  }
  return {createClient,bindBand,validState};
});
