import React, {useEffect, useMemo, useReducer, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {ArrowLeft, ArrowDown, ArrowUp, BookOpen, Check, CheckCheck, ChevronLeft, ChevronRight, Download, FileCheck2, Focus, ImagePlus, Images, LayoutGrid, LayoutTemplate, Leaf, LoaderCircle, Palette, Plus, Redo2, RotateCcw, Save, Search, ShieldCheck, SlidersHorizontal, Stamp, Type, Undo2, Upload, WandSparkles, X, ZoomIn, ZoomOut} from 'lucide-react';
import {Context, useApp, Button, Empty, FilePicker, api, uploadFile, go} from './lib.jsx';
import {ImageEditor} from './product-media.jsx';
import {normalizeDesign, templates, fonts, productImages, selectedCatalogImages, continuationLayouts, catalogPages, pageDimensions} from '../shared/catalog-design.mjs';
import {createEditorHistory, editorHistory, mergeSelection, sortSelection, exportChecks} from '../shared/catalog-editor.mjs';
import {renderCatalogPage, makePDF} from './catalog-renderer.js';
import './catalog-studio.css';

const sections = [
  {id:'products', label:'Products', icon:Images},
  {id:'templates', label:'Templates', icon:LayoutTemplate},
  {id:'layout', label:'Page & layout', icon:LayoutGrid},
  {id:'colors', label:'Colors', icon:Palette},
  {id:'type', label:'Typography', icon:Type},
  {id:'images', label:'Image tools', icon:WandSparkles},
  {id:'brand', label:'Logo & brand', icon:Leaf},
  {id:'finish', label:'Finishing', icon:Stamp},
  {id:'export', label:'Export', icon:Download},
];
const detailFields = [['showTitle','Product title'],['showArtist','Artist / brand'],['showDescription','Description'],['showPrice','Price'],['showMedium','Material / medium'],['showDimensions','Dimensions'],['showYear','Year'],['showStatus','Availability']];
const looks = [
  {name:'Editorial', note:'Warm & considered', colors:['#f7f5ed','#dfd8c7','#29392f'], design:{template:'editorial',titleFont:'Playfair Display',bodyFont:'Inter',backgroundMode:'solid',productsPerPage:1,showPrice:false,productLayout:'stacked'}},
  {name:'Lookbook', note:'Let the images lead', colors:['#ffffff','#f2f1ec','#31342e'], design:{template:'mosaic',titleFont:'Inter',bodyFont:'Inter',backgroundMode:'solid',productsPerPage:2,showPrice:false,showDescription:false,productLayout:'stacked'}},
  {name:'Midnight', note:'Bold & cinematic', colors:['#182f34','#416268','#f4efe5'], design:{template:'split',titleFont:'Playfair Display',bodyFont:'Inter',backgroundMode:'linear',productsPerPage:1,showPrice:false,productLayout:'side-by-side'}},
  {name:'Sales sheet', note:'A practical collection', colors:['#ffffff','#eff1ea','#263d2d'], design:{template:'banner',titleFont:'Inter',bodyFont:'Inter',backgroundMode:'solid',productsPerPage:4,showPrice:true,showDescription:false,cardBorder:true,productLayout:'stacked'}},
];
const formValue = c => ({title:c.title, description:c.description||'', artworkIds:[...(c.artworkIds||[])], theme:c.theme||'Ivory', design:normalizeDesign(c.design,c.theme)});
const asFilename = title => title.replace(/[^a-z0-9 -]/gi,'').trim().slice(0,60)||'Catalog';
function downloadBlob(blob, name) {
  const url=URL.createObjectURL(blob), link=document.createElement('a');
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function Field({label,children,hint}) {
  const Tag=['input','select','textarea'].includes(children?.type)?'label':'div';
  return <Tag className="cs-field" role={Tag==='div'?'group':undefined} aria-label={Tag==='div'?label:undefined}><span>{label}</span>{children}{hint&&<small>{hint}</small>}</Tag>;
}
function Toggle({label,value,onChange}) {return <label className="cs-toggle"><span>{label}</span><input type="checkbox" checked={!!value} onChange={e=>onChange(e.target.checked)}/><i aria-hidden="true"/></label>;}
function Range({label,value,onChange,min,max,step=1,suffix=''}) {
  const [typed,setTyped]=useState(String(value));useEffect(()=>setTyped(String(value)),[value]);
  const commit=()=>{const n=typed.trim()===''?value:Number(typed),next=Number.isFinite(n)?Math.max(min,Math.min(max,n)):value;setTyped(String(next));onChange(next);};
  return <div className="cs-range"><div><label htmlFor={`cs-range-${label}`}>{label}</label><span><input aria-label={`${label} value`} type="number" min={min} max={max} step={step} value={typed} onChange={e=>{setTyped(e.target.value);const n=Number(e.target.value);if(e.target.value!==''&&Number.isFinite(n)&&n>=min&&n<=max)onChange(n);}} onBlur={commit}/>{suffix&&<small>{suffix}</small>}</span></div><input id={`cs-range-${label}`} aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(+e.target.value)}/></div>;
}
function Color({label,value,onChange}) {
  const [typed,setTyped]=useState(value);useEffect(()=>setTyped(value),[value]);
  return <label className="cs-color"><span>{label}</span><span><input aria-label={`${label} picker`} type="color" value={value} onChange={e=>onChange(e.target.value)}/><input aria-label={`${label} hex`} value={typed} maxLength={7} onChange={e=>{setTyped(e.target.value);if(/^#[a-f0-9]{6}$/i.test(e.target.value))onChange(e.target.value);}} onBlur={()=>setTyped(value)}/></span></label>;
}
function Choices({label,value,options,onChange}) {
  return <div className="cs-choices"><span>{label}</span><div role="group" aria-label={label}>{options.map(([id,name])=><button type="button" key={id} className={value===id?'active':''} aria-pressed={value===id} onClick={()=>onChange(id)}>{name}</button>)}</div></div>;
}
function Card({id,title,caption,icon:Icon,keywords,search,children}) {
  const haystack=`${title} ${caption} ${keywords}`.toLowerCase();const visible=search.toLowerCase().split(/[\s/]+/).filter(Boolean).every(word=>haystack.includes(word));
  return <section className="cs-tool-card" id={`cs-${id}`} hidden={!visible} aria-label={title}><header><span><Icon size={17}/></span><div><h2>{title}</h2><p>{caption}</p></div></header><div className="cs-card-body">{children}</div></section>;
}
const pageLabel=(page,index)=>page?.kind==='cover'?'Cover':page?.kind==='continuation'?`${page.arts[0].title} · extra images ${page.continuationIndex+1}`:`Page ${index+1}`;
function ContinuationControls({art,arts,design,onDesign,onPreview}) {
  const config=design.continuations?.[art?.id]||{enabled:false,layout:'single',showTitle:true};
  const images=art?selectedCatalogImages(art,design):[],extraCount=Math.max(0,images.length-design.imagesPerProduct);
  const layout=continuationLayouts.find(item=>item.id===config.layout)||continuationLayouts[0];
  const firstExtra=catalogPages(design,arts).findIndex(p=>p.kind==='continuation'&&p.arts[0].id===art?.id);
  const update=patch=>{if(art)onDesign({continuations:{...design.continuations,[art.id]:{...config,...patch}}});};
  return <fieldset className="cs-fieldset cs-continuation" disabled={!art}>
    <div className="cs-continuation-heading"><BookOpen size={17}/><div><strong>Continue this product</strong><small>More angles, their own pages</small></div></div>
    <Toggle label="Put extra images on following pages" value={config.enabled} onChange={enabled=>update({enabled})}/>
    <p className="cs-help">{art?`Only for ${art.title}. The opening page uses the first ${design.imagesPerProduct} selected ${design.imagesPerProduct===1?'image':'images'}.`:'Select a product to arrange its image pages.'} Extra images appear before the next product.</p>
    <fieldset className="cs-fieldset" disabled={!config.enabled}>
      <div className="cs-label-divider">FOLLOWING PAGE LAYOUT</div>
      <div className="cs-continuation-layouts" role="group" aria-label="Following page layout">{continuationLayouts.map(item=><button type="button" key={item.id} aria-label={`${item.name} extra-image layout`} aria-pressed={config.layout===item.id} title={item.description} onClick={()=>update({layout:item.id})}><span className={`cs-continuation-mini ${item.id}`} aria-hidden="true">{Array.from({length:item.capacity},(_,i)=><i key={i}/>)}</span><strong>{item.name}</strong><small>Up to {item.capacity} {item.capacity===1?'image':'images'} / page</small></button>)}</div>
      <Toggle label="Show product title on following pages" value={config.showTitle} onChange={showTitle=>update({showTitle})}/>
    </fieldset>
    <div className="cs-continuation-summary" role="status">{config.enabled?(extraCount?`${extraCount} extra ${extraCount===1?'image':'images'} · ${Math.ceil(extraCount/layout.capacity)} following ${Math.ceil(extraCount/layout.capacity)===1?'page':'pages'}. This product gets its own opening page.`:'No extra images yet. Select more views or reduce Images / product under Page & layout.'):extraCount?`${extraCount} selected ${extraCount===1?'image is':'images are'} beyond the opening-page limit. Turn this on to include them.`:'Select more than one image to continue this product across pages.'}</div>
    <button className="cs-continuation-preview" disabled={firstExtra<0} onClick={()=>onPreview(firstExtra)}><Focus size={14}/>Preview extra pages</button>
  </fieldset>;
}
function ProductImageChoices({art,design,sources,active,resolveMedia,onSelect,onImages}) {
  const chosen=selectedCatalogImages(art,design);
  return <div className="cs-image-grid">{sources.map((url,i)=>{
    const position=chosen.indexOf(url),included=position>=0;
    const placement=!included?'Not selected':position<design.imagesPerProduct?'Opening page':design.continuations?.[art.id]?.enabled?'Following pages':'Not shown yet';
    return <div key={url} className={active===url?'active':''}>
      <button aria-label={`Adjust image ${i+1}`} onClick={()=>onSelect(url)}><img src={resolveMedia(url)} alt={`Product view ${i+1}`}/></button>
      <label><input type="checkbox" aria-label={`Include image ${i+1}`} checked={included} onChange={e=>onImages(e.target.checked?mergeSelection(chosen,[url],30):chosen.filter(s=>s!==url))}/><span>View {i+1}</span></label>
      <div className="cs-image-placement"><small>{placement}</small><button aria-label={`Use image ${i+1} first on opening page`} title="Use first on the opening page" disabled={position===0||!included&&chosen.length>=30} onClick={()=>onImages([url,...chosen.filter(s=>s!==url)])}><ArrowUp size={13}/></button></div>
    </div>;
  })}</div>;
}
function PageThumb({catalog,arts,index,render,active,onClick}) {
  const canvas=useRef(),host=useRef(),[visible,setVisible]=useState(false);
  useEffect(()=>{const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'100px'});if(host.current)observer.observe(host.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{if(!visible)return;let active=true;const timer=setTimeout(async()=>{try{const temp=document.createElement('canvas');await render(catalog,arts,index,temp);if(active&&canvas.current&&temp.width){canvas.current.width=90;canvas.current.height=90*temp.height/temp.width;canvas.current.getContext('2d').drawImage(temp,0,0,canvas.current.width,canvas.current.height);}}catch{/* Main preview supplies the actionable error. */}},180);return()=>{active=false;clearTimeout(timer);};},[visible,catalog,arts,index,render]);
  const page=catalogPages(catalog.design,arts)[index];
  return <button ref={host} className={`cs-page-thumb ${active?'active':''}`} aria-current={active?'page':undefined} aria-label={`Preview ${pageLabel(page,index)}`} title={pageLabel(page,index)} onClick={onClick}><span><canvas ref={canvas}/></span><small>{page?.kind==='cover'?'Cover':`Page ${index+1}`}{page?.kind==='continuation'?' · extra':''}</small></button>;
}

export function CatalogGenerator({catalog,renderVersions,renderArtwork}) {
  const app=useApp(),{state,mutate,refresh,catalogRuntime:runtime,resolveMedia=(src)=>src}=app;
  const [notice,setNotice]=useState(null);
  const toast=(message,type='success')=>setNotice({message,type});
  useEffect(()=>{if(!notice||notice.type==='error')return;const timer=setTimeout(()=>setNotice(null),4500);return()=>clearTimeout(timer);},[notice]);
  const notification=app.catalogError?{message:app.catalogError.message,type:'error'}:notice;
  const recovered=state.drafts?.find(d=>d.entity==='catalogs'&&d.entityId===catalog.id)?.data;
  const [history,dispatch]=useReducer(editorHistory,null,()=>createEditorHistory(formValue({...catalog,...recovered,design:recovered?.design||catalog.design})));
  const value=history.present,d=value.design;
  const [productSearch,setProductSearch]=useState(''),[toolSearch,setToolSearch]=useState(''),[section,setSection]=useState('templates');
  const [page,setPage]=useState(0),[zoom,setZoom]=useState('fit'),[activeArt,setActiveArt]=useState(value.artworkIds[0]||''),[activeImage,setActiveImage]=useState('');
  const [saving,setSaving]=useState(false),[generating,setGenerating]=useState(false),[progress,setProgress]=useState(''),[draftStatus,setDraftStatus]=useState(recovered?'Draft recovered':'All changes saved');
  const [previewBusy,setPreviewBusy]=useState(false),[renderError,setRenderError]=useState(''),[savedOpen,setSavedOpen]=useState(false),[editArt,setEditArt]=useState(null),[imageEdit,setImageEdit]=useState(null);
  const canvas=useRef(),latest=useRef(value),operation=useRef(false),draftTimer=useRef(),draftQueue=useRef(Promise.resolve()),mounted=useRef(true),gesture=useRef(null),styleInput=useRef(),inspector=useRef();
  latest.current=value;
  const [uploadCount,setUploadCount]=useState(0),uploads=useRef(new Set());
  const uploadState=(key,active)=>{if(active)uploads.current.add(key);else uploads.current.delete(key);setUploadCount(uploads.current.size);};
  const busy=saving||generating||uploadCount>0;
  const arts=useMemo(()=>value.artworkIds.map(id=>state.artworks.find(a=>a.id===id)).filter(Boolean),[value.artworkIds,state.artworks]);
  const pages=useMemo(()=>catalogPages(d,arts),[d,arts]),safePage=Math.min(page,Math.max(0,pages.length-1));
  const art=arts.find(a=>a.id===activeArt)||arts[0],sources=productImages(art),src=sources.includes(activeImage)?activeImage:sources[0];
  const transform=d.imageOverrides[src]||{zoom:d.imageZoom,x:d.imageX,y:d.imageY,fit:d.imageFit};
  const coverSrc=d.coverImage||arts[0]?.bannerImage||arts[0]?.image||productImages(arts[0])[0];
  const coverTransform=d.imageOverrides[coverSrc]||{zoom:d.imageZoom,x:d.imageX,y:d.imageY,fit:d.imageFit};
  const checks=exportChecks(value,state.artworks),blocked=checks.some(c=>c.severity==='error');
  const render=runtime?.renderPage||renderCatalogPage;
  const dirty=JSON.stringify(value)!==JSON.stringify(formValue(catalog));
  const productOptions=(runtime?.products||state.artworks).filter(a=>a.title.toLowerCase().includes(productSearch.toLowerCase()));
  const picker=[...arts.filter(a=>a.title.toLowerCase().includes(productSearch.toLowerCase())),...productOptions.filter(a=>!value.artworkIds.includes(a.id))];

  useEffect(()=>{mounted.current=true;const root=document.getElementById('root'),previousInert=root?.inert,overflow=document.body.style.overflow;document.body.style.overflow='hidden';if(root)root.inert=true;return()=>{mounted.current=false;document.body.style.overflow=overflow;if(root)root.inert=previousInert;};},[]);
  useEffect(()=>{
    const host=document.querySelector('.catalog-studio'),header=host.querySelector('.cs-header'),nav=host.querySelector('.cs-tool-nav');
    const measure=()=>{host.style.setProperty('--cs-header-height',`${header.getBoundingClientRect().height}px`);host.style.setProperty('--cs-nav-height',`${nav.getBoundingClientRect().height}px`);};
    const observer=new ResizeObserver(measure);observer.observe(header);observer.observe(nav);measure();return()=>observer.disconnect();
  },[]);
  const change=recipe=>{
    if(operation.current)return;
    const next=typeof recipe==='function'?recipe(latest.current):recipe;
    latest.current=next;
    dispatch({type:gesture.current?.recorded?'replace':'change',value:next});
    if(gesture.current)gesture.current.recorded=true;
  };
  const update=(key,v)=>change(old=>({...old,[key]:v}));
  const style=(key,v)=>change(old=>({...old,design:normalizeDesign({...old.design,[key]:v},old.theme)}));
  const patchStyle=patch=>change(old=>({...old,design:normalizeDesign({...old.design,...patch},old.theme)}));
  const writeDraft=data=>{
    const send=()=>runtime?runtime.saveDraft(data):api('action',{action:'draft.save',entity:'catalogs',entityId:catalog.id,data});
    const task=draftQueue.current.then(send,send);draftQueue.current=task;return task;
  };
  useEffect(()=>{
    clearTimeout(draftTimer.current);if(!dirty||busy)return;
    setDraftStatus('Saving draft…');const snapshot=value;
    draftTimer.current=setTimeout(()=>writeDraft(snapshot).then(()=>{if(mounted.current&&latest.current===snapshot)setDraftStatus('Draft saved');}).catch(()=>{if(mounted.current)setDraftStatus('Draft not saved · try Save');}),700);
    return()=>clearTimeout(draftTimer.current);
  },[value,dirty,busy]);
  useEffect(()=>{const timer=setTimeout(()=>runtime?.searchProducts(productSearch),200);return()=>clearTimeout(timer);},[productSearch]);
  useEffect(()=>{
    let active=true;setPreviewBusy(true);
    const timer=setTimeout(async()=>{try{const temp=document.createElement('canvas');await render(value,arts,safePage,temp);if(active&&canvas.current){canvas.current.width=temp.width;canvas.current.height=temp.height;canvas.current.getContext('2d').drawImage(temp,0,0);setRenderError('');}}catch(e){if(active)setRenderError(e.message);}finally{if(active)setPreviewBusy(false);}},90);
    return()=>{active=false;clearTimeout(timer);};
  },[value,arts,safePage,render]);
  useEffect(()=>{const prevent=e=>{if(dirty){e.preventDefault();e.returnValue='';}};addEventListener('beforeunload',prevent);return()=>removeEventListener('beforeunload',prevent);},[dirty]);
  const jump=id=>{
    setSection(id);setToolSearch('');
    requestAnimationFrame(()=>document.getElementById(`cs-${id}`)?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'}));
  };
  const persist=async()=>{
    clearTimeout(draftTimer.current);await draftQueue.current.catch(()=>{});
    const snapshot=latest.current;
    if(!snapshot.title.trim())throw new Error('Give your catalog a name before saving.');
    if(snapshot.artworkIds.some(id=>!state.artworks.some(a=>a.id===id)))throw new Error('An artwork is unavailable. Remove it from the selection before saving.');
    const selectedImages=Object.fromEntries(Object.entries(snapshot.design.selectedImages).filter(([id])=>snapshot.artworkIds.includes(id)).map(([id,images])=>[id,images.filter(s=>productImages(state.artworks.find(a=>a.id===id)).includes(s))]));
    const continuations=Object.fromEntries(Object.entries(snapshot.design.continuations||{}).filter(([id])=>snapshot.artworkIds.includes(id)));
    const result=await mutate({action:'save',entity:'catalogs',entityId:catalog.id,data:{...snapshot,design:{...snapshot.design,selectedImages,continuations}}},'Catalog design saved');
    if(!result)throw new Error('Catalog could not be saved. Please check your access and try again.');
    if(!runtime)await api('action',{action:'draft.delete',entity:'catalogs',entityId:catalog.id});
    const saved=formValue(result);latest.current=saved;dispatch({type:'change',value:saved});setDraftStatus('All changes saved');return result;
  };
  const save=async()=>{
    if(operation.current||uploads.current.size)return;operation.current=true;setSaving(true);
    try{if(await persist())toast('Catalog design saved');}catch(e){toast(e.message,'error');}finally{operation.current=false;if(mounted.current)setSaving(false);}
  };
  const generate=async()=>{
    if(operation.current)return;
    if(blocked){jump('export');return;}
    operation.current=true;setGenerating(true);setProgress('Saving your design…');
    try{const saved=await persist();if(!saved)return;
      if(runtime)await runtime.generate(saved,setProgress);
      else{const file=await makePDF(saved,arts,(n,total)=>setProgress(`Rendering page ${n} of ${total}`));setProgress('Saving PDF to Library…');const f=await uploadFile(file);if(!await mutate({action:'catalog.version',entityId:catalog.id,data:{fileId:f.id,generated:true}},'PDF saved to Library'))return;await refresh();}
      if(mounted.current){setSavedOpen(true);setDraftStatus('PDF saved to Library');}
    }catch(e){toast(e.message,'error');}finally{operation.current=false;if(mounted.current){setGenerating(false);setProgress('');}}
  };
  const leave=async()=>{
    if(operation.current||uploads.current.size)return;operation.current=true;setSaving(true);clearTimeout(draftTimer.current);
    try{await draftQueue.current.catch(()=>{});if(dirty)await writeDraft(latest.current);if(runtime)runtime.back();else go('catalogs');}
    catch(e){toast(e.message,'error');}finally{operation.current=false;if(mounted.current)setSaving(false);}
  };
  useEffect(()=>{
    const key=e=>{if(document.querySelector('[role="dialog"]')||operation.current||uploads.current.size)return;const modifier=e.ctrlKey||e.metaKey;if(!modifier)return;
      if(e.key.toLowerCase()==='s'){e.preventDefault();e.stopImmediatePropagation();void save();}
      if(e.key.toLowerCase()==='z'&&!/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)&&!e.target.isContentEditable){e.preventDefault();e.stopImmediatePropagation();dispatch({type:e.shiftKey?'redo':'undo'});}
    };addEventListener('keydown',key,true);return()=>removeEventListener('keydown',key,true);
  });
  const move=(id,amount)=>{const next=[...value.artworkIds],index=next.indexOf(id),target=index+amount;if(target<0||target>=next.length)return;[next[index],next[target]]=[next[target],next[index]];update('artworkIds',next);};
  const setTransform=(key,v)=>style('imageOverrides',{...d.imageOverrides,[src]:{...transform,[key]:v}});
  const setCoverTransform=(key,v)=>style('imageOverrides',{...d.imageOverrides,[coverSrc]:{...coverTransform,[key]:v}});
  const applyLook=look=>patchStyle({...look.design,background:look.colors[0],background2:look.colors[1],titleColor:look.colors[2],textColor:look.colors[2],priceColor:look.colors[2]});
  const exportStyle=()=>{
    const design={...d,logo:'',coverImage:'',selectedImages:{},imageOverrides:{},continuations:{}};
    downloadBlob(new Blob([JSON.stringify({format:'vayu-catalog-style',version:1,design},null,2)],{type:'application/json'}),`${asFilename(value.title)}-style.json`);
  };
  const importStyle=async file=>{try{if(file.size>65536)throw new Error('Choose a style file smaller than 64 KB.');const parsed=JSON.parse(await file.text());if(parsed.format!=='vayu-catalog-style'||parsed.version!==1||!parsed.design||typeof parsed.design!=='object'||Array.isArray(parsed.design))throw new Error('Choose a Vayu catalog style file.');const {logo,coverImage,selectedImages,imageOverrides,continuations,...portable}=parsed.design;patchStyle(portable);toast('Style applied. Your products and uploaded images are unchanged.');}catch(e){toast(e.message,'error');}};
  const exportPNG=async()=>{if(previewBusy||renderError||!pages.length)return;const blob=await new Promise(resolve=>canvas.current.toBlob(resolve,'image/png'));if(blob)downloadBlob(blob,`${asFilename(value.title)}-page-${safePage+1}.png`);};
  const pageStart=Math.max(0,Math.min(safePage-3,pages.length-8)),visiblePages=pages.slice(pageStart,pageStart+8);
  const cardProps={search:toolSearch};

  return createPortal(<Context.Provider value={{...app,toast}}><div className="catalog-studio" aria-label="Catalog generator" onPointerDownCapture={e=>{if(e.target.type==='range')gesture.current={recorded:false};}} onPointerUpCapture={()=>{gesture.current=null;}} onPointerCancelCapture={()=>{gesture.current=null;}}>
    {notification&&<div className={`cs-notice ${notification.type}`} role={notification.type==='error'?'alert':'status'}><span>{notification.message}{app.catalogError?.status===401&&<a href="/auth/login">Sign in again</a>}{app.catalogError?.requestId&&<small>Support reference: {app.catalogError.requestId}</small>}</span><button aria-label="Dismiss notification" onClick={()=>{setNotice(null);app.clearCatalogError?.();}}><X size={17}/></button></div>}
    <header className="cs-header">
      <button className="cs-back" aria-label="Back to Catalog" disabled={busy} onClick={leave}><ArrowLeft size={18}/></button>
      <div className="cs-identity"><span>VAYU <i>/</i> CATALOG STUDIO</span><h1>{value.title||'Untitled catalog'}</h1></div>
      <div className="cs-save-state" role="status">{busy||previewBusy?<LoaderCircle size={13} className="spin"/>:<Check size={13}/>}<span>{uploadCount?'Uploading image…':progress||draftStatus}</span></div>
      <div className="cs-header-actions"><div className="cs-history"><button title="Undo (Ctrl/⌘ Z)" aria-label="Undo change" disabled={!history.past.length||busy} onClick={()=>dispatch({type:'undo'})}><Undo2 size={17}/></button><button title="Redo (Ctrl/⌘ Shift Z)" aria-label="Redo change" disabled={!history.future.length||busy} onClick={()=>dispatch({type:'redo'})}><Redo2 size={17}/></button></div><Button variant="ghost" disabled={busy} icon={BookOpen} onClick={()=>setSavedOpen(true)}>Versions <span className="cs-count">{catalog.versions.length}</span></Button><Button variant="secondary" icon={Save} busy={saving} disabled={generating||uploadCount>0} onClick={save}>Save</Button><Button icon={Download} busy={generating} disabled={saving||uploadCount>0} onClick={generate}>Generate PDF</Button></div>
    </header>
    <nav className="cs-tool-nav" aria-label="All catalog tools">{sections.map(({id,label,icon:Icon})=><button key={id} className={section===id?'active':''} aria-current={section===id?'location':undefined} onClick={()=>jump(id)}><Icon size={17}/><span>{label}</span></button>)}</nav>
    <div className="cs-workspace">
      <aside className="cs-products" id="cs-products" aria-label="Product selection">
        <div className="cs-pane-heading"><div><span className="cs-eyebrow">YOUR COLLECTION</span><h2>Products <span>{value.artworkIds.length}</span></h2></div><Images size={20}/></div>
        <fieldset disabled={busy} className="cs-fieldset">
          <Field label="Catalog name"><input value={value.title} maxLength={200} onChange={e=>update('title',e.target.value)} placeholder="Name your collection"/></Field>
          <label className="cs-search"><Search size={15}/><input aria-label="Find a product" value={productSearch} placeholder="Find a product…" onChange={e=>setProductSearch(e.target.value)}/>{productSearch&&<button aria-label="Clear product search" onClick={()=>setProductSearch('')}><X size={13}/></button>}</label>
          <div className="cs-selection-actions"><button onClick={()=>update('artworkIds',mergeSelection(value.artworkIds,productOptions.map(a=>a.id)))}><Plus size={13}/>Add results</button><button disabled={!value.artworkIds.length} onClick={()=>update('artworkIds',[])}>Clear selection</button></div>
          <Field label="Arrange selected products"><select value="" disabled={value.artworkIds.length<2} onChange={e=>{update('artworkIds',sortSelection(value.artworkIds,state.artworks,e.target.value));}}><option value="">Custom order</option><option value="title-asc">Title · A to Z</option><option value="title-desc">Title · Z to A</option><option value="reverse">Reverse order</option></select></Field>
          <div className="cs-product-list">{picker.map(a=>{const index=value.artworkIds.indexOf(a.id),selected=index>=0;return <article key={a.id} className={selected?'selected':''}><label><input type="checkbox" aria-label={`Include ${a.title}`} checked={selected} disabled={!selected&&value.artworkIds.length>=100} onChange={e=>update('artworkIds',e.target.checked?mergeSelection(value.artworkIds,[a.id]):value.artworkIds.filter(id=>id!==a.id))}/><span className="cs-product-image">{a.image?<img src={resolveMedia(a.image)} alt=""/>:<Images size={20}/>}</span><span className="cs-product-name">{a.title}<small>{productImages(a).length} {productImages(a).length===1?'image':'images'}{a.artist?` · ${a.artist}`:''}</small></span></label>{selected&&<div className="cs-product-actions"><span>{String(index+1).padStart(2,'0')}</span><button aria-label={`Move ${a.title} earlier`} disabled={index===0} onClick={()=>move(a.id,-1)}><ArrowUp size={12}/></button><button aria-label={`Move ${a.title} later`} disabled={index===value.artworkIds.length-1} onClick={()=>move(a.id,1)}><ArrowDown size={12}/></button><button title="Adjust product images" aria-label={`Adjust images for ${a.title}`} onClick={()=>{setActiveArt(a.id);setActiveImage('');jump('images');}}><SlidersHorizontal size={13}/></button></div>}</article>;})}</div>
          {value.artworkIds.filter(id=>!state.artworks.some(a=>a.id===id)).map(id=><div className="cs-missing" key={id}><span>Unavailable product</span><button onClick={()=>update('artworkIds',value.artworkIds.filter(x=>x!==id))}>Remove</button></div>)}
          {!picker.length&&<p className="cs-help">{productSearch?'No matching products. Your existing selection is kept.':'Add artwork to your inventory to start a catalog.'}</p>}
          {runtime?.hasMore&&<Button variant="secondary" onClick={runtime.loadMore}>Load more products</Button>}
        </fieldset>
        <div className="cs-selection-note"><CheckCheck size={15}/><span>Your selection and page order stay together.<small>Up to 100 products per catalog.</small></span></div>
      </aside>

      <section className="cs-canvas-panel" aria-label="Catalog page preview" id="cs-preview">
        <div className="cs-canvas-toolbar"><span><span className="cs-live-dot"/>Live preview</span><div><button aria-label="Zoom out" disabled={zoom!== 'fit'&&zoom<=50} onClick={()=>setZoom(Math.max(50,(zoom==='fit'?100:zoom)-25))}><ZoomOut size={16}/></button><select aria-label="Preview zoom" value={zoom} onChange={e=>setZoom(e.target.value==='fit'?'fit':+e.target.value)}><option value="fit">Fit page</option>{[50,75,100,125,150].map(n=><option key={n} value={n}>{n}%</option>)}</select><button aria-label="Zoom in" disabled={zoom>=150} onClick={()=>setZoom(Math.min(150,(zoom==='fit'?75:zoom)+25))}><ZoomIn size={16}/></button><button aria-label="Fit page to preview" onClick={()=>setZoom('fit')}><Focus size={16}/></button></div></div>
        <div className={`cs-paper-stage ${zoom==='fit'?'fit':'zoomed'}`}><div className="cs-paper-wrap" style={zoom==='fit'?{aspectRatio:pageDimensions(d).join('/')}:{width:`${pageDimensions(d)[0]*zoom/200}px`,aspectRatio:pageDimensions(d).join('/')}}>{pages.length?<canvas ref={canvas} aria-label={`Catalog preview: ${pageLabel(pages[safePage],safePage)}`}/>:<div className="cs-blank-page"><BookOpen size={40} strokeWidth={1}/><h3>A new story starts here.</h3><p>Select products or enable a cover page.</p></div>}</div>{previewBusy&&<span className="cs-rendering"><LoaderCircle size={13} className="spin"/>Updating preview</span>}</div>
        {renderError&&<div className="cs-preview-error" role="alert">{renderError}</div>}
        <div className="cs-page-navigation"><button aria-label="Previous catalog page" disabled={!safePage} onClick={()=>setPage(safePage-1)}><ChevronLeft size={17}/></button><select aria-label="Preview page" value={safePage} onChange={e=>setPage(+e.target.value)}>{pages.map((p,i)=><option key={i} value={i}>{pageLabel(p,i)} · {i+1} of {pages.length}</option>)}</select><button aria-label="Next catalog page" disabled={safePage>=pages.length-1} onClick={()=>setPage(safePage+1)}><ChevronRight size={17}/></button><span>{d.format==='square'?'210 × 210 mm':d.format==='landscape'?'A4 · landscape':'A4 · portrait'}</span></div>
        <div className="cs-filmstrip" aria-label="Page navigator">{pageStart>0&&<button className="cs-more-pages" onClick={()=>setPage(Math.max(0,pageStart-4))} aria-label="Earlier page thumbnails"><ChevronLeft size={18}/></button>}{visiblePages.map((p,i)=><PageThumb key={`${p.kind}-${pageStart+i}`} catalog={value} arts={arts} index={pageStart+i} render={render} active={safePage===pageStart+i} onClick={()=>setPage(pageStart+i)}/>)}{pageStart+8<pages.length&&<button className="cs-more-pages" onClick={()=>setPage(pageStart+8)} aria-label="Later page thumbnails"><ChevronRight size={18}/></button>}</div>
        <div className="cs-canvas-caption"><Leaf size={13}/><span>Made by you. Beautifully presented.</span></div>
      </section>

      <aside ref={inspector} className="cs-inspector" aria-label="All design settings">
        <div className="cs-inspector-search"><Search size={15}/><input aria-label="Find a design tool" placeholder="Find a tool, e.g. logo or gradient" value={toolSearch} onChange={e=>setToolSearch(e.target.value)}/>{toolSearch&&<button aria-label="Show all design tools" onClick={()=>setToolSearch('')}><X size={15}/></button>}</div>
        <fieldset className="cs-fieldset" disabled={busy}>
          <Card {...cardProps} id="templates" title="Templates & looks" caption="A starting point for your story" icon={LayoutTemplate} keywords="cover theme style presets import export introduction">
            <div className="cs-look-grid">{looks.map(look=><button key={look.name} onClick={()=>applyLook(look)}><span style={{background:look.colors[0],color:look.colors[2]}}><i style={{background:look.colors[1]}}/><b>Aa</b></span><strong>{look.name}</strong><small>{look.note}</small></button>)}</div>
            <Field label="Cover composition"><div className="cs-template-grid">{templates.map(t=><button key={t.id} className={d.template===t.id?'active':''} aria-pressed={d.template===t.id} title={t.description} onClick={()=>{style('template',t.id);setPage(0);}}><span className={`template-mini template-${t.id}`}><i/><b/><em/></span><span>{t.name}</span></button>)}</div></Field>
            <Toggle label="Include cover page" value={d.includeCover} onChange={v=>{style('includeCover',v);setPage(0);}}/>
            <div className="cs-button-pair"><button onClick={exportStyle}><Download size={14}/>Save style</button><button onClick={()=>styleInput.current.click()}><Upload size={14}/>Load style</button><input ref={styleInput} hidden type="file" accept="application/json,.json" aria-label="Import catalog style" onChange={e=>{if(e.target.files[0])void importStyle(e.target.files[0]);e.target.value='';}}/></div>
            <p className="cs-help">Styles keep layout and typography. Your products and uploaded images stay in place.</p>
          </Card>
          <Card {...cardProps} id="layout" title="Page & product layout" caption="Set the rhythm of each page" icon={LayoutGrid} keywords="format square portrait landscape grid products density cards radius border margins gap spacing images per page product composition">
            <Choices label="Page format" value={d.format} options={[['portrait','Portrait'],['landscape','Landscape'],['square','Square']]} onChange={v=>style('format',v)}/>
            <div className="cs-two-fields"><Field label="Products / page"><select value={d.productsPerPage} onChange={e=>style('productsPerPage',+e.target.value)}>{[1,2,3,4,5,6].map(n=><option key={n}>{n}</option>)}</select></Field><Field label="Images / product"><select value={d.imagesPerProduct} onChange={e=>style('imagesPerProduct',+e.target.value)}>{[1,2,3,4,5,6].map(n=><option key={n}>{n}</option>)}</select></Field></div>
            <Choices label="Product composition" value={d.productLayout} options={[['auto','Classic'],['stacked','Stacked'],['side-by-side','Side by side']]} onChange={v=>style('productLayout',v)}/>
            <Range label="Page margins" value={d.margin} min={20} max={80} onChange={v=>style('margin',v)}/>
            <Range label="Product spacing" value={d.gap} min={6} max={40} onChange={v=>style('gap',v)}/>
            <Toggle label="Card background" value={d.cardBackground} onChange={v=>style('cardBackground',v)}/><Toggle label="Card border" value={d.cardBorder} onChange={v=>style('cardBorder',v)}/>
            <Range label="Card corner radius" value={d.cardRadius} min={0} max={32} onChange={v=>style('cardRadius',v)}/>
          </Card>
          <Card {...cardProps} id="colors" title="Colors & backgrounds" caption="Find your collection’s palette" icon={Palette} keywords="solid linear radial gradient angle background text price title color hex">
            <Choices label="Background style" value={d.backgroundMode} options={[['solid','Solid'],['linear','Linear'],['radial','Radial']]} onChange={v=>style('backgroundMode',v)}/>
            <Color label="Background" value={d.background} onChange={v=>style('background',v)}/><Color label="Second / card color" value={d.background2} onChange={v=>style('background2',v)}/>
            <Range label="Gradient angle" value={d.gradientAngle} min={0} max={360} suffix="°" onChange={v=>style('gradientAngle',v)}/>
            <div className="cs-palette-row">{[['Linen','#f7f5ed','#d9c6a5'],['Ocean','#172c3d','#466c70'],['Clay','#efd9ce','#b87859'],['Sage','#eef1e5','#a7bda5'],['Mono','#ffffff','#dce1e4']].map(([name,a,b])=><button aria-label={`${name} gradient`} title={name} key={name} style={{background:`linear-gradient(135deg,${a},${b})`}} onClick={()=>patchStyle({backgroundMode:'linear',background:a,background2:b,titleColor:name==='Ocean'?'#ffffff':'#29392f',textColor:name==='Ocean'?'#e6eeed':'#465448',priceColor:name==='Ocean'?'#ffffff':'#29392f'})}/>)}</div>
            <Color label="Titles" value={d.titleColor} onChange={v=>style('titleColor',v)}/><Color label="Body text" value={d.textColor} onChange={v=>style('textColor',v)}/><Color label="Prices" value={d.priceColor} onChange={v=>style('priceColor',v)}/>
          </Card>
          <Card {...cardProps} id="type" title="Typography & details" caption="Show exactly what matters" icon={Type} keywords="font text type size title price description medium year dimensions artist availability visible hide fields information">
            <div className="cs-font-sample" style={{fontFamily:d.titleFont}}>The art of a good story.<span style={{fontFamily:d.bodyFont}}>Considered details, beautifully composed.</span></div>
            <Field label="Title font"><select value={d.titleFont} onChange={e=>style('titleFont',e.target.value)}>{fonts.map(f=><option key={f}>{f}</option>)}</select></Field><Range label="Title size" value={d.titleSize} min={16} max={48} onChange={v=>style('titleSize',v)}/><Toggle label="Bold titles" value={d.titleBold} onChange={v=>style('titleBold',v)}/>
            <Field label="Description & details font"><select value={d.bodyFont} onChange={e=>style('bodyFont',e.target.value)}>{fonts.map(f=><option key={f}>{f}</option>)}</select></Field><Range label="Body size" value={d.bodySize} min={9} max={20} onChange={v=>style('bodySize',v)}/>
            <Choices label="Text alignment" value={d.textAlign} options={[['left','Left'],['center','Center'],['right','Right']]} onChange={v=>style('textAlign',v)}/>
            <div className="cs-label-divider">VISIBLE PRODUCT DETAILS</div><div className="cs-button-pair"><button onClick={()=>patchStyle(Object.fromEntries(detailFields.map(([key])=>[key,false])))}>Images only</button><button onClick={()=>patchStyle(Object.fromEntries(detailFields.map(([key])=>[key,key==='showTitle'])))}>Image + title</button><button onClick={()=>patchStyle(Object.fromEntries(detailFields.map(([key])=>[key,true])))}>All details</button></div>
            <div className="cs-visibility-grid">{detailFields.map(([key,label])=><label key={key}><input type="checkbox" checked={d[key]} onChange={e=>style(key,e.target.checked)}/><span>{label}</span></label>)}</div>
            <Field label="Cover introduction"><textarea value={value.description} rows={3} maxLength={20000} placeholder="Introduce this collection…" onChange={e=>update('description',e.target.value)}/></Field><Toggle label="Show cover title" value={d.coverTitle} onChange={v=>style('coverTitle',v)}/><Toggle label="Show introduction" value={d.coverDescription} onChange={v=>style('coverDescription',v)}/>
          </Card>
          <Card {...cardProps} id="images" title="Image tools" caption="Every angle, exactly as you want it" icon={WandSparkles} keywords="photo gallery camera background removal cutout shadow fit crop zoom x y position ratio image gap banner cover continuation next following pages extra multiple single product layout grid collage">
            <Field label="Selected product"><select value={art?.id||''} onChange={e=>{setActiveArt(e.target.value);setActiveImage('');}}>{!arts.length&&<option value="">Select a product first</option>}{arts.map(a=><option key={a.id} value={a.id}>{a.title}</option>)}</select></Field>
            <ContinuationControls art={art} arts={arts} design={d} onDesign={patchStyle} onPreview={index=>{setPage(index);jump('preview');}}/>
            {sources.length>0?<ProductImageChoices art={art} design={d} sources={sources} active={src} resolveMedia={resolveMedia} onSelect={setActiveImage} onImages={images=>style('selectedImages',{...d.selectedImages,[art.id]:images})}/>:<div className="cs-image-empty"><ImagePlus size={25}/><p>{art?'This product has no images yet.':'Choose a product to adjust its images.'}</p></div>}
            <div className="cs-button-pair"><button disabled={!art} onClick={()=>setEditArt(art)}><Upload size={14}/>Manage images</button><button disabled={!src} onClick={()=>setImageEdit({src,art})}><WandSparkles size={14}/>Remove background</button></div>
            <Choices label="Image frame ratio" value={d.imageRatio} options={[['auto','Auto'],['square','1:1'],['portrait','3:4'],['landscape','4:3']]} onChange={v=>style('imageRatio',v)}/>
            <Range label="Image spacing" value={d.imageGap} min={0} max={32} onChange={v=>style('imageGap',v)}/><Toggle label="Soft image shadows" value={d.imageShadow} onChange={v=>style('imageShadow',v)}/>
            <fieldset className="cs-fieldset cs-image-adjustments" disabled={!src}><Choices label="Image fit" value={transform.fit} options={[['contain','Fit entire image'],['cover','Fill / crop']]} onChange={v=>setTransform('fit',v)}/><Range label="Image zoom" value={transform.zoom} min={.5} max={3} step={.1} suffix="×" onChange={v=>setTransform('zoom',v)}/><Range label="Horizontal position" value={transform.x} min={0} max={100} suffix="%" onChange={v=>setTransform('x',v)}/><Range label="Vertical position" value={transform.y} min={0} max={100} suffix="%" onChange={v=>setTransform('y',v)}/><div className="cs-button-pair"><button onClick={()=>style('imageOverrides',{...d.imageOverrides,[src]:{zoom:1,x:50,y:50,fit:'contain'}})}><RotateCcw size={13}/>Reset crop</button><button onClick={()=>style('imageOverrides',{...d.imageOverrides,...Object.fromEntries(arts.flatMap(productImages).map(s=>[s,{...transform}]))})}>Apply to all images</button></div></fieldset>
            <div className="cs-label-divider">COVER / BANNER IMAGE</div><Field label="Cover image"><select value={d.coverImage} onChange={e=>style('coverImage',e.target.value)}><option value="">First product’s banner</option>{[...new Set(arts.flatMap(productImages))].map((url,i)=><option key={url} value={url}>Image {i+1} · {arts.find(a=>productImages(a).includes(url))?.title}</option>)}{d.coverImage&&!arts.flatMap(productImages).includes(d.coverImage)&&<option value={d.coverImage}>Uploaded cover</option>}</select></Field><FilePicker onBusyChange={active=>uploadState('cover',active)} label="Upload cover image" onUpload={f=>style('coverImage',`/api/files/${f.id}`)}/>
            <fieldset className="cs-fieldset" disabled={!coverSrc}><Choices label="Cover image fit" value={coverTransform.fit} options={[['contain','Fit'],['cover','Fill / crop']]} onChange={v=>setCoverTransform('fit',v)}/><Range label="Cover zoom" value={coverTransform.zoom} min={.5} max={3} step={.1} suffix="×" onChange={v=>setCoverTransform('zoom',v)}/><Range label="Cover horizontal position" value={coverTransform.x} min={0} max={100} suffix="%" onChange={v=>setCoverTransform('x',v)}/><Range label="Cover vertical position" value={coverTransform.y} min={0} max={100} suffix="%" onChange={v=>setCoverTransform('y',v)}/></fieldset>
          </Card>
          <Card {...cardProps} id="brand" title="Logo & brand" caption="Make every page unmistakably yours" icon={Leaf} keywords="logo placement size presets position brand name top bottom center left right">
            <div className="cs-logo-preview">{d.logo?<img src={resolveMedia(d.logo)} alt="Catalog logo"/>:<span style={{fontFamily:d.titleFont}}>{d.brandText||'Your logo here'}</span>}</div><div className="cs-button-pair"><FilePicker onBusyChange={active=>uploadState('logo',active)} label="Upload logo" onUpload={f=>style('logo',`/api/files/${f.id}`)}/><button disabled={!d.logo} onClick={()=>style('logo','')}>Remove</button></div>
            <Field label="Brand name"><input value={d.brandText} maxLength={150} onChange={e=>style('brandText',e.target.value)}/></Field>
            <Range label="Logo size" value={d.logoSize} min={6} max={35} suffix="%" onChange={v=>style('logoSize',v)}/><Choices label="Logo size presets" value={d.logoSize} options={[[10,'Small'],[16,'Medium'],[26,'Large']]} onChange={v=>style('logoSize',v)}/>
            <Field label="Logo placement"><div className="cs-logo-placement" role="group" aria-label="Logo placement">{['top-left','top-center','top-right','bottom-left','bottom-center','bottom-right'].map(p=><button key={p} className={d.logoPosition===p?'active':''} aria-label={`Logo ${p.replace('-',' ')}`} aria-pressed={d.logoPosition===p} onClick={()=>style('logoPosition',p)}><i style={{justifySelf:p.endsWith('left')?'start':p.endsWith('right')?'end':'center',alignSelf:p.startsWith('top')?'start':'end'}}/></button>)}</div></Field><Toggle label="Show logo / brand" value={d.logoPosition!=='none'} onChange={v=>style('logoPosition',v?'bottom-center':'none')}/><p className="cs-help">The logo keeps its proportions. Size is relative to the shorter edge of the page.</p>
          </Card>
          <Card {...cardProps} id="finish" title="Footer & watermark" caption="The final layer of detail" icon={Stamp} keywords="footer text page numbers watermark opacity transparent confidential finishing">
            <Field label="Footer text"><input value={d.footerText} maxLength={150} onChange={e=>style('footerText',e.target.value)}/></Field><Toggle label="Show footer" value={d.showFooter} onChange={v=>style('showFooter',v)}/><Toggle label="Page numbers" value={d.showPageNumbers} onChange={v=>style('showPageNumbers',v)}/>
            <Field label="Watermark text" hint="Leave empty for no watermark."><input value={d.watermarkText} maxLength={100} placeholder="e.g. PRIVATE COLLECTION" onChange={e=>style('watermarkText',e.target.value)}/></Field><Range label="Watermark opacity" value={Math.round(d.watermarkOpacity*100)} min={3} max={25} suffix="%" onChange={v=>style('watermarkOpacity',v/100)}/>
          </Card>
          <Card {...cardProps} id="export" title="Review & export" caption="Ready for its next chapter" icon={FileCheck2} keywords="PDF download save generate PNG page export review warning checklist check versions">
            <div className="cs-export-summary"><div><strong>{arts.length}</strong><span>products</span></div><div><strong>{pages.length}</strong><span>pages</span></div><div><strong>{d.format==='square'?'1:1':'A4'}</strong><span>format</span></div></div>
            <div className="cs-checks" role="status">{checks.length?checks.map((c,i)=><p className={c.severity} key={i}><span>{c.severity==='error'?'!':'·'}</span>{c.message}</p>):<p className="success"><Check size={15}/>Your catalog is ready to generate.</p>}</div>
            <Button icon={Download} busy={generating} disabled={blocked} onClick={generate}>Generate & save PDF</Button><Button variant="secondary" disabled={previewBusy||!!renderError||!pages.length} onClick={exportPNG}>Download current page as PNG</Button>
            <p className="cs-help">PDF editions are saved to Library. PNG downloads the page currently in your preview.</p><div className="cs-export-note"><ShieldCheck size={15}/><span>Every saved PDF keeps its own edition.</span></div>
          </Card>
        </fieldset>
        {toolSearch&&<p className="cs-help cs-no-tools">No matching tool. <button onClick={()=>setToolSearch('')}>Show all tools</button></p>}
      </aside>
    </div>
    <footer className="cs-statusbar"><span><span className="cs-live-dot"/>{value.artworkIds.length} products <i>·</i> {pages.length} pages <i>·</i> {d.format}</span><span className="cs-shortcut">All tools, one workspace.<small>Ctrl / ⌘ S to save</small></span><button className="cs-return-preview" onClick={()=>jump('preview')}><Focus size={15}/>Preview</button></footer>
    {savedOpen&&(runtime?runtime.versions(catalog,()=>setSavedOpen(false)):renderVersions(catalog,()=>setSavedOpen(false)))}
    {editArt&&(runtime?runtime.editArtwork(editArt,()=>setEditArt(null)):renderArtwork(editArt,()=>setEditArt(null)))}
    {imageEdit&&<ImageEditor src={imageEdit.src} onClose={()=>setImageEdit(null)} onSaved={async url=>{const current=state.artworks.find(a=>a.id===imageEdit.art.id);if(!current){toast('This product is no longer available.','error');return false;}const images=productImages(current);if(images.length>=30){toast('Remove a product image before adding another.','error');return false;}const saved=await mutate({action:'save',entity:'artworks',entityId:current.id,data:{images:[...images,url]}},'Edited image added to product');if(!saved)return false;style('selectedImages',{...d.selectedImages,[current.id]:(d.selectedImages[current.id]||images).map(s=>s===imageEdit.src?url:s)});setActiveImage(url);setImageEdit(null);return true;}}/>}
  </div></Context.Provider>,document.body);
}
