-- Invoice and proforma documents share party/item editing, but only invoices can be payable.
ALTER TABLE app.contacts ADD COLUMN gstin text NOT NULL DEFAULT '' CHECK(gstin='' OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');
ALTER TABLE app.invoices ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE app.invoices ALTER COLUMN number DROP NOT NULL;
ALTER TABLE app.invoices ADD COLUMN document_type text NOT NULL DEFAULT 'invoice' CHECK(document_type IN ('invoice','proforma'));
ALTER TABLE app.invoices ADD COLUMN customer_id uuid;
ALTER TABLE app.invoices ADD COLUMN seller_name text NOT NULL DEFAULT '' CHECK(length(seller_name)<=200);
ALTER TABLE app.invoices ADD COLUMN seller_address text NOT NULL DEFAULT '' CHECK(length(seller_address)<=2000);
ALTER TABLE app.invoices ADD COLUMN seller_gstin text NOT NULL DEFAULT '' CHECK(seller_gstin='' OR seller_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');
ALTER TABLE app.invoices ADD COLUMN customer_name text NOT NULL DEFAULT '' CHECK(length(customer_name)<=200);
ALTER TABLE app.invoices ADD COLUMN customer_address text NOT NULL DEFAULT '' CHECK(length(customer_address)<=2000);
ALTER TABLE app.invoices ADD COLUMN customer_gstin text NOT NULL DEFAULT '' CHECK(customer_gstin='' OR customer_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');
ALTER TABLE app.invoices ADD COLUMN notes text NOT NULL DEFAULT '' CHECK(length(notes)<=20000);
ALTER TABLE app.invoices ADD COLUMN subtotal_minor bigint NOT NULL DEFAULT 0 CHECK(subtotal_minor>=0);
ALTER TABLE app.invoices ADD COLUMN tax_minor bigint NOT NULL DEFAULT 0 CHECK(tax_minor>=0);
ALTER TABLE app.invoices ADD COLUMN proforma_id uuid;
ALTER TABLE app.invoices ADD FOREIGN KEY(tenant_id,customer_id) REFERENCES app.contacts(tenant_id,id);
ALTER TABLE app.invoices ADD FOREIGN KEY(tenant_id,proforma_id) REFERENCES app.invoices(tenant_id,id);
ALTER TABLE app.invoices ADD UNIQUE(tenant_id,proforma_id);
ALTER TABLE app.invoices ADD CONSTRAINT proforma_not_payable CHECK(document_type<>'proforma' OR (order_id IS NULL AND status<>'paid' AND proforma_id IS NULL));
CREATE INDEX invoices_type_cursor ON app.invoices(tenant_id,document_type,created_at DESC,id DESC);

CREATE TABLE app.invoice_items (
 tenant_id uuid NOT NULL, invoice_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), position integer NOT NULL CHECK(position BETWEEN 0 AND 99),
 artwork_id uuid, description text NOT NULL CHECK(length(description) BETWEEN 1 AND 2000), quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000),
 unit_price_minor bigint NOT NULL CHECK(unit_price_minor BETWEEN 0 AND 1000000000000), tax_rate_bps integer NOT NULL DEFAULT 0 CHECK(tax_rate_bps BETWEEN 0 AND 10000),
 subtotal_minor bigint NOT NULL CHECK(subtotal_minor BETWEEN 0 AND 100000000000000), tax_minor bigint NOT NULL CHECK(tax_minor BETWEEN 0 AND 100000000000000),
 total_minor bigint NOT NULL CHECK(total_minor=subtotal_minor+tax_minor AND total_minor<=100000000000000),
 PRIMARY KEY(tenant_id,invoice_id,id), UNIQUE(tenant_id,invoice_id,position),
 FOREIGN KEY(tenant_id,invoice_id) REFERENCES app.invoices(tenant_id,id), FOREIGN KEY(tenant_id,artwork_id) REFERENCES app.artworks(tenant_id,id)
);
CREATE TABLE control.invoice_sequences (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), document_type text NOT NULL CHECK(document_type IN ('invoice','proforma')),
 year integer NOT NULL, value bigint NOT NULL CHECK(value>0), PRIMARY KEY(tenant_id,document_type,year)
);
ALTER TABLE app.invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.invoice_items FORCE ROW LEVEL SECURITY;
ALTER TABLE control.invoice_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.invoice_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_items_read ON app.invoice_items FOR SELECT TO vayu_api USING(security.employee_access(tenant_id));
DO $$ BEGIN
 EXECUTE format('CREATE POLICY owner_internal ON app.invoice_items TO %I USING(true) WITH CHECK(true)',current_user);
 EXECUTE format('CREATE POLICY owner_internal ON control.invoice_sequences TO %I USING(true) WITH CHECK(true)',current_user);
END $$;
GRANT SELECT ON app.invoice_items TO vayu_api;
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON app.invoice_items FOR EACH ROW EXECUTE FUNCTION security.audit_change();

CREATE FUNCTION security.invoice_edit_allowed(t uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT security.can_edit(t) AND (security.provider_scope(t) OR coalesce((security.entitlements(t)->>'enabled')::boolean,false))
$$;
CREATE FUNCTION security.freeze_invoice() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
 BEGIN
 IF TG_OP='DELETE' AND OLD.status<>'draft' THEN RAISE EXCEPTION 'Issued documents are immutable' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND OLD.status<>'draft' AND
   (to_jsonb(NEW)-ARRAY['status','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','updated_at'])
 THEN RAISE EXCEPTION 'Issued document snapshot is immutable' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND OLD.status<>'draft' AND (NEW.status='draft' OR OLD.status='void' AND NEW.status<>'void' OR OLD.status='paid' AND NEW.status<>'paid')
 THEN RAISE EXCEPTION 'Invalid document transition' USING ERRCODE='23514'; END IF;
 RETURN coalesce(NEW,OLD); END
$$;
CREATE FUNCTION security.freeze_invoice_item() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE t uuid; d uuid; document_status text; BEGIN
 t=coalesce(NEW.tenant_id,OLD.tenant_id);d=coalesce(NEW.invoice_id,OLD.invoice_id);
 SELECT status INTO document_status FROM app.invoices WHERE tenant_id=t AND id=d FOR UPDATE;
 IF document_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Issued document items are immutable' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.invoice_id) IS DISTINCT FROM (OLD.tenant_id,OLD.invoice_id) THEN RAISE EXCEPTION 'Item identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN coalesce(NEW,OLD); END
$$;
CREATE TRIGGER freeze_invoice BEFORE UPDATE OR DELETE ON app.invoices FOR EACH ROW EXECUTE FUNCTION security.freeze_invoice();
CREATE TRIGGER freeze_invoice_item BEFORE INSERT OR UPDATE OR DELETE ON app.invoice_items FOR EACH ROW EXECUTE FUNCTION security.freeze_invoice_item();

CREATE FUNCTION security.save_invoice(t uuid,d uuid,expected integer,input jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE current_document app.invoices%ROWTYPE; item jsonb; ordinal integer=0; line_subtotal bigint; line_tax bigint; net bigint=0; tax bigint=0; result uuid; customer uuid; BEGIN
 IF NOT security.invoice_edit_allowed(t) THEN RAISE EXCEPTION 'Gallery editor and subscription required' USING ERRCODE='42501'; END IF;
 IF input IS NULL OR jsonb_typeof(input)<>'object' OR jsonb_typeof(input->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(input->'items')>100
 OR input->>'documentType' NOT IN ('invoice','proforma') OR coalesce(input->>'currency','') !~ '^[A-Z]{3}$'
 OR length(coalesce(input->>'sellerName',''))>200 OR length(coalesce(input->>'customerName',''))>200
 OR length(coalesce(input->>'sellerAddress',''))>2000 OR length(coalesce(input->>'customerAddress',''))>2000 OR length(coalesce(input->>'notes',''))>20000
 THEN RAISE EXCEPTION 'Invalid document fields' USING ERRCODE='23514'; END IF;
 customer=nullif(input->>'customerId','')::uuid;
 IF customer IS NOT NULL AND NOT EXISTS(SELECT FROM app.contacts WHERE tenant_id=t AND id=customer AND archived_at IS NULL) THEN RAISE EXCEPTION 'Customer unavailable' USING ERRCODE='23514'; END IF;
 IF d IS NOT NULL THEN
  SELECT * INTO current_document FROM app.invoices WHERE tenant_id=t AND id=d FOR UPDATE;
  IF current_document.id IS NULL OR current_document.version IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Document changed' USING ERRCODE='40001'; END IF;
  IF current_document.status<>'draft' THEN RAISE EXCEPTION 'Only drafts can be edited' USING ERRCODE='42501'; END IF;
  IF current_document.proforma_id IS NOT NULL AND input->>'documentType'<>'invoice' THEN RAISE EXCEPTION 'Converted document must remain an invoice' USING ERRCODE='23514'; END IF;
  IF current_document.order_id IS NOT NULL AND input->>'documentType'<>'invoice' THEN RAISE EXCEPTION 'Order documents must remain invoices' USING ERRCODE='23514'; END IF;
  result=d;
 ELSE
  IF expected IS NOT NULL THEN RAISE EXCEPTION 'New documents have no version' USING ERRCODE='22023'; END IF;
  INSERT INTO app.invoices(tenant_id,document_type,currency,total_minor) VALUES(t,input->>'documentType',input->>'currency',0) RETURNING id INTO result;
 END IF;
 DELETE FROM app.invoice_items WHERE tenant_id=t AND invoice_id=result;
 FOR item IN SELECT value FROM jsonb_array_elements(input->'items') LOOP
  IF jsonb_typeof(item)<>'object' OR length(trim(coalesce(item->>'description',''))) NOT BETWEEN 1 AND 2000
  OR (item->>'quantity') !~ '^[0-9]+$' OR (item->>'unitPriceMinor') !~ '^[0-9]+$' OR (item->>'taxRateBps') !~ '^[0-9]+$'
  OR (item->>'quantity')::numeric NOT BETWEEN 1 AND 10000 OR (item->>'unitPriceMinor')::numeric NOT BETWEEN 0 AND 1000000000000 OR (item->>'taxRateBps')::numeric NOT BETWEEN 0 AND 10000
  THEN RAISE EXCEPTION 'Invalid invoice item' USING ERRCODE='23514'; END IF;
  IF nullif(item->>'artworkId','') IS NOT NULL AND NOT EXISTS(SELECT FROM app.artworks WHERE tenant_id=t AND id=(item->>'artworkId')::uuid AND archived_at IS NULL)
  THEN RAISE EXCEPTION 'Artwork unavailable' USING ERRCODE='23514'; END IF;
  line_subtotal=(item->>'quantity')::bigint*(item->>'unitPriceMinor')::bigint;
  line_tax=round(line_subtotal::numeric*(item->>'taxRateBps')::numeric/10000)::bigint;
  net=net+line_subtotal;tax=tax+line_tax;
  IF net+tax>100000000000000 THEN RAISE EXCEPTION 'Document total exceeds supported amount' USING ERRCODE='23514'; END IF;
  INSERT INTO app.invoice_items(tenant_id,invoice_id,id,position,artwork_id,description,quantity,unit_price_minor,tax_rate_bps,subtotal_minor,tax_minor,total_minor)
  VALUES(t,result,coalesce(nullif(item->>'id','')::uuid,gen_random_uuid()),ordinal,nullif(item->>'artworkId','')::uuid,trim(item->>'description'),(item->>'quantity')::integer,(item->>'unitPriceMinor')::bigint,(item->>'taxRateBps')::integer,line_subtotal,line_tax,line_subtotal+line_tax);
  ordinal=ordinal+1;
 END LOOP;
 UPDATE app.invoices SET document_type=input->>'documentType',currency=input->>'currency',customer_id=customer,
 seller_name=trim(coalesce(input->>'sellerName','')),seller_address=trim(coalesce(input->>'sellerAddress','')),seller_gstin=upper(trim(coalesce(input->>'sellerGstin',''))),
 customer_name=trim(coalesce(input->>'customerName','')),customer_address=trim(coalesce(input->>'customerAddress','')),customer_gstin=upper(trim(coalesce(input->>'customerGstin',''))),
 notes=coalesce(input->>'notes',''),due_at=nullif(input->>'dueAt','')::timestamptz,subtotal_minor=net,tax_minor=tax,total_minor=net+tax,snapshot='{}'
 WHERE tenant_id=t AND id=result;
 PERFORM security.append_audit(t,CASE WHEN d IS NULL THEN 'invoice.draft.created' ELSE 'invoice.draft.updated' END,'invoices',result::text,jsonb_build_object('documentType',input->>'documentType'));
 RETURN result; END
$$;

CREATE FUNCTION security.issue_invoice(t uuid,d uuid,expected integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE doc app.invoices%ROWTYPE; serial bigint; yr integer; lines jsonb; issued timestamptz; assigned_number text; BEGIN
 IF NOT security.invoice_edit_allowed(t) THEN RAISE EXCEPTION 'Gallery editor and subscription required' USING ERRCODE='42501'; END IF;
 SELECT * INTO doc FROM app.invoices WHERE tenant_id=t AND id=d FOR UPDATE;
 IF doc.id IS NULL OR doc.version IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Document changed' USING ERRCODE='40001'; END IF;
 IF doc.status<>'draft' THEN RAISE EXCEPTION 'Only drafts can be issued' USING ERRCODE='42501'; END IF;
 IF length(trim(doc.seller_name))=0 OR length(trim(doc.seller_address))=0 OR length(trim(doc.customer_name))=0 OR length(trim(doc.customer_address))=0 THEN RAISE EXCEPTION 'Seller and customer names and addresses are required' USING ERRCODE='23514'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',i.id,'artworkId',i.artwork_id,'description',i.description,'quantity',i.quantity,'unitPriceMinor',i.unit_price_minor,'taxRateBps',i.tax_rate_bps,'lineSubtotalMinor',i.subtotal_minor,'lineTaxMinor',i.tax_minor,'lineTotalMinor',i.total_minor) ORDER BY i.position) INTO lines FROM app.invoice_items i WHERE i.tenant_id=t AND i.invoice_id=d;
 IF lines IS NULL THEN RAISE EXCEPTION 'At least one item is required' USING ERRCODE='23514'; END IF;
 issued=now();yr=extract(year FROM issued AT TIME ZONE 'UTC');
 INSERT INTO control.invoice_sequences(tenant_id,document_type,year,value) VALUES(t,doc.document_type,yr,1)
 ON CONFLICT(tenant_id,document_type,year) DO UPDATE SET value=invoice_sequences.value+1 RETURNING value INTO serial;
 assigned_number=CASE WHEN doc.document_type='proforma' THEN 'PI-' ELSE 'INV-' END||yr||'-'||lpad(serial::text,greatest(6,length(serial::text)),'0');
 UPDATE app.invoices SET status='issued',number=assigned_number,issued_at=issued,snapshot=jsonb_build_object('schemaVersion',1,'documentType',doc.document_type,'number',assigned_number,'currency',doc.currency,
 'sellerName',doc.seller_name,'sellerAddress',doc.seller_address,'sellerGstin',doc.seller_gstin,'customerId',doc.customer_id,'customerName',doc.customer_name,'customerAddress',doc.customer_address,'customerGstin',doc.customer_gstin,
 'items',lines,'notes',doc.notes,'issuedAt',issued,'dueAt',doc.due_at,'subtotalMinor',doc.subtotal_minor,'taxMinor',doc.tax_minor,'totalMinor',doc.total_minor)
 WHERE tenant_id=t AND id=d;
 PERFORM security.append_audit(t,CASE WHEN doc.document_type='proforma' THEN 'proforma.issued' ELSE 'invoice.issued' END,'invoices',d::text,jsonb_build_object('number',assigned_number,'totalMinor',doc.total_minor,'currency',doc.currency));
 RETURN d; END
$$;

CREATE FUNCTION security.convert_proforma(t uuid,d uuid,expected integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE doc app.invoices%ROWTYPE; result uuid; BEGIN
 IF NOT security.invoice_edit_allowed(t) THEN RAISE EXCEPTION 'Gallery editor and subscription required' USING ERRCODE='42501'; END IF;
 SELECT * INTO doc FROM app.invoices WHERE tenant_id=t AND id=d FOR UPDATE;
 IF doc.id IS NULL OR doc.version IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Document changed' USING ERRCODE='40001'; END IF;
 IF doc.document_type<>'proforma' OR doc.status<>'issued' THEN RAISE EXCEPTION 'An issued proforma is required' USING ERRCODE='23514'; END IF;
 SELECT id INTO result FROM app.invoices WHERE tenant_id=t AND proforma_id=d;
 IF result IS NOT NULL THEN RETURN result; END IF;
 INSERT INTO app.invoices(tenant_id,document_type,proforma_id,currency,customer_id,seller_name,seller_address,seller_gstin,customer_name,customer_address,customer_gstin,notes,due_at,subtotal_minor,tax_minor,total_minor)
 VALUES(t,'invoice',d,doc.currency,doc.customer_id,doc.seller_name,doc.seller_address,doc.seller_gstin,doc.customer_name,doc.customer_address,doc.customer_gstin,doc.notes,doc.due_at,doc.subtotal_minor,doc.tax_minor,doc.total_minor) RETURNING id INTO result;
 INSERT INTO app.invoice_items(tenant_id,invoice_id,position,artwork_id,description,quantity,unit_price_minor,tax_rate_bps,subtotal_minor,tax_minor,total_minor)
 SELECT tenant_id,result,position,artwork_id,description,quantity,unit_price_minor,tax_rate_bps,subtotal_minor,tax_minor,total_minor FROM app.invoice_items WHERE tenant_id=t AND invoice_id=d ORDER BY position;
 PERFORM security.append_audit(t,'proforma.converted','invoices',d::text,jsonb_build_object('invoiceId',result));
 RETURN result; END
$$;
REVOKE ALL ON FUNCTION security.invoice_edit_allowed(uuid),security.freeze_invoice(),security.freeze_invoice_item() FROM PUBLIC,vayu_api,vayu_jobs;
REVOKE ALL ON FUNCTION security.save_invoice(uuid,uuid,integer,jsonb),security.issue_invoice(uuid,uuid,integer),security.convert_proforma(uuid,uuid,integer) FROM PUBLIC,vayu_identity,vayu_jobs;
GRANT EXECUTE ON FUNCTION security.save_invoice(uuid,uuid,integer,jsonb),security.issue_invoice(uuid,uuid,integer),security.convert_proforma(uuid,uuid,integer) TO vayu_api;
