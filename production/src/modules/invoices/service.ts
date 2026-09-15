import { z } from 'zod';
import type { SQL } from '../../core/database.js';
import { AppError, requireValue } from '../../core/errors.js';
import { entitlement } from '../gallery/service.js';

export const gstin = z.string().trim().toUpperCase().refine(value => value === '' || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value), 'Use a 15-character GSTIN, or leave it empty').default('');
const minor = z.number().int().min(0).max(1_000_000_000_000);
const item = z.object({
  id: z.uuid().optional(), artworkId: z.uuid().nullable().default(null),
  description: z.string().trim().min(1).max(2000), quantity: z.number().int().min(1).max(10000),
  unitPriceMinor: minor, taxRateBps: z.number().int().min(0).max(10000).default(0)
}).strict();
const dueAt = z.union([z.iso.datetime({offset:true}),z.iso.date().transform(value => `${value}T00:00:00.000Z`)]).nullable().default(null);
export const draftInput = z.object({
  documentType: z.enum(['invoice','proforma']), currency: z.string().regex(/^[A-Z]{3}$/),
  sellerName: z.string().trim().max(200).default(''), sellerAddress: z.string().trim().max(2000).default(''), sellerGstin: gstin,
  customerId: z.uuid().nullable().default(null), customerName: z.string().trim().max(200).default(''),
  customerAddress: z.string().trim().max(2000).default(''), customerGstin: gstin,
  items: z.array(item).max(100).default([]).refine(items => {
    const ids = items.flatMap(item => item.id ? [item.id] : []);return ids.length === new Set(ids).size;
  },'Item identifiers must be unique'),
  notes: z.string().max(20000).default(''), dueAt
}).strict();

export type Draft = z.infer<typeof draftInput>;
export function totals(items: Draft['items']) {
  let subtotal = 0n, tax = 0n;
  for (const item of items) {
    const line = BigInt(item.quantity) * BigInt(item.unitPriceMinor);
    subtotal += line;tax += (line * BigInt(item.taxRateBps) + 5000n) / 10000n;
  }
  if(subtotal + tax > 100_000_000_000_000n)throw new AppError('AMOUNT_LIMIT','Document total exceeds the supported amount',422);
  return {subtotalMinor:Number(subtotal),taxMinor:Number(tax),totalMinor:Number(subtotal+tax)};
}
// Date.toISOString truncates PostgreSQL microseconds. Keep the exact ordering value in cursors.
const cursorTimestamp = (alias='') => `to_char(${alias}created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at`;
const fields = `i.*, ${cursorTimestamp('i.')}, (SELECT target.id FROM app.invoices target WHERE target.tenant_id=i.tenant_id AND target.proforma_id=i.id) AS converted_invoice_id,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',line.id,'artworkId',line.artwork_id,'description',line.description,'quantity',line.quantity,
 'unitPriceMinor',line.unit_price_minor,'taxRateBps',line.tax_rate_bps,'lineSubtotalMinor',line.subtotal_minor,'lineTaxMinor',line.tax_minor,'lineTotalMinor',line.total_minor) ORDER BY line.position)
 FROM app.invoice_items line WHERE line.tenant_id=i.tenant_id AND line.invoice_id=i.id),'[]'::jsonb) AS items`;
const iso = (value:unknown) => value ? new Date(value as string|number|Date).toISOString() : null;
async function employee(sql:SQL,t:string) {
  if(!(await sql.query('SELECT security.employee_access($1) AS allowed',[t])).rows[0]?.allowed)throw new AppError('ACCESS_DENIED','Gallery employee access is required',403);
}
function dto(row:Record<string,any>) {
  const snapshot = row.status !== 'draft' && row.snapshot?.schemaVersion === 1 ? row.snapshot : null;
  return {
    id:row.id, version:row.version, documentType:row.document_type, number:row.number, status:row.status, currency:row.currency,
    sellerName:snapshot?.sellerName ?? row.seller_name, sellerAddress:snapshot?.sellerAddress ?? row.seller_address, sellerGstin:snapshot?.sellerGstin ?? row.seller_gstin,
    customerId:snapshot?.customerId ?? row.customer_id, customerName:snapshot?.customerName ?? row.customer_name,
    customerAddress:snapshot?.customerAddress ?? row.customer_address, customerGstin:snapshot?.customerGstin ?? row.customer_gstin,
    items:snapshot?.items ?? row.items, notes:snapshot?.notes ?? row.notes,
    subtotalMinor:Number(snapshot?.subtotalMinor ?? row.subtotal_minor),taxMinor:Number(snapshot?.taxMinor ?? row.tax_minor),totalMinor:Number(snapshot?.totalMinor ?? row.total_minor),
    issuedAt:iso(row.issued_at),dueAt:iso(row.due_at),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),
    proformaId:row.proforma_id,convertedInvoiceId:row.converted_invoice_id,
    payable:row.document_type==='invoice' && row.status==='issued',
    contributesToSales:row.document_type==='invoice' && ['issued','paid'].includes(row.status)
  };
}
export async function detail(sql:SQL,t:string,id:string) {
  await employee(sql,t);
  return dto(requireValue((await sql.query(`SELECT ${fields} FROM app.invoices i WHERE i.tenant_id=$1 AND i.id=$2`,[t,id])).rows[0]));
}
const cursor = z.object({limit:z.coerce.number().int().min(1).max(100).default(30),after:z.uuid().optional(),before:z.iso.datetime().optional(),q:z.string().trim().max(100).optional()});
export const listInput = cursor.extend({documentType:z.enum(['invoice','proforma']).optional()}).strict().refine(value=>Boolean(value.after)===Boolean(value.before),'Both cursor values are required');
export async function list(sql:SQL,t:string,input:unknown) {
  await employee(sql,t);
  const query=listInput.parse(input),values:unknown[]=[t,query.limit+1];let where='i.tenant_id=$1';
  if(query.documentType){values.push(query.documentType);where+=` AND i.document_type=$${values.length}`;}
  if(query.after){values.push(query.before,query.after);where+=` AND (i.created_at,i.id)<($${values.length-1}::timestamptz,$${values.length}::uuid)`;}
  if(query.q){values.push(`%${query.q.replace(/[\\%_]/g,'\\$&')}%`);where+=` AND (i.number ILIKE $${values.length} OR i.customer_name ILIKE $${values.length})`;}
  const rows=(await sql.query(`SELECT ${fields} FROM app.invoices i WHERE ${where} ORDER BY i.created_at DESC,i.id DESC LIMIT $2`,values)).rows;
  const hasMore=rows.length>query.limit;if(hasMore)rows.pop();const last=rows.at(-1);
  return {items:rows.map(dto),next:hasMore&&last?{before:last.cursor_created_at,after:last.id}:null};
}
export async function save(sql:SQL,t:string,id:string|null,version:number|null,input:unknown) {
  const draft=draftInput.parse(input);totals(draft.items);await entitlement(sql,t);
  const row=(await sql.query('SELECT security.save_invoice($1,$2,$3,$4) AS id',[t,id,version,JSON.stringify(draft)])).rows[0]!;
  return detail(sql,t,row.id);
}
export async function issue(sql:SQL,t:string,id:string,version:number) {
  await entitlement(sql,t);await detail(sql,t,id);
  await sql.query('SELECT security.issue_invoice($1,$2,$3)',[t,id,version]);return detail(sql,t,id);
}
export async function convert(sql:SQL,t:string,id:string,version:number) {
  await entitlement(sql,t);await detail(sql,t,id);
  const row=(await sql.query('SELECT security.convert_proforma($1,$2,$3) AS id',[t,id,version])).rows[0]!;return detail(sql,t,row.id);
}
export const optionsInput = cursor.extend({kind:z.enum(['contacts','artworks']).optional()}).strict()
  .refine(value=>Boolean(value.after)===Boolean(value.before),'Both cursor values are required')
  .refine(value=>!value.after||Boolean(value.kind),'Choose contacts or artworks when requesting another options page');
function formatAddress(address:unknown):string {
  if(typeof address==='string')return address.slice(0,2000);
  if(!address||typeof address!=='object')return '';
  const a=address as Record<string,unknown>;
  return [a.line1,a.line2,[a.city,a.region,a.postalCode].filter(value=>typeof value==='string'&&value).join(', '),a.country].filter(value=>typeof value==='string'&&value).join('\n');
}
export async function options(sql:SQL,t:string,input:unknown) {
  await employee(sql,t);
  const query=optionsInput.parse(input);
  const organization=requireValue((await sql.query('SELECT name,settings FROM control.organizations WHERE id=$1',[t])).rows[0]);
  const result:{seller:Record<string,string>;contacts:Record<string,unknown>[];artworks:Record<string,unknown>[];contactsNext:unknown;artworksNext:unknown}={
    seller:{sellerName:typeof organization.settings.sellerName==='string'?organization.settings.sellerName:organization.name,
      sellerAddress:formatAddress(organization.settings.sellerAddress||organization.settings.address),sellerGstin:typeof organization.settings.sellerGstin==='string'?organization.settings.sellerGstin:''},
    contacts:[],artworks:[],contactsNext:null,artworksNext:null
  };
  for(const kind of ['contacts','artworks'] as const) {
    if(query.kind&&query.kind!==kind)continue;
    const values:unknown[]=[t,query.limit+1];let where='tenant_id=$1 AND archived_at IS NULL';
    if(kind==='artworks')where+=" AND status='available'";
    if(query.after){values.push(query.before,query.after);where+=' AND (created_at,id)<($3::timestamptz,$4::uuid)';}
    if(query.q){values.push(`%${query.q.replace(/[\\%_]/g,'\\$&')}%`);where+=` AND ${kind==='contacts'?'name':'title'} ILIKE $${values.length}`;}
    const columns=(kind==='contacts'?'id,name,address,gstin,created_at':'id,title,price_minor,currency,created_at')+`,${cursorTimestamp()}`;
    const rows=(await sql.query(`SELECT ${columns} FROM app.${kind} WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $2`,values)).rows;
    const hasMore=rows.length>query.limit;if(hasMore)rows.pop();const last=rows.at(-1);
    const next=hasMore&&last?{before:last.cursor_created_at,after:last.id,kind}:null;
    if(kind==='contacts'){result.contacts=rows.map(row=>({id:row.id,name:row.name,address:formatAddress(row.address),gstin:row.gstin}));result.contactsNext=next;}
    else {result.artworks=rows.map(row=>({id:row.id,title:row.title,priceMinor:row.price_minor===null?null:Number(row.price_minor),currency:row.currency}));result.artworksNext=next;}
  }
  return result;
}
