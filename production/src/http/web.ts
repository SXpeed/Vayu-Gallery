import type { Hono } from 'hono';
import { readFile,realpath } from 'node:fs/promises';
import path from 'node:path';
const types:Record<string,string>={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.woff2':'font/woff2','.ttf':'font/ttf','.svg':'image/svg+xml','.png':'image/png','.html':'text/html; charset=utf-8'};
// Only the compiled public bundle is served. API misses never receive the SPA or filesystem content.
export function installWeb(app:Hono<any>,root:string){
 const serve=async(c:any,file:string)=>{
  if(!/^(?:platform\.html|(?:assets|fonts)\/[a-zA-Z0-9_.-]+)$/.test(file))return c.notFound();
  try{const base=await realpath(root),target=await realpath(path.join(base,file));
   if(!target.startsWith(base+path.sep))return c.notFound();
   const mime=types[path.extname(target)];if(!mime)return c.notFound();
   c.header('Content-Type',mime);return c.body(new Uint8Array(await readFile(target)));
  }catch(error){if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code||''))return c.notFound();throw error;}
 };
 app.get('/',c=>serve(c,'platform.html'));
 app.get('/assets/:file',c=>serve(c,`assets/${c.req.param('file')}`));
 app.get('/fonts/:file',c=>serve(c,`fonts/${c.req.param('file')}`));
}
