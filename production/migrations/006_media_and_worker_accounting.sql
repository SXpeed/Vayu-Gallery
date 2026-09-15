ALTER TABLE app.media ADD COLUMN uploaded_byte_size bigint;
CREATE FUNCTION security.charge_job_storage(t uuid,amount bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE ceiling bigint; used bigint; BEGIN
 IF NOT security.job_scope(t) THEN RAISE EXCEPTION 'Worker lease required' USING ERRCODE='42501'; END IF;
 SELECT coalesce(o.storage_bytes,p.storage_bytes) INTO ceiling FROM control.subscriptions s JOIN control.plan_versions p ON p.id=s.plan_version_id
 LEFT JOIN control.allowance_overrides o ON o.tenant_id=t AND o.expires_at>now() WHERE s.tenant_id=t;
 INSERT INTO app.usage_counters(tenant_id,metric,period,value) VALUES(t,'storage','all',greatest(0,amount))
 ON CONFLICT(tenant_id,metric,period) DO UPDATE SET value=greatest(0,app.usage_counters.value+amount) RETURNING value INTO used;
 IF ceiling IS NULL OR used>ceiling THEN RAISE EXCEPTION 'Storage allowance reached' USING ERRCODE='23514'; END IF; END
$$;
CREATE FUNCTION security.finalize_media(t uuid,m uuid,key_value text,mime text,bytes bigint,checksum text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE original bigint; BEGIN
 IF NOT security.job_scope(t) OR key_value NOT LIKE 'tenants/'||t||'/private/%' THEN RAISE EXCEPTION 'Worker scope denied' USING ERRCODE='42501'; END IF;
 SELECT byte_size INTO original FROM app.media WHERE tenant_id=t AND id=m AND state='quarantined' FOR UPDATE;
 IF original IS NULL THEN RETURN; END IF;
 PERFORM security.charge_job_storage(t,bytes-original);
 UPDATE app.media SET object_key=key_value,mime_type=mime,uploaded_byte_size=original,byte_size=bytes,checksum_sha256=checksum,state='ready',verified_at=now() WHERE tenant_id=t AND id=m;
 END
$$;
CREATE FUNCTION security.attach_artwork_media(t uuid,a uuid,m uuid,display_value boolean,banner_value boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF NOT security.can_edit(t) THEN RAISE EXCEPTION 'Gallery editor required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT FROM app.media WHERE tenant_id=t AND id=m AND state='ready' AND space_id IS NULL AND mime_type LIKE 'image/%') THEN RAISE EXCEPTION 'A ready gallery image is required' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM app.artworks WHERE tenant_id=t AND id=a FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Artwork unavailable' USING ERRCODE='23514'; END IF;
 INSERT INTO app.artwork_media(tenant_id,artwork_id,media_id,position) SELECT t,a,m,coalesce(max(position),-1)+1 FROM app.artwork_media WHERE tenant_id=t AND artwork_id=a ON CONFLICT DO NOTHING;
 IF display_value THEN UPDATE app.artworks SET display_media_id=m WHERE tenant_id=t AND id=a; END IF;
 IF banner_value THEN UPDATE app.artworks SET banner_media_id=m WHERE tenant_id=t AND id=a; END IF;
 END
$$;
CREATE FUNCTION security.attach_catalog_pdf(t uuid,c uuid,m uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE d jsonb; BEGIN
 IF NOT security.can_edit(t) THEN RAISE EXCEPTION 'Gallery editor required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT FROM app.media WHERE tenant_id=t AND id=m AND state='ready' AND space_id IS NULL AND mime_type='application/pdf') THEN RAISE EXCEPTION 'A verified gallery PDF is required' USING ERRCODE='23514'; END IF;
 SELECT design INTO d FROM app.catalogs WHERE tenant_id=t AND id=c AND archived_at IS NULL FOR UPDATE;
 IF d IS NULL THEN RAISE EXCEPTION 'Catalog unavailable' USING ERRCODE='23514'; END IF;
 INSERT INTO app.catalog_versions(tenant_id,catalog_id,media_id,design,version_number) SELECT t,c,m,d,coalesce(max(version_number),0)+1 FROM app.catalog_versions WHERE tenant_id=t AND catalog_id=c;
 UPDATE app.catalogs SET status='ready' WHERE tenant_id=t AND id=c;
 END
$$;
GRANT EXECUTE ON FUNCTION security.charge_job_storage(uuid,bigint),security.finalize_media(uuid,uuid,text,text,bigint,text) TO vayu_jobs;
GRANT EXECUTE ON FUNCTION security.attach_artwork_media(uuid,uuid,uuid,boolean,boolean),security.attach_catalog_pdf(uuid,uuid,uuid) TO vayu_api;
REVOKE INSERT,UPDATE ON app.artwork_media,app.catalog_versions FROM vayu_api;
