CREATE FUNCTION security.set_public_artwork(t uuid,a uuid,visible boolean,price boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF NOT security.can_admin(t) THEN RAISE EXCEPTION 'Website admin required' USING ERRCODE='42501'; END IF;
 IF visible THEN INSERT INTO app.publication_artworks(tenant_id,artwork_id,show_price) VALUES(t,a,price) ON CONFLICT(tenant_id,artwork_id) DO UPDATE SET show_price=price;
 ELSE DELETE FROM app.publication_artworks WHERE tenant_id=t AND artwork_id=a; END IF; END
$$;
CREATE OR REPLACE FUNCTION security.publish_site(t uuid,pages jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE n integer; r uuid; works jsonb; BEGIN
 IF NOT security.can_admin(t) THEN RAISE EXCEPTION 'Website admin required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM control.organizations WHERE id=t FOR UPDATE;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'title',a.title,'description',a.description,'medium',a.medium,'year',a.year,
 'dimensions',a.dimensions,'artist',ar.name,'priceMinor',CASE WHEN p.show_price THEN a.price_minor END,'currency',a.currency,'imageId',m.id)),'[]'::jsonb)
 INTO works FROM app.publication_artworks p JOIN app.artworks a ON a.tenant_id=p.tenant_id AND a.id=p.artwork_id
 LEFT JOIN app.artists ar ON ar.tenant_id=a.tenant_id AND ar.id=a.artist_id
 LEFT JOIN app.media m ON m.tenant_id=a.tenant_id AND m.id=a.display_media_id AND m.state='ready' AND m.space_id IS NULL AND m.mime_type LIKE 'image/%'
 WHERE a.tenant_id=t AND a.archived_at IS NULL;
 SELECT coalesce(max(version_number),0)+1 INTO n FROM app.website_releases WHERE tenant_id=t;
 INSERT INTO app.website_releases(tenant_id,version_number,snapshot) VALUES(t,n,jsonb_build_object('pages',pages,'artworks',works)) RETURNING id INTO r;
 UPDATE app.site_settings SET current_release_id=r,enabled=true WHERE tenant_id=t;
 RETURN r; END
$$;
CREATE FUNCTION security.public_media(slug_value text,m uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('key',f.object_key,'mime',f.mime_type,'bytes',f.byte_size) FROM control.organizations o
 JOIN app.site_settings s ON s.tenant_id=o.id AND s.enabled
 JOIN app.website_releases r ON r.tenant_id=o.id AND r.id=s.current_release_id
 JOIN app.media f ON f.tenant_id=o.id AND f.id=m AND f.state='ready' AND f.space_id IS NULL AND f.mime_type LIKE 'image/%'
 WHERE o.slug=slug_value AND o.status='active' AND EXISTS(SELECT FROM jsonb_array_elements(r.snapshot->'artworks') a WHERE a->>'imageId'=m::text)
$$;
CREATE FUNCTION security.request_domain(t uuid,host_value text,challenge_hash text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE d uuid; BEGIN
 IF NOT security.can_admin(t) THEN RAISE EXCEPTION 'Website admin required' USING ERRCODE='42501'; END IF;
 IF length(host_value)>253 OR host_value NOT LIKE '%.%' OR length(challenge_hash)<>64 THEN RAISE EXCEPTION 'Invalid custom domain' USING ERRCODE='22023'; END IF;
 INSERT INTO app.custom_domains(tenant_id,hostname,verification_hash) VALUES(t,host_value,challenge_hash) RETURNING id INTO d;
 RETURN d; END
$$;
CREATE FUNCTION security.mark_domain_verified(t uuid,d uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF NOT security.job_scope(t) THEN RAISE EXCEPTION 'Worker lease required' USING ERRCODE='42501'; END IF;
 UPDATE app.custom_domains SET state='verified',verified_at=now(),checked_at=now() WHERE tenant_id=t AND id=d AND state='pending'; END
$$;
GRANT EXECUTE ON FUNCTION security.set_public_artwork(uuid,uuid,boolean,boolean),security.public_media(text,uuid),security.request_domain(uuid,text,text) TO vayu_api;
GRANT EXECUTE ON FUNCTION security.mark_domain_verified(uuid,uuid) TO vayu_jobs;
