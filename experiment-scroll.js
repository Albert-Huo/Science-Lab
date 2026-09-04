(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.ExperimentScroll=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const VERSION='v0.8.3';
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
    let captureWarningShown=false;
    const handlers=[];
    const activeHandlers=[];
    const dragTarget=options.dragTarget||element.ownerDocument||element;
    function listen(type,fn,settings){
      const listenerSettings=settings||(type==='wheel'?{passive:false}:undefined);
      element.addEventListener(type,fn,listenerSettings);handlers.push([type,fn,listenerSettings]);
    }
    function activeListen(type,fn,settings){
      dragTarget.addEventListener(type,fn,settings);activeHandlers.push([type,fn,settings]);
    }
    function clearActive(){
      while(activeHandlers.length){
        const [type,fn,settings]=activeHandlers.pop();
        dragTarget.removeEventListener(type,fn,settings);
      }
    }
    function cancel(){
      const previous=gesture; gesture=null; clearActive(); element.classList.remove('active');
      if(previous&&previous.input==='pointer'&&previous.captured){
        try{
          if(typeof element.hasPointerCapture!=='function'||element.hasPointerCapture(previous.id)) element.releasePointerCapture(previous.id);
        }catch(error){console.warn('内容滚动手柄释放指针捕获失败：'+error.message);}
      }
    }
    function begin(input,id,x,y,fields={}){
      gesture={input,id,x,y,lastY:y,axis:null,captured:false,...fields};
      element.classList.add('active');
      if(input==='pointer'){
        activeListen('pointermove',onPointerMove,{capture:true});
        activeListen('pointerup',onPointerUp,{capture:true});
        activeListen('pointercancel',onPointerCancel,{capture:true});
      }else{
        activeListen('touchmove',onTouchMove,{capture:true,passive:false});
        activeListen('touchend',onTouchEnd,{capture:true,passive:false});
        activeListen('touchcancel',onTouchCancel,{capture:true,passive:false});
      }
    }
    function move(x,y){
      if(!options.enabled()){cancel();return;}
      const dx=x-gesture.x,dy=y-gesture.y;
      if(!gesture.axis&&Math.max(Math.abs(dx),Math.abs(dy))>=8) gesture.axis=Math.abs(dy)>=Math.abs(dx)?'y':'x';
      if(gesture.axis==='y'){
        options.scroll(Math.max(-4096,Math.min(4096,gesture.lastY-y)));
        gesture.lastY=y;
      }
    }
    function findTouch(list,id){
      for(let i=0;i<list.length;i++) if(list[i].identifier===id) return list[i];
      return null;
    }
    function onPointerMove(event){
      if(!gesture||gesture.input!=='pointer'||event.pointerId!==gesture.id) return;
      move(event.clientX,event.clientY);event.preventDefault();
    }
    function onPointerUp(event){
      if(!gesture||gesture.input!=='pointer'||event.pointerId!==gesture.id) return;
      cancel();event.preventDefault();
    }
    function onPointerCancel(event){
      if(gesture&&gesture.input==='pointer'&&event.pointerId===gesture.id) cancel();
    }
    function onTouchMove(event){
      if(!gesture||gesture.input!=='touch') return;
      if(event.touches.length!==1){cancel();return;}
      const point=findTouch(event.touches,gesture.id);
      if(!point) return;
      move(point.clientX,point.clientY);event.preventDefault();event.stopPropagation();
    }
    function onTouchEnd(event){
      if(!gesture||gesture.input!=='touch'||!findTouch(event.changedTouches,gesture.id)) return;
      cancel();event.preventDefault();event.stopPropagation();
    }
    function onTouchCancel(event){
      if(!gesture||gesture.input!=='touch') return;
      cancel();event.stopPropagation();
    }
    listen('pointerdown',event=>{
      if(!options.enabled()||gesture||event.isPrimary===false||(event.pointerType==='mouse'&&event.button!==0)) return;
      let captured=false;
      try{element.setPointerCapture(event.pointerId);captured=true;}
      catch(error){
        if(!captureWarningShown){console.warn('内容滚动手柄无法捕获指针，已启用兼容模式：'+error.message);captureWarningShown=true;}
      }
      begin('pointer',event.pointerId,event.clientX,event.clientY,{captured,pointerType:event.pointerType});
      event.preventDefault();
    });
    listen('lostpointercapture',event=>{if(gesture&&gesture.input==='pointer'&&event.pointerId===gesture.id) cancel();});
    listen('touchstart',event=>{
      if(!options.enabled()) return;
      if(event.touches.length!==1){if(gesture&&gesture.input==='touch') cancel();return;}
      const point=event.touches[0];
      if(gesture){
        if(gesture.input!=='pointer'||gesture.pointerType!=='touch') return;
        cancel();
      }
      begin('touch',point.identifier,point.clientX,point.clientY);
      event.preventDefault();event.stopPropagation();
    },{passive:false});
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
    return {cancel,destroy(){cancel();for(const [type,fn,settings] of handlers) element.removeEventListener(type,fn,settings);}};
  }
  return {createClient,bindBand,validState,version:VERSION};
});
