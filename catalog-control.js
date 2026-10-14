(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.CatalogControl=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const VALID_STATES=new Set(['published','hidden','disabled']);

  function ruleState(rule){
    const state=typeof rule==='string'?rule:rule&&rule.state;
    return VALID_STATES.has(state)?state:null;
  }

  function categoryId(item){
    const path=item&&typeof item.path==='string'?item.path:'';
    return path.split('/')[0];
  }

  function stateFor(item,control){
    const config=control&&typeof control==='object'&&!Array.isArray(control)?control:{};
    const experiments=config.experiments&&typeof config.experiments==='object'?config.experiments:{};
    const categories=config.categories&&typeof config.categories==='object'?config.categories:{};
    const experimentState=ruleState(experiments[item.path]);
    if(experimentState) return experimentState;
    return ruleState(categories[categoryId(item)])||'published';
  }

  function apply(manifest,control){
    const source=Array.isArray(manifest)?manifest:[];
    const states={};
    const experiments=source.filter(item=>{
      const state=stateFor(item,control);
      states[item.path]=state;
      return state==='published';
    });
    return {experiments,states};
  }

  function stats(experiments,history){
    const visiblePaths=new Set((Array.isArray(experiments)?experiments:[]).map(item=>item.path));
    const seenPaths=new Set();
    for(const item of Array.isArray(history)?history:[]){
      if(item&&visiblePaths.has(item.path)) seenPaths.add(item.path);
    }
    const total=visiblePaths.size;
    const seen=seenPaths.size;
    return {total,seen,percent:total?Math.round(seen/total*100):0};
  }

  function initialIndex(sourceManifest,experiments,savedPath,savedIndex){
    const source=Array.isArray(sourceManifest)?sourceManifest:[];
    const visible=Array.isArray(experiments)?experiments:[];
    if(!visible.length) return -1;

    const visibleIndexes=new Map(visible.map((item,index)=>[item.path,index]));
    if(savedPath&&visibleIndexes.has(savedPath)) return visibleIndexes.get(savedPath);

    let anchor=savedPath?source.findIndex(item=>item.path===savedPath):-1;
    if(anchor<0){
      const legacyIndex=Number.isFinite(savedIndex)?Math.trunc(savedIndex):0;
      anchor=source.length?Math.min(Math.max(legacyIndex,0),source.length-1):0;
    }
    for(let index=anchor;index<source.length;index++){
      if(visibleIndexes.has(source[index].path)) return visibleIndexes.get(source[index].path);
    }
    for(let index=anchor-1;index>=0;index--){
      if(visibleIndexes.has(source[index].path)) return visibleIndexes.get(source[index].path);
    }
    return 0;
  }

  /** Map each original navigation index to its catalog representative; keep all routes. */
  function catalogIndexes(experiments){
    const source=Array.isArray(experiments)?experiments:[];
    const byPath=new Map(source.map((item,index)=>[item.path,index]));
    return source.map((item,index)=>{
      const representative=byPath.get(item.catalogAliasOf);
      if(representative===undefined||representative===index) return index;
      const primary=source[representative];
      if(primary.catalogAliasOf||primary.subject!==item.subject||primary.level!==item.level||primary.topic!==item.topic) return index;
      return representative;
    });
  }

  /** Group catalog indexes by ordered knowledge topic without reordering navigation. */
  function topicSections(experiments,indexes){
    const groups=new Map();
    for(const index of indexes){
      const item=experiments[index];
      if(!item) continue;
      const title=typeof item.topic==='string'?item.topic:'';
      if(!groups.has(title)) groups.set(title,{title,indexes:[],order:Number.isInteger(item.topicOrder)&&item.topicOrder>=0?item.topicOrder:Number.MAX_SAFE_INTEGER});
      groups.get(title).indexes.push(index);
    }
    return [...groups.values()].sort((a,b)=>a.order-b.order).map(({title,indexes})=>({title,indexes}));
  }

  /** Match every search word against names, original numbers and curated topic keywords. */
  function matchesSearch(item,query){
    const words=String(query||'').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const keywords=Array.isArray(item.keywords)?item.keywords.filter(value=>typeof value==='string'):[];
    const text=[item.title,item.topic,item.number,item.description,...keywords].filter(value=>typeof value==='string').join(' ').toLocaleLowerCase();
    return words.every(word=>text.includes(word));
  }

  /** Resolve current names for history while retaining unavailable old entries. */
  function historyTitle(item,sourceManifest){
    const current=(Array.isArray(sourceManifest)?sourceManifest:[]).find(entry=>entry.path===item.path);
    return current?current.title:item.title;
  }

  return {apply,stats,initialIndex,catalogIndexes,topicSections,matchesSearch,historyTitle};
});
