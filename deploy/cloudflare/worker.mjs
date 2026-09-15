import {runtimeConfig} from './config.mjs';

const json=(status,code,message)=>new Response(JSON.stringify({error:{code,message}}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const safeMethods=new Set(['GET','HEAD','OPTIONS']);
const allowedMethods=new Set(['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE']);
const dynamicPath=path=>/^\/(api|auth|site)(\/|$)/.test(path)||path==='/health/ready';
const legacyPath=path=>/^\/api\/(state|action|login|register|upload|files|shared)(\/|$)/.test(path)||path==='/api/provider/login';
const assetPath=path=>/^\/(assets\/[a-zA-Z0-9_.-]+\.(js|css)|fonts\/[a-zA-Z0-9_.-]+\.woff2)$/.test(path);

function headersFor(response,storageOrigin,{dynamic=false,html=false}={}) {
  const headers=new Headers(response.headers);
  headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');
  headers.set('X-Frame-Options','DENY');headers.set('Strict-Transport-Security','max-age=31536000');
  headers.set('Permissions-Policy','camera=(self), microphone=(), geolocation=()');
  if(dynamic||html){headers.set('Cache-Control','private, no-store');headers.set('CDN-Cache-Control','no-store');headers.set('Cloudflare-CDN-Cache-Control','no-store');}
  if(html)headers.set('Content-Security-Policy',`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ${storageOrigin}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`);
  return headers;
}

async function smallJSON(response) {
  if(!response.body)return null;
  const reader=response.body.getReader(),chunks=[];let length=0;
  const timeout=setTimeout(()=>{void reader.cancel().catch(()=>{});},5000);
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>2048){await reader.cancel();return null;}chunks.push(value);}}finally{clearTimeout(timeout);reader.releaseLock();}
  const joined=new Uint8Array(length);let offset=0;for(const part of chunks){joined.set(part,offset);offset+=part.length;}
  try{return JSON.parse(new TextDecoder().decode(joined));}catch{return null;}
}

export function createEdge({fetchOrigin=fetch,log=event=>console.error(JSON.stringify(event))}={}) {
 return {async fetch(request,env){
  const url=new URL(request.url),requestId=crypto.randomUUID();
  if(!allowedMethods.has(request.method))return json(405,'METHOD_NOT_ALLOWED','This method is unavailable.');
  if(url.pathname==='/health/live'&&['GET','HEAD'].includes(request.method))return new Response(request.method==='HEAD'?null:JSON.stringify({status:'ok',service:'vayu-gallery-edge'}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  let config;try{config=runtimeConfig(env);}catch{return json(503,'HOSTING_NOT_CONFIGURED','Vayu-Gallery hosting has not been configured.');}
  if(url.origin!==config.PUBLIC_ORIGIN)return json(421,'HOST_NOT_ALLOWED','Use the configured gallery application address.');
  // These are local preview routes, never a production fallback.
  if(legacyPath(url.pathname))return json(404,'NOT_FOUND','Route unavailable.');
  if(dynamicPath(url.pathname)){
    if(url.pathname==='/health/ready'&&!['GET','HEAD'].includes(request.method))return json(405,'METHOD_NOT_ALLOWED','Readiness checks are read-only.');
    if(request.headers.has('Upgrade'))return json(426,'UPGRADE_UNAVAILABLE','This hosting entry uses HTTP requests.');
    if(!safeMethods.has(request.method)&&request.headers.get('Origin')!==config.PUBLIC_ORIGIN)return json(403,'ORIGIN','Request origin denied.');
    const headers=new Headers(request.headers);
    for(const name of [...headers.keys()])if(/^(host|forwarded|x-forwarded-.*|cf-access-.*|cf-connecting-ip|true-client-ip|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade)$/i.test(name))headers.delete(name);
    headers.set('CF-Access-Client-Id',config.ORIGIN_ACCESS_CLIENT_ID);headers.set('CF-Access-Client-Secret',config.ORIGIN_ACCESS_CLIENT_SECRET);
    headers.set('X-Forwarded-Host',url.host);headers.set('X-Forwarded-Proto','https');
    headers.set('Cache-Control','no-store');headers.set('Pragma','no-cache');
    const target=new URL(config.API_ORIGIN);target.pathname=url.pathname;target.search=url.search;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
    let upstream;
    try{
      upstream=await fetchOrigin(target,{method:url.pathname==='/health/ready'?'GET':request.method,headers,body:safeMethods.has(request.method)?undefined:request.body,duplex:'half',redirect:'manual',cache:'no-store',cf:{cacheTtlByStatus:{'100-599':-1}},signal:controller.signal});
    }catch{log({event:'edge.origin_unavailable',requestId,route:url.pathname.startsWith('/auth/')?'auth':url.pathname==='/health/ready'?'readiness':'api'});return json(503,'ORIGIN_UNAVAILABLE','The gallery service is temporarily unavailable.');}
    finally{clearTimeout(timeout);}
    if(url.pathname==='/health/ready'){
      try{
        const health=upstream.status===200?await smallJSON(upstream):null;
        const entry=await env.ASSETS.fetch(new Request(new URL('/index.html',config.PUBLIC_ORIGIN),{method:'HEAD'}));
        if(health?.status!=='ready'||entry.status!==200)return json(503,'NOT_READY','The production API or frontend is not ready.');
        return new Response(request.method==='HEAD'?null:JSON.stringify({status:'ready',service:'vayu-gallery-edge',checks:{apiDatabase:'ready',productionAssets:'ready'}}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
      }catch{return json(503,'NOT_READY','The production API or frontend is not ready.');}
    }
    const responseHeaders=headersFor(upstream,config.STORAGE_ORIGIN,{dynamic:true});
    const location=responseHeaders.get('Location');
    if(location){const redirect=new URL(location,target);if(redirect.origin===config.API_ORIGIN){redirect.protocol=url.protocol;redirect.host=url.host;responseHeaders.set('Location',redirect.href);}}
    responseHeaders.set('X-Edge-Request-ID',requestId);
    return new Response(upstream.body,{status:upstream.status,statusText:upstream.statusText,headers:responseHeaders});
  }
  if(!['GET','HEAD'].includes(request.method))return json(405,'METHOD_NOT_ALLOWED','Static pages are read-only.');
  if(url.pathname!=='/'&&url.pathname!=='/index.html'&&!assetPath(url.pathname))return json(404,'NOT_FOUND','Route unavailable.');
  const target=new URL(url);target.pathname=url.pathname==='/'?'/index.html':url.pathname;target.search='';
  try{const response=await env.ASSETS.fetch(new Request(target,{method:request.method}));return new Response(response.body,{status:response.status,statusText:response.statusText,headers:headersFor(response,config.STORAGE_ORIGIN,{html:target.pathname==='/index.html'})});}
  catch{log({event:'edge.asset_unavailable',requestId});return json(503,'ASSETS_UNAVAILABLE','The production interface is unavailable.');}
 }};
}

export default createEdge();
