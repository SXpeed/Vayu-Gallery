ALTER TABLE app.catalogs ADD COLUMN description text NOT NULL DEFAULT '';
CREATE TABLE app.catalog_artworks (
 tenant_id uuid NOT NULL, catalog_id uuid NOT NULL, artwork_id uuid NOT NULL, position integer NOT NULL CHECK(position BETWEEN 0 AND 99),
 PRIMARY KEY(tenant_id,catalog_id,artwork_id), UNIQUE(tenant_id,catalog_id,position),
 FOREIGN KEY(tenant_id,catalog_id) REFERENCES app.catalogs(tenant_id,id), FOREIGN KEY(tenant_id,artwork_id) REFERENCES app.artworks(tenant_id,id)
);
CREATE TABLE app.catalog_drafts (
 tenant_id uuid NOT NULL, catalog_id uuid NOT NULL, user_id uuid NOT NULL DEFAULT security.user_id() REFERENCES identity.users(id),
 base_version integer NOT NULL CHECK(base_version>0), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,catalog_id,user_id), FOREIGN KEY(tenant_id,catalog_id) REFERENCES app.catalogs(tenant_id,id),
 CHECK(octet_length(data::text)<=524288)
);
ALTER TABLE app.catalog_artworks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.catalog_artworks FORCE ROW LEVEL SECURITY;
ALTER TABLE app.catalog_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.catalog_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY read_rows ON app.catalog_artworks FOR SELECT TO vayu_api USING(security.employee_access(tenant_id));
CREATE POLICY read_rows ON app.catalog_drafts FOR SELECT TO vayu_api USING(security.employee_access(tenant_id) AND (user_id=security.user_id() OR security.provider_scope(tenant_id)));
CREATE POLICY insert_rows ON app.catalog_drafts FOR INSERT TO vayu_api WITH CHECK(security.can_edit(tenant_id) AND user_id=security.user_id());
CREATE POLICY update_rows ON app.catalog_drafts FOR UPDATE TO vayu_api USING(security.can_edit(tenant_id) AND user_id=security.user_id()) WITH CHECK(security.can_edit(tenant_id) AND user_id=security.user_id());
CREATE POLICY delete_rows ON app.catalog_drafts FOR DELETE TO vayu_api USING(security.can_edit(tenant_id) AND user_id=security.user_id());
DO $$ BEGIN
 EXECUTE format('CREATE POLICY owner_internal ON app.catalog_artworks TO %I USING(true) WITH CHECK(true)',current_user);
 EXECUTE format('CREATE POLICY owner_internal ON app.catalog_drafts TO %I USING(true) WITH CHECK(true)',current_user);
END $$;
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON app.catalog_artworks FOR EACH ROW EXECUTE FUNCTION security.audit_change();
CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON app.catalog_drafts FOR EACH ROW EXECUTE FUNCTION security.audit_change();
GRANT SELECT ON app.catalog_artworks TO vayu_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.catalog_drafts TO vayu_api;

CREATE FUNCTION security.save_catalog(t uuid,c uuid,n text,description_value text,d jsonb,works uuid[],expected integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE current_version integer; BEGIN
 IF NOT security.can_edit(t) THEN RAISE EXCEPTION 'Editor required' USING ERRCODE='42501'; END IF;
 SELECT version INTO current_version FROM app.catalogs WHERE tenant_id=t AND id=c AND archived_at IS NULL FOR UPDATE;
 IF current_version IS NULL OR current_version<>expected THEN RAISE EXCEPTION 'Catalog changed' USING ERRCODE='40001'; END IF;
 IF works IS NULL OR cardinality(works)>100 OR cardinality(works)<>(SELECT count(DISTINCT w) FROM unnest(works) w)
 OR cardinality(works)<>(SELECT count(*) FROM app.artworks WHERE tenant_id=t AND id=ANY(works) AND archived_at IS NULL)
 OR length(trim(n)) NOT BETWEEN 1 AND 200 OR length(description_value)>20000 OR jsonb_typeof(d)<>'object' OR octet_length(d::text)>524288
 THEN RAISE EXCEPTION 'Invalid catalog' USING ERRCODE='23514'; END IF;
 UPDATE app.catalogs SET title=n,description=description_value,design=d WHERE tenant_id=t AND id=c;
 DELETE FROM app.catalog_artworks WHERE tenant_id=t AND catalog_id=c;
 INSERT INTO app.catalog_artworks(tenant_id,catalog_id,artwork_id,position) SELECT t,c,w,ordinality-1 FROM unnest(works) WITH ORDINALITY AS x(w,ordinality);
 DELETE FROM app.catalog_drafts WHERE tenant_id=t AND catalog_id=c AND user_id=security.user_id();
 END
$$;
CREATE FUNCTION security.order_artwork_media(t uuid,a uuid,images uuid[],display_value uuid,banner_value uuid,expected integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE current_version integer; BEGIN
 IF NOT security.can_edit(t) THEN RAISE EXCEPTION 'Editor required' USING ERRCODE='42501'; END IF;
 SELECT version INTO current_version FROM app.artworks WHERE tenant_id=t AND id=a AND archived_at IS NULL FOR UPDATE;
 IF current_version IS NULL OR current_version<>expected THEN RAISE EXCEPTION 'Artwork changed' USING ERRCODE='40001'; END IF;
 IF images IS NULL OR cardinality(images)>30 OR cardinality(images)<>(SELECT count(DISTINCT m) FROM unnest(images) m)
 OR cardinality(images)<>(SELECT count(*) FROM app.media WHERE tenant_id=t AND id=ANY(images) AND state='ready' AND deleted_at IS NULL AND space_id IS NULL AND mime_type LIKE 'image/%')
 OR (display_value IS NOT NULL AND NOT display_value=ANY(images)) OR (banner_value IS NOT NULL AND NOT banner_value=ANY(images))
 THEN RAISE EXCEPTION 'Invalid gallery images' USING ERRCODE='23514'; END IF;
 DELETE FROM app.artwork_media WHERE tenant_id=t AND artwork_id=a;
 INSERT INTO app.artwork_media(tenant_id,artwork_id,media_id,position) SELECT t,a,m,ordinality-1 FROM unnest(images) WITH ORDINALITY x(m,ordinality);
 UPDATE app.artworks SET display_media_id=display_value,banner_media_id=banner_value WHERE tenant_id=t AND id=a;
 END
$$;
GRANT EXECUTE ON FUNCTION security.save_catalog(uuid,uuid,text,text,jsonb,uuid[],integer),security.order_artwork_media(uuid,uuid,uuid[],uuid,uuid,integer) TO vayu_api;

-- Keep a durable cleanup pointer until object deletion succeeds, including after finalization.
ALTER TABLE app.media ADD COLUMN quarantine_key text;
UPDATE app.media SET quarantine_key=object_key WHERE object_key LIKE 'tenants/%/quarantine/%';
CREATE FUNCTION security.remember_quarantine() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.object_key LIKE 'tenants/'||NEW.tenant_id||'/quarantine/%' THEN NEW.quarantine_key=NEW.object_key; END IF; RETURN NEW;
END $$;
CREATE TRIGGER remember_quarantine BEFORE INSERT ON app.media FOR EACH ROW EXECUTE FUNCTION security.remember_quarantine();

-- A direct conversation's participant set cannot change; create a group to include another person.
CREATE OR REPLACE FUNCTION security.manage_space_member(t uuid,s uuid,u uuid,r text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF NOT security.tenant_access(t) OR (NOT security.provider_scope(t) AND NOT EXISTS(SELECT FROM security.space_grants WHERE tenant_id=t AND space_id=s AND user_id=security.user_id() AND role='owner')) THEN
 RAISE EXCEPTION 'Space owner required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM app.spaces WHERE tenant_id=t AND id=s AND kind<>'direct' AND archived_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Direct participants are fixed or space is unavailable' USING ERRCODE='23514'; END IF;
 IF r='remove' THEN DELETE FROM security.space_grants WHERE tenant_id=t AND space_id=s AND user_id=u AND role<>'owner';
 ELSE
 IF NOT EXISTS(SELECT FROM control.memberships WHERE tenant_id=t AND user_id=u AND status='active') OR r NOT IN ('member','viewer') THEN RAISE EXCEPTION 'Invalid participant' USING ERRCODE='23514'; END IF;
 INSERT INTO security.space_grants(tenant_id,space_id,user_id,role) VALUES(t,s,u,r) ON CONFLICT(tenant_id,space_id,user_id) DO UPDATE SET role=r WHERE space_grants.role<>'owner'; END IF;
 PERFORM security.append_audit(t,'space.membership.changed','spaces',s::text,jsonb_build_object('userId',u,'role',r)); END
$$;
