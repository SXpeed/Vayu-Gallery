import React,{useEffect,useState} from 'react';
import {createPortal} from 'react-dom';
import {Printer} from 'lucide-react';
import {Button} from './lib.jsx';
import {formatMinor} from '../shared/invoice-money.mjs';
import './invoicing.css';

export function InvoicePartyFields({value,onChange}){
 return <div className="invoice-parties-form full">{[['seller','From · gallery / seller'],['customer','Bill to · customer']].map(([prefix,title])=><fieldset key={prefix}><legend>{title}</legend><label>Legal / business name<input maxLength={200} value={value[`${prefix}Name`]||''} onChange={e=>onChange(`${prefix}Name`,e.target.value)}/></label><label>Full billing address<textarea rows={3} maxLength={2000} placeholder="Street, city, state, postal code and country" value={value[`${prefix}Address`]||''} onChange={e=>onChange(`${prefix}Address`,e.target.value)}/></label><label>GSTIN <span className="muted">(if registered)</span><input maxLength={15} autoCapitalize="characters" spellCheck={false} placeholder="15-character GST registration number" value={value[`${prefix}Gstin`]||''} onChange={e=>onChange(`${prefix}Gstin`,e.target.value.toUpperCase())}/></label></fieldset>)}</div>;
}

export function invoiceView(record){
 const production=record.totalMinor!==undefined;
 return {...record,number:record.number||record.title||'Draft',currency:record.currency||'INR',
  status:record.status?.toLowerCase(),createdAt:record.createdAt||record.created_at,
  items:(record.items||[]).map(item=>production?{title:item.description,quantity:item.quantity,amountMinor:Number(item.lineSubtotalMinor??BigInt(item.unitPriceMinor)*BigInt(item.quantity))}:({title:item.title,quantity:1,amountMinor:Math.round(Number(item.price)*100)})),
  subtotalMinor:production?Number(record.subtotalMinor):Math.round(Number(record.subtotal)*100),
  taxMinor:production?Number(record.taxMinor):Math.round((Number(record.total)-Number(record.subtotal))*100),
  totalMinor:production?Number(record.totalMinor):Math.round(Number(record.total)*100)};
}
export function InvoiceDocument({record}){
 const r=invoiceView(record),pi=r.documentType==='proforma';
 const cash=n=>formatMinor(n,r.currency);
 const date=v=>v?new Date(v).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}):'—';
 return <article className="invoice-document" aria-label={pi?'Proforma invoice document':'Invoice document'}>
  <header><div><span className="invoice-document-eyebrow">{pi?'PROFORMA INVOICE':'INVOICE'}</span><h2>{r.number}</h2><span className={`invoice-document-status ${r.status}`}>{r.status||'Draft'}</span></div><dl><div><dt>{r.issuedAt?'Issued':'Created'}</dt><dd>{date(r.issuedAt||r.createdAt)}</dd></div>{r.dueAt&&<div><dt>Due date</dt><dd>{date(r.dueAt)}</dd></div>}<div><dt>Currency</dt><dd>{r.currency}</dd></div></dl></header>
  {pi&&<p className="invoice-document-note">Proforma invoice · for review. Convert this document to an invoice before requesting payment.</p>}
  <div className="invoice-document-parties">{[['seller','FROM'],['customer','BILL TO']].map(([prefix,title])=><section key={prefix}><h3>{title}</h3><strong>{r[`${prefix}Name`]||'Name not recorded'}</strong><p>{r[`${prefix}Address`]||'Address not recorded'}</p><p className="invoice-gstin"><span>GSTIN</span> {r[`${prefix}Gstin`]||'Not provided'}</p></section>)}</div>
  <table className="invoice-document-items"><thead><tr><th>Artwork / description</th><th>Qty</th><th>Amount</th></tr></thead><tbody>{r.items.map((item,i)=><tr key={i}><td>{item.title}</td><td>{item.quantity}</td><td>{cash(item.amountMinor)}</td></tr>)}</tbody></table>
  <div className="invoice-document-totals"><div><span>Subtotal</span><span>{cash(r.subtotalMinor)}</span></div><div><span>Tax{r.taxRate!==undefined?` (${r.taxRate}%)`:''}</span><span>{cash(r.taxMinor)}</span></div><div className="invoice-grand-total"><strong>Total</strong><strong>{cash(r.totalMinor)}</strong></div></div>
  {r.notes&&<section className="invoice-document-notes"><h3>Notes & terms</h3><p>{r.notes}</p></section>}
  {r.status==='draft'&&<p className="invoice-document-note">Draft · review the details before issuing.</p>}
 </article>;
}

export function PrintInvoiceButton({record}){
 const[printing,setPrinting]=useState(false);
 useEffect(()=>{if(!printing)return;const done=()=>setPrinting(false);window.addEventListener('afterprint',done);try{window.print();}catch{done();}return()=>window.removeEventListener('afterprint',done);},[printing]);
 return <><Button variant="secondary" icon={Printer} onClick={()=>setPrinting(true)}>Print / Save PDF</Button>{printing&&createPortal(<div id="invoice-print-root"><InvoiceDocument record={record}/></div>,document.body)}</>;
}
