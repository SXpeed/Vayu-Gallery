export function httpsOrigin(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`Configure ${name} with your HTTPS origin.`); }
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.port||
    !host.includes('.')||host.startsWith('[')||/^[\d.]+$/.test(host)||/(^|\.)(localhost|local|internal|lan|invalid|test|example)$/.test(host)||
    /(^|\.)example\.(com|net|org)$/.test(host)) throw new Error(`Configure ${name} with a public HTTPS origin, without a path or credentials.`);
  return url.origin;
}

export function publicConfig(values) {
  const PUBLIC_ORIGIN=httpsOrigin(values.PUBLIC_ORIGIN,'PUBLIC_ORIGIN');
  const API_ORIGIN=httpsOrigin(values.API_ORIGIN,'API_ORIGIN');
  const STORAGE_ORIGIN=httpsOrigin(values.STORAGE_ORIGIN,'STORAGE_ORIGIN');
  if(PUBLIC_ORIGIN===API_ORIGIN)throw new Error('API_ORIGIN must be separate from the public Worker origin.');
  if(/\.(workers\.dev|pages\.dev)$/.test(new URL(PUBLIC_ORIGIN).hostname))throw new Error('PUBLIC_ORIGIN must be your own application domain for this custom-domain configuration.');
  return {PUBLIC_ORIGIN,API_ORIGIN,STORAGE_ORIGIN};
}

export function runtimeConfig(env) {
  const config=publicConfig(env);
  for(const name of ['ORIGIN_ACCESS_CLIENT_ID','ORIGIN_ACCESS_CLIENT_SECRET']) {
    if(typeof env[name]!=='string'||env[name].length<16||/[\r\n]/.test(env[name])||/REPLACE|PLACEHOLDER/.test(env[name]))throw new Error(`Configure secret ${name}.`);
  }
  if(typeof env.ASSETS?.fetch!=='function')throw new Error('The production ASSETS binding is missing.');
  return {...config,ORIGIN_ACCESS_CLIENT_ID:env.ORIGIN_ACCESS_CLIENT_ID,ORIGIN_ACCESS_CLIENT_SECRET:env.ORIGIN_ACCESS_CLIENT_SECRET};
}
