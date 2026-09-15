CREATE TABLE delivery.jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES control.organizations(id),
 kind text NOT NULL CHECK(kind IN ('media.verify','image.process','catalog.generate','bulk.import','email.send','webhook.deliver','domain.verify','audit.export')),
 payload jsonb NOT NULL, idempotency_key text NOT NULL, created_by uuid REFERENCES identity.users(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','dead')),
 attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 20),
 available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_token uuid,
 last_error_code text, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,kind,idempotency_key)
);
CREATE INDEX jobs_ready ON delivery.jobs(available_at,created_at) WHERE status IN ('pending','running');
CREATE INDEX jobs_tenant ON delivery.jobs(tenant_id,created_at DESC);
CREATE TABLE delivery.webhook_events (
 provider text NOT NULL, external_id text NOT NULL, event_type text NOT NULL, body_hash text NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, PRIMARY KEY(provider,external_id)
);
CREATE TABLE app.usage_counters (
 tenant_id uuid NOT NULL REFERENCES control.organizations(id), metric text NOT NULL, period text NOT NULL,
 value bigint NOT NULL DEFAULT 0 CHECK(value>=0), PRIMARY KEY(tenant_id,metric,period)
);
ALTER TABLE app.usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.usage_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY read_rows ON app.usage_counters FOR SELECT TO vayu_api USING(security.can_admin(tenant_id));
ALTER TABLE delivery.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery.jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY job_read ON delivery.jobs FOR SELECT TO vayu_api USING(security.tenant_access(tenant_id) AND (security.can_admin(tenant_id) OR created_by=security.user_id()));
DO $$ BEGIN
 EXECUTE format('CREATE POLICY owner_internal ON app.usage_counters TO %I USING (true) WITH CHECK (true)',current_user);
 EXECUTE format('CREATE POLICY owner_internal ON delivery.jobs TO %I USING (true) WITH CHECK (true)',current_user);
END $$;
CREATE FUNCTION security.enqueue(t uuid,k text,p jsonb,dedupe text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE result uuid; BEGIN
 IF NOT security.can_edit(t) THEN RAISE EXCEPTION 'Job scope denied' USING ERRCODE='42501'; END IF;
 IF length(dedupe)<1 OR length(dedupe)>200 OR pg_column_size(p)>1048576 THEN RAISE EXCEPTION 'Invalid job payload' USING ERRCODE='22023'; END IF;
 INSERT INTO delivery.jobs(tenant_id,kind,payload,idempotency_key,created_by) VALUES(t,k,p,dedupe,security.user_id())
 ON CONFLICT(tenant_id,kind,idempotency_key) DO NOTHING RETURNING id INTO result;
 IF result IS NULL THEN SELECT id INTO result FROM delivery.jobs WHERE tenant_id=t AND kind=k AND idempotency_key=dedupe; END IF;
 RETURN result; END
$$;
CREATE FUNCTION security.claim_job() RETURNS SETOF delivery.jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 -- Exhausted crashed jobs are terminal, never leased forever.
 UPDATE delivery.jobs SET status='dead',last_error_code='LEASE_EXHAUSTED' WHERE status='running' AND lease_until<now() AND attempts>=max_attempts;
 RETURN QUERY WITH candidate AS (
 SELECT j.id FROM delivery.jobs j WHERE j.attempts<j.max_attempts AND j.available_at<=now()
 AND (j.status='pending' OR j.status='running' AND j.lease_until<now())
 ORDER BY j.available_at,j.created_at FOR UPDATE SKIP LOCKED LIMIT 1
 ) UPDATE delivery.jobs j SET status='running',attempts=j.attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes'
 FROM candidate c WHERE j.id=c.id RETURNING j.*; END
$$;
CREATE FUNCTION security.finish_job(j uuid,l uuid,error_code text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 UPDATE delivery.jobs SET status=CASE WHEN error_code IS NULL THEN 'succeeded' WHEN attempts>=max_attempts THEN 'dead' ELSE 'pending' END,
 available_at=now()+make_interval(secs=>least(3600,10*power(2,attempts)::integer)),
 completed_at=CASE WHEN error_code IS NULL THEN now() ELSE NULL END,last_error_code=left(error_code,80),lease_until=NULL,lease_token=NULL
 WHERE id=j AND lease_token=l AND status='running' AND lease_until>now(); RETURN FOUND; END
$$;
CREATE FUNCTION security.job_scope(t uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT current_setting('role',true)='vayu_jobs' AND EXISTS(SELECT FROM delivery.jobs WHERE tenant_id=t
 AND id=nullif(current_setting('vayu.job',true),'')::uuid AND lease_token=nullif(current_setting('vayu.lease',true),'')::uuid
 AND status='running' AND lease_until>now())
$$;
-- Job role must set a valid lease for the exact gallery. API credentials cannot SET ROLE vayu_jobs.
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='app' LOOP
 EXECUTE format('CREATE POLICY job_rows ON app.%I TO vayu_jobs USING (security.job_scope(tenant_id)) WITH CHECK (security.job_scope(tenant_id))',t.tablename);
 END LOOP;
END $$;
CREATE FUNCTION security.reserve_usage(t uuid,metric_value text,period_value text,amount bigint,maximum bigint) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE n bigint; BEGIN
 IF NOT security.can_edit(t) OR amount<=0 OR maximum<0 THEN RAISE EXCEPTION 'Usage denied' USING ERRCODE='42501'; END IF;
 INSERT INTO app.usage_counters(tenant_id,metric,period,value) VALUES(t,metric_value,period_value,amount)
 ON CONFLICT(tenant_id,metric,period) DO UPDATE SET value=app.usage_counters.value+amount RETURNING value INTO n;
 IF n>maximum THEN RAISE EXCEPTION 'Plan allowance reached' USING ERRCODE='23514'; END IF; RETURN n; END
$$;
-- API code supplies limits from security.entitlements, never request JSON. The API role has no table write grants.
CREATE FUNCTION security.publish_site(t uuid,pages jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE n integer; r uuid; works jsonb; BEGIN
 IF NOT security.can_admin(t) THEN RAISE EXCEPTION 'Website admin required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM control.organizations WHERE id=t FOR UPDATE;
 -- Explicit allowlist; contact, sale, cost, inventory location and private-room fields cannot enter a release.
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'title',a.title,'description',a.description,'medium',a.medium,'year',a.year,
 'dimensions',a.dimensions,'artist',ar.name,'priceMinor',CASE WHEN p.show_price THEN a.price_minor END,'currency',a.currency)),'[]'::jsonb)
 INTO works FROM app.publication_artworks p JOIN app.artworks a ON a.tenant_id=p.tenant_id AND a.id=p.artwork_id
 LEFT JOIN app.artists ar ON ar.tenant_id=a.tenant_id AND ar.id=a.artist_id WHERE a.tenant_id=t AND a.archived_at IS NULL;
 SELECT coalesce(max(version_number),0)+1 INTO n FROM app.website_releases WHERE tenant_id=t;
 INSERT INTO app.website_releases(tenant_id,version_number,snapshot) VALUES(t,n,jsonb_build_object('pages',pages,'artworks',works)) RETURNING id INTO r;
 UPDATE app.site_settings SET current_release_id=r,enabled=true WHERE tenant_id=t;
 RETURN r; END
$$;
CREATE FUNCTION security.public_site(slug_value text,host_value text DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('gallery',o.name,'slug',o.slug,'release',r.id,'content',r.snapshot) FROM control.organizations o
 JOIN app.site_settings s ON s.tenant_id=o.id AND s.enabled JOIN app.website_releases r ON r.tenant_id=o.id AND r.id=s.current_release_id
 WHERE o.status='active' AND ((host_value IS NULL AND o.slug=slug_value) OR (host_value IS NOT NULL AND EXISTS(
 SELECT FROM app.custom_domains d WHERE d.tenant_id=o.id AND d.hostname=host_value AND d.state='active' AND d.certificate_status='active')))
$$;
GRANT USAGE ON SCHEMA delivery TO vayu_api;
GRANT SELECT ON delivery.jobs,app.usage_counters TO vayu_api;
GRANT EXECUTE ON FUNCTION security.enqueue(uuid,text,jsonb,text),security.reserve_usage(uuid,text,text,bigint,bigint),security.publish_site(uuid,jsonb),security.public_site(text,text) TO vayu_api;
GRANT USAGE ON SCHEMA security,delivery,app TO vayu_jobs;
GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA app TO vayu_jobs;
GRANT EXECUTE ON FUNCTION security.claim_job(),security.finish_job(uuid,uuid,text),security.job_scope(uuid),security.user_id(),security.tenant_id(),security.provider_scope(uuid) TO vayu_jobs;
-- Leased workers cannot alter published releases, payment records, access credentials or website domains through generic SQL.
REVOKE INSERT,UPDATE ON app.payments,app.invoices,app.website_releases,app.site_settings,app.integration_keys,app.custom_domains FROM vayu_jobs;
