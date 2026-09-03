(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.ContentSource=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const OFFICIAL_BASE='https://html.xingnian.net.cn/';
  const LOCAL_HOSTS=new Set(['127.0.0.1','localhost']);

  function localBase(value){
    if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')) return null;
    try{
      const parsed=new URL(value,'http://localhost');
      if(parsed.origin!=='http://localhost'||parsed.search||parsed.hash) return null;
      return parsed.pathname.endsWith('/')?parsed.pathname:parsed.pathname+'/';
    }catch(error){ return null; }
  }

  function resolve(options){
    const hostname=options&&typeof options.hostname==='string'?options.hostname:'';
    if(hostname==='html.xingnian.net.cn') return '';
    if(LOCAL_HOSTS.has(hostname)) return localBase(options.requestedBase)||OFFICIAL_BASE;
    return OFFICIAL_BASE;
  }

  return {resolve};
});
