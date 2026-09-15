import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createAppServer } from '../server/server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Resolve dependencies only from this standalone project.
const require = createRequire(path.join(root, 'package.json'));
try { for(const name of ['vite','@vitejs/plugin-react','react','lucide-react','jspdf'])require.resolve(name); } catch { throw new Error('Run npm install inside Vayu-Gallery before starting the app.'); }
const { createServer, build } = await import(pathToFileURL(require.resolve('vite')).href);
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
const platform=process.argv.includes('--platform');
const config = {
  root, configFile: false, envDir: false, plugins: [react()],
  resolve: { alias: [
    ...['react-dom', 'react', 'lucide-react', 'jspdf'].map(name => ({ find: name, replacement: path.dirname(require.resolve(`${name}/package.json`)) }))
  ] },
  cacheDir: path.join(root,'.local-data/vite-cache'),
  server: { middlewareMode: true, host: '127.0.0.1', hmr: { port: 4179, host: '127.0.0.1' }, fs: { allow: [root], deny: ['**/production/**','**/.local-data/**','**/server/**','**/.env*','**/.git/**'] } },
  build: { outDir: path.join(root, platform?'production/dist/web':'dist'), emptyOutDir: true, ...(platform?{rollupOptions:{input:path.join(root,'platform.html')}}:{}) }
};
if(platform){config.server={...config.server,middlewareMode:false,port:4182,strictPort:true,hmr:{port:4182,host:'127.0.0.1'},proxy:{'/api':'http://127.0.0.1:4180','/auth':'http://127.0.0.1:4180'}};config.plugins.push({name:'platform-entry',configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url==='/')req.url='/platform.html';next();});}});}
if (process.argv.includes('--build')) {
  await build(config);
} else if(platform){
  const vite=await createServer(config);await vite.listen();console.log('Production UI: http://127.0.0.1:4182 — requires the configured platform API on 4180');
} else {
  const vite = await createServer(config);
  const server = createAppServer({ root, fallback: vite.middlewares });
  server.listen(4178, '127.0.0.1', () => console.log('Vayu local preview: http://127.0.0.1:4178 — isolated sample data, no external services'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { server.close(); await vite.close(); process.exit(0); });
}

