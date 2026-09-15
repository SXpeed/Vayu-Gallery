-- Business records are normalized; JSON is limited to flexible content/design/snapshots.
CREATE TABLE app.artists (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 name text NOT NULL, biography text NOT NULL DEFAULT '', nationality text, birth_year integer, death_year integer, website text, archived_at timestamptz,
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX artists_cursor ON app.artists(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.locations (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 name text NOT NULL, kind text NOT NULL CHECK(kind IN ('gallery','storage','consignment','transit','other')), address jsonb NOT NULL DEFAULT '{}', archived_at timestamptz,
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX locations_cursor ON app.locations(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.artworks (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 artist_id uuid, location_id uuid, title text NOT NULL, inventory_number text NOT NULL, description text NOT NULL DEFAULT '', medium text, dimensions jsonb NOT NULL DEFAULT '{}', year text, price_minor bigint CHECK(price_minor>=0), currency text NOT NULL DEFAULT 'USD' CHECK(currency ~ '^[A-Z]{3}$'), status text NOT NULL DEFAULT 'available' CHECK(status IN ('available','reserved','sold','consigned','unavailable')), display_media_id uuid, banner_media_id uuid, archived_at timestamptz, UNIQUE(tenant_id,inventory_number), FOREIGN KEY(tenant_id,artist_id) REFERENCES app.artists(tenant_id,id), FOREIGN KEY(tenant_id,location_id) REFERENCES app.locations(tenant_id,id),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX artworks_cursor ON app.artworks(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.contacts (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 name text NOT NULL, email text, phone text, kind text NOT NULL DEFAULT 'collector' CHECK(kind IN ('collector','lead','artist','supplier','other')), address jsonb NOT NULL DEFAULT '{}', notes text NOT NULL DEFAULT '', archived_at timestamptz,
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX contacts_cursor ON app.contacts(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.collections (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 title text NOT NULL, description text NOT NULL DEFAULT '', cover_media_id uuid, archived_at timestamptz,
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX collections_cursor ON app.collections(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.exhibitions (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 title text NOT NULL, description text NOT NULL DEFAULT '', starts_at timestamptz, ends_at timestamptz, location_id uuid, archived_at timestamptz, CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at>=starts_at), FOREIGN KEY(tenant_id,location_id) REFERENCES app.locations(tenant_id,id),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX exhibitions_cursor ON app.exhibitions(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.enquiries (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 contact_id uuid, artwork_id uuid, title text NOT NULL, message text NOT NULL DEFAULT '', address jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','open','qualified','closed')), assigned_to uuid REFERENCES identity.users(id), archived_at timestamptz, FOREIGN KEY(tenant_id,contact_id) REFERENCES app.contacts(tenant_id,id), FOREIGN KEY(tenant_id,artwork_id) REFERENCES app.artworks(tenant_id,id),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX enquiries_cursor ON app.enquiries(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.offers (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 contact_id uuid NOT NULL, title text NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','accepted','declined','expired','canceled')), valid_until timestamptz, notes text NOT NULL DEFAULT '', FOREIGN KEY(tenant_id,contact_id) REFERENCES app.contacts(tenant_id,id),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX offers_cursor ON app.offers(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.orders (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 contact_id uuid NOT NULL, offer_id uuid, number text NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','fulfilled','canceled')), total_minor bigint NOT NULL DEFAULT 0 CHECK(total_minor>=0), shipping_address jsonb NOT NULL DEFAULT '{}', UNIQUE(tenant_id,number), FOREIGN KEY(tenant_id,contact_id) REFERENCES app.contacts(tenant_id,id), FOREIGN KEY(tenant_id,offer_id) REFERENCES app.offers(tenant_id,id),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX orders_cursor ON app.orders(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.invoices (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL, number text NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','paid','void')), total_minor bigint NOT NULL CHECK(total_minor>=0), issued_at timestamptz, due_at timestamptz, snapshot jsonb NOT NULL DEFAULT '{}', UNIQUE(tenant_id,number), FOREIGN KEY(tenant_id,order_id) REFERENCES app.orders(tenant_id,id),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX invoices_cursor ON app.invoices(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.payments (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL, provider text NOT NULL, external_id text NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>0), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), status text NOT NULL CHECK(status IN ('pending','succeeded','failed','refunded')), UNIQUE(tenant_id,provider,external_id), FOREIGN KEY(tenant_id,order_id) REFERENCES app.orders(tenant_id,id),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX payments_cursor ON app.payments(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.catalogs (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 title text NOT NULL, source text NOT NULL CHECK(source IN ('generated','uploaded')), design jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','ready','failed')), archived_at timestamptz,
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX catalogs_cursor ON app.catalogs(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.spaces (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 title text NOT NULL, kind text NOT NULL CHECK(kind IN ('direct','group','collector')), description text NOT NULL DEFAULT '', expires_at timestamptz, archived_at timestamptz,
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX spaces_cursor ON app.spaces(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.media (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 name text NOT NULL, object_key text NOT NULL UNIQUE, mime_type text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>0 AND byte_size<=104857600), checksum_sha256 text NOT NULL CHECK(checksum_sha256 ~ '^[a-f0-9]{64}$'), state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','quarantined','processing','ready','rejected','deleted')), space_id uuid, purpose text NOT NULL CHECK(purpose IN ('artwork','catalog','document','logo','enquiry','message')), uploaded_at timestamptz, verified_at timestamptz, deleted_at timestamptz, FOREIGN KEY(tenant_id,space_id) REFERENCES app.spaces(tenant_id,id),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX media_cursor ON app.media(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.messages (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 space_id uuid NOT NULL, body text NOT NULL CHECK(length(body)<=20000), edited_at timestamptz, deleted_at timestamptz, FOREIGN KEY(tenant_id,space_id) REFERENCES app.spaces(tenant_id,id),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX messages_cursor ON app.messages(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.tasks (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 title text NOT NULL, description text NOT NULL DEFAULT '', assigned_to uuid REFERENCES identity.users(id), due_at timestamptz, completed_at timestamptz, archived_at timestamptz,
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX tasks_cursor ON app.tasks(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.inventory_movements (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 artwork_id uuid NOT NULL, from_location_id uuid, to_location_id uuid NOT NULL, reason text NOT NULL, moved_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tenant_id,artwork_id) REFERENCES app.artworks(tenant_id,id), FOREIGN KEY(tenant_id,from_location_id) REFERENCES app.locations(tenant_id,id), FOREIGN KEY(tenant_id,to_location_id) REFERENCES app.locations(tenant_id,id),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX inventory_movements_cursor ON app.inventory_movements(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.reservations (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 artwork_id uuid NOT NULL, contact_id uuid NOT NULL, expires_at timestamptz NOT NULL, released_at timestamptz, FOREIGN KEY(tenant_id,artwork_id) REFERENCES app.artworks(tenant_id,id), FOREIGN KEY(tenant_id,contact_id) REFERENCES app.contacts(tenant_id,id),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX reservations_cursor ON app.reservations(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.deliveries (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','packed','shipped','delivered','returned')), address jsonb NOT NULL DEFAULT '{}', carrier text, tracking_number text, FOREIGN KEY(tenant_id,order_id) REFERENCES app.orders(tenant_id,id),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX deliveries_cursor ON app.deliveries(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.website_drafts (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 title text NOT NULL, slug text NOT NULL CHECK(slug ~ '^[a-z0-9][a-z0-9-]*$'), seo jsonb NOT NULL DEFAULT '{}', content jsonb NOT NULL DEFAULT '[]', theme jsonb NOT NULL DEFAULT '{}', UNIQUE(tenant_id,slug),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX website_drafts_cursor ON app.website_drafts(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.website_releases (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 version_number integer NOT NULL, snapshot jsonb NOT NULL, published_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,version_number),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX website_releases_cursor ON app.website_releases(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.custom_domains (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 hostname text NOT NULL UNIQUE CHECK(hostname=lower(hostname)), verification_hash text NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','verified','provisioning','active','failed','disabled')), verified_at timestamptz, certificate_status text, checked_at timestamptz,
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX custom_domains_cursor ON app.custom_domains(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.integration_keys (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 name text NOT NULL, token_hash text NOT NULL UNIQUE, scopes text[] NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX integration_keys_cursor ON app.integration_keys(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.webhook_endpoints (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 url text NOT NULL, events text[] NOT NULL, encrypted_secret text NOT NULL, disabled_at timestamptz,
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX webhook_endpoints_cursor ON app.webhook_endpoints(tenant_id,created_at DESC,id DESC);
CREATE TABLE app.record_revisions (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 entity_type text NOT NULL, entity_id uuid NOT NULL, space_id uuid, data jsonb NOT NULL, FOREIGN KEY(tenant_id,space_id) REFERENCES app.spaces(tenant_id,id),
 created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,id)
);
CREATE INDEX record_revisions_cursor ON app.record_revisions(tenant_id,created_at DESC,id DESC);

ALTER TABLE app.artworks ADD FOREIGN KEY(tenant_id,display_media_id) REFERENCES app.media(tenant_id,id);
ALTER TABLE app.artworks ADD FOREIGN KEY(tenant_id,banner_media_id) REFERENCES app.media(tenant_id,id);
ALTER TABLE app.collections ADD FOREIGN KEY(tenant_id,cover_media_id) REFERENCES app.media(tenant_id,id);
CREATE UNIQUE INDEX active_reservation ON app.reservations(tenant_id,artwork_id) WHERE released_at IS NULL;
CREATE INDEX artwork_artist ON app.artworks(tenant_id,artist_id);
CREATE INDEX message_cursor ON app.messages(tenant_id,space_id,created_at,id);
CREATE TABLE security.space_grants (
 tenant_id uuid NOT NULL, space_id uuid NOT NULL, user_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('owner','member','viewer')), PRIMARY KEY(tenant_id,space_id,user_id),
 FOREIGN KEY(tenant_id,space_id) REFERENCES app.spaces(tenant_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES control.memberships(tenant_id,user_id)
);
CREATE FUNCTION security.space_access(t uuid,s uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT security.tenant_access(t) AND (security.provider_scope(t) OR EXISTS(
 SELECT FROM security.space_grants g WHERE g.tenant_id=t AND g.space_id=s AND g.user_id=security.user_id()))
$$;
CREATE FUNCTION security.space_write(t uuid,s uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT security.tenant_access(t) AND (security.provider_scope(t) OR EXISTS(
 SELECT FROM security.space_grants g WHERE g.tenant_id=t AND g.space_id=s AND g.user_id=security.user_id() AND g.role IN ('owner','member')))
$$;
CREATE TABLE app.artwork_media (
 tenant_id uuid NOT NULL, artwork_id uuid NOT NULL, media_id uuid NOT NULL, position integer NOT NULL DEFAULT 0 CHECK(position>=0),
 PRIMARY KEY(tenant_id,artwork_id,media_id), FOREIGN KEY(tenant_id,artwork_id) REFERENCES app.artworks(tenant_id,id),
 FOREIGN KEY(tenant_id,media_id) REFERENCES app.media(tenant_id,id)
);
CREATE TABLE app.collection_artworks (
 tenant_id uuid NOT NULL, collection_id uuid NOT NULL, artwork_id uuid NOT NULL, position integer NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,collection_id,artwork_id), FOREIGN KEY(tenant_id,collection_id) REFERENCES app.collections(tenant_id,id),
 FOREIGN KEY(tenant_id,artwork_id) REFERENCES app.artworks(tenant_id,id)
);
CREATE TABLE app.exhibition_artworks (
 tenant_id uuid NOT NULL, exhibition_id uuid NOT NULL, artwork_id uuid NOT NULL, position integer NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,exhibition_id,artwork_id), FOREIGN KEY(tenant_id,exhibition_id) REFERENCES app.exhibitions(tenant_id,id),
 FOREIGN KEY(tenant_id,artwork_id) REFERENCES app.artworks(tenant_id,id)
);
CREATE TABLE app.space_artworks (
 tenant_id uuid NOT NULL, space_id uuid NOT NULL, artwork_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,space_id,artwork_id), FOREIGN KEY(tenant_id,space_id) REFERENCES app.spaces(tenant_id,id),
 FOREIGN KEY(tenant_id,artwork_id) REFERENCES app.artworks(tenant_id,id)
);
CREATE TABLE app.message_media (
 tenant_id uuid NOT NULL, message_id uuid NOT NULL, media_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,message_id,media_id), FOREIGN KEY(tenant_id,message_id) REFERENCES app.messages(tenant_id,id),
 FOREIGN KEY(tenant_id,media_id) REFERENCES app.media(tenant_id,id)
);
CREATE TABLE app.catalog_versions (
 tenant_id uuid NOT NULL, catalog_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), media_id uuid NOT NULL,
 design jsonb NOT NULL, version_number integer NOT NULL CHECK(version_number>0), created_by uuid REFERENCES identity.users(id) DEFAULT security.user_id(),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,catalog_id,version_number),
 FOREIGN KEY(tenant_id,catalog_id) REFERENCES app.catalogs(tenant_id,id), FOREIGN KEY(tenant_id,media_id) REFERENCES app.media(tenant_id,id)
);
CREATE TABLE app.offer_items (
 tenant_id uuid NOT NULL, offer_id uuid NOT NULL, artwork_id uuid NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>=0),
 PRIMARY KEY(tenant_id,offer_id,artwork_id), FOREIGN KEY(tenant_id,offer_id) REFERENCES app.offers(tenant_id,id),
 FOREIGN KEY(tenant_id,artwork_id) REFERENCES app.artworks(tenant_id,id)
);
CREATE TABLE app.order_items (
 tenant_id uuid NOT NULL, order_id uuid NOT NULL, artwork_id uuid NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor>=0), snapshot jsonb NOT NULL,
 PRIMARY KEY(tenant_id,order_id,artwork_id), FOREIGN KEY(tenant_id,order_id) REFERENCES app.orders(tenant_id,id),
 FOREIGN KEY(tenant_id,artwork_id) REFERENCES app.artworks(tenant_id,id)
);
CREATE TABLE app.publication_artworks (
 tenant_id uuid NOT NULL, artwork_id uuid NOT NULL, show_price boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,artwork_id), FOREIGN KEY(tenant_id,artwork_id) REFERENCES app.artworks(tenant_id,id)
);
CREATE TABLE app.site_settings (
 tenant_id uuid PRIMARY KEY REFERENCES control.organizations(id), current_release_id uuid, enabled boolean NOT NULL DEFAULT false,
 FOREIGN KEY(tenant_id,current_release_id) REFERENCES app.website_releases(tenant_id,id)
);

CREATE FUNCTION security.audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE old_doc jsonb; new_doc jsonb; target uuid; who uuid; actor text; BEGIN
 old_doc=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 new_doc=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 target=coalesce((new_doc->>'tenant_id')::uuid,(old_doc->>'tenant_id')::uuid);
 who=security.user_id();
 actor=CASE WHEN who IS NULL THEN 'system' WHEN security.provider_scope(target) THEN 'provider' ELSE 'member' END;
 -- Private bodies/documents remain in their protected tables, not tenant-admin audit payloads.
 old_doc=old_doc-ARRAY['body','data','encrypted_secret','token_hash','verification_hash','object_key'];
 new_doc=new_doc-ARRAY['body','data','encrypted_secret','token_hash','verification_hash','object_key'];
 INSERT INTO control.audit_events(tenant_id,actor_id,actor_type,provider_access_id,request_id,action,entity_type,entity_id,before_data,after_data)
 VALUES(target,who,actor,nullif(current_setting('vayu.provider_access',true),'')::uuid,current_setting('vayu.request',true),
 lower(TG_OP),TG_TABLE_NAME,coalesce(new_doc->>'id',old_doc->>'id'),old_doc,new_doc);
 RETURN coalesce(NEW,OLD); END
$$;
CREATE FUNCTION security.version_record() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at<>OLD.created_at THEN
 RAISE EXCEPTION 'Record identity cannot be changed' USING ERRCODE='42501'; END IF;
 NEW.version=OLD.version+1; NEW.updated_at=now(); RETURN NEW; END
$$;
CREATE TRIGGER version_record BEFORE UPDATE ON app.artists FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.locations FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.artworks FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.contacts FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.collections FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.exhibitions FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.enquiries FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.offers FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.invoices FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.payments FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.catalogs FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.spaces FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.media FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.messages FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.tasks FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.inventory_movements FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.reservations FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.deliveries FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.website_drafts FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.website_releases FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.custom_domains FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.integration_keys FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.webhook_endpoints FOR EACH ROW EXECUTE FUNCTION security.version_record();
CREATE TRIGGER version_record BEFORE UPDATE ON app.record_revisions FOR EACH ROW EXECUTE FUNCTION security.version_record();

-- Every business table fails closed for the API, including junction tables.
DO $$ DECLARE t record; read_rule text; write_rule text; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='app' LOOP
 read_rule='security.employee_access(tenant_id)';
 write_rule='security.can_edit(tenant_id)';
 IF t.tablename='spaces' THEN read_rule='security.space_access(tenant_id,id)'; write_rule='security.space_write(tenant_id,id)';
 ELSIF t.tablename IN ('messages','space_artworks') THEN read_rule='security.space_access(tenant_id,space_id)'; write_rule='security.space_write(tenant_id,space_id)';
 ELSIF t.tablename IN ('media','record_revisions') THEN
 read_rule='security.tenant_access(tenant_id) AND (CASE WHEN space_id IS NOT NULL THEN security.space_access(tenant_id,space_id) ELSE security.employee_access(tenant_id) END)';
 write_rule='security.can_edit(tenant_id) AND (space_id IS NULL OR security.space_write(tenant_id,space_id))';
 ELSIF t.tablename='message_media' THEN
 read_rule='EXISTS(SELECT FROM app.messages m WHERE m.tenant_id=message_media.tenant_id AND m.id=message_media.message_id)';
 write_rule=read_rule;
 ELSIF t.tablename IN ('website_drafts','website_releases','custom_domains','site_settings','publication_artworks','integration_keys','webhook_endpoints') THEN
 read_rule='security.can_admin(tenant_id)'; write_rule=read_rule;
 END IF;
 EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t.tablename);
 EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t.tablename);
 EXECUTE format('CREATE POLICY read_rows ON app.%I FOR SELECT TO vayu_api USING (%s)',t.tablename,read_rule);
 EXECUTE format('CREATE POLICY insert_rows ON app.%I FOR INSERT TO vayu_api WITH CHECK (%s)',t.tablename,write_rule);
 EXECUTE format('CREATE POLICY update_rows ON app.%I FOR UPDATE TO vayu_api USING (%s) WITH CHECK (%s)',t.tablename,write_rule,write_rule);
 EXECUTE format('CREATE POLICY owner_internal ON app.%I TO %I USING (true) WITH CHECK (true)',t.tablename,current_user);
 EXECUTE format('CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION security.audit_change()',t.tablename);
 END LOOP;
 -- Definer functions are owned by the migration role, never by any runtime role.
 EXECUTE format('CREATE POLICY owner_internal ON control.organizations TO %I USING (true) WITH CHECK (true)',current_user);
 EXECUTE format('CREATE POLICY owner_internal ON control.audit_events TO %I USING (true) WITH CHECK (true)',current_user);
END $$;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA app TO vayu_api;
REVOKE INSERT,UPDATE ON app.payments,app.invoices,app.website_releases,app.record_revisions,app.custom_domains,app.spaces FROM vayu_api;
REVOKE UPDATE ON app.catalog_versions,app.inventory_movements FROM vayu_api;
GRANT EXECUTE ON FUNCTION security.space_access(uuid,uuid),security.space_write(uuid,uuid) TO vayu_api;

