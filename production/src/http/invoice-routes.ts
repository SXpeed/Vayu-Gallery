import type { Hono,Context } from 'hono';
import { z } from 'zod';
import type { CatalogTenant } from './catalog-routes.js';
import { AppError } from '../core/errors.js';
import * as invoices from '../modules/invoices/service.js';

const id=(value:string|undefined)=>z.uuid().parse(value);
const version=(c:Context)=>z.coerce.number().int().positive().parse(c.req.header('If-Match')?.replace(/^"|"$/g,''));
const json=async(c:Context)=>{try{return await c.req.json();}catch{throw new AppError('INVALID_JSON','Supply a valid JSON body');}};
export function registerInvoiceRoutes(app:Hono<any>,{tenant}:{tenant:CatalogTenant}) {
  const base='/api/galleries/:tenant/invoices';
  app.get(`${base}/options`,async c=>c.json(await tenant(c,(sql,t)=>invoices.options(sql,t,c.req.query()))));
  app.get(base,async c=>c.json(await tenant(c,(sql,t)=>invoices.list(sql,t,c.req.query()))));
  app.post(base,async c=>{const body=await json(c);return c.json(await tenant(c,(sql,t)=>invoices.save(sql,t,null,null,body)),201);});
  app.get(`${base}/:id`,async c=>c.json(await tenant(c,(sql,t)=>invoices.detail(sql,t,id(c.req.param('id'))))));
  app.patch(`${base}/:id`,async c=>{const body=await json(c);return c.json(await tenant(c,(sql,t)=>invoices.save(sql,t,id(c.req.param('id')),version(c),body)));});
  app.post(`${base}/:id/issue`,async c=>{z.object({}).strict().parse(await json(c));return c.json(await tenant(c,(sql,t)=>invoices.issue(sql,t,id(c.req.param('id')),version(c))));});
  app.post(`${base}/:id/convert`,async c=>{z.object({}).strict().parse(await json(c));return c.json(await tenant(c,(sql,t)=>invoices.convert(sql,t,id(c.req.param('id')),version(c))));});
}
