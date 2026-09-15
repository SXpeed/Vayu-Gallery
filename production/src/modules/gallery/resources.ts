import { z } from 'zod';
const short=z.string().trim().min(1).max(200), text=z.string().max(20000), id=z.uuid().nullable().optional();
export const address=z.object({line1:z.string().max(200).default(''),line2:z.string().max(200).default(''),city:z.string().max(100).default(''),region:z.string().max(100).default(''),postalCode:z.string().max(30).default(''),country:z.string().max(100).default('')}).strict();
const money=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), currency=z.string().regex(/^[A-Z]{3}$/);
const seo=z.object({title:z.string().max(70).default(''),description:z.string().max(200).default('')}).strict();
export const block=z.discriminatedUnion('type',[
 z.object({type:z.literal('heading'),text:z.string().max(200)}).strict(),
 z.object({type:z.literal('paragraph'),text:z.string().max(10000)}).strict(),
 z.object({type:z.literal('artworks'),title:z.string().max(200)}).strict()
]);
export const resources = {
 artists:{schema:z.object({name:short,biography:text.default(''),nationality:z.string().max(100).optional(),birth_year:z.number().int().min(0).max(3000).optional(),death_year:z.number().int().min(0).max(3000).optional(),website:z.url().max(500).optional()}).strict()},
 artworks:{schema:z.object({title:short,inventory_number:short,artist_id:id,location_id:id,description:text.default(''),medium:z.string().max(200).optional(),year:z.string().max(30).optional(),dimensions:z.object({height:z.number().positive().optional(),width:z.number().positive().optional(),depth:z.number().positive().optional(),unit:z.enum(['cm','in']).default('cm')}).strict().default({unit:'cm'}),price_minor:money.nullable().optional(),currency:currency.default('USD')}).strict()},
 locations:{schema:z.object({name:short,kind:z.enum(['gallery','storage','consignment','transit','other']),address:address.default({line1:'',line2:'',city:'',region:'',postalCode:'',country:''})}).strict()},
 contacts:{schema:z.object({name:short,email:z.email().max(254).optional(),phone:z.string().max(40).optional(),kind:z.enum(['collector','lead','artist','supplier','other']).default('collector'),address:address.optional(),gstin:z.string().trim().toUpperCase().regex(/^(?:[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])?$/).default(''),notes:text.default('')}).strict()},
 collections:{schema:z.object({title:short,description:text.default('')}).strict()},
 exhibitions:{schema:z.object({title:short,description:text.default(''),starts_at:z.iso.datetime().optional(),ends_at:z.iso.datetime().optional(),location_id:id}).strict()},
 enquiries:{schema:z.object({title:short,message:text.default(''),contact_id:id,artwork_id:id,address:address.optional(),status:z.enum(['new','open','qualified','closed']).default('new')}).strict()},
 catalogs:{schema:z.object({title:short,source:z.enum(['generated','uploaded']),design:z.record(z.string(),z.unknown()).default({})}).strict(),feature:'catalogs'},
 tasks:{schema:z.object({title:short,description:text.default(''),due_at:z.iso.datetime().optional()}).strict()},
 website_drafts:{schema:z.object({title:short,slug:z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),seo:seo.default({title:'',description:''}),content:z.array(block).max(100).default([]),theme:z.object({accent:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#294436'),font:z.enum(['serif','sans']).default('serif')}).strict().default({accent:'#294436',font:'serif'})}).strict(),feature:'website',admin:true}
} satisfies Record<string,{schema:z.ZodObject<any>;feature?:string;admin?:boolean}>;
export type Resource=keyof typeof resources;
export function isResource(value:string):value is Resource {return Object.hasOwn(resources,value);}
export const listQuery=z.object({limit:z.coerce.number().int().min(1).max(100).default(30),after:z.uuid().optional(),before:z.iso.datetime().optional(),q:z.string().max(100).optional()}).strict()
 .refine(v=>Boolean(v.after)===Boolean(v.before),'Both cursor values are required');
