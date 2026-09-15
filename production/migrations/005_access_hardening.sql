-- Derive quota ceilings in PostgreSQL instead of trusting a caller-supplied maximum.
DROP FUNCTION security.reserve_usage(uuid,text,text,bigint,bigint);
CREATE FUNCTION security.reserve_usage(t uuid,metric_value text,period_value text,amount bigint) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE n bigint; maximum bigint; e jsonb; BEGIN
 IF NOT security.can_edit(t) OR amount<=0 THEN RAISE EXCEPTION 'Usage denied' USING ERRCODE='42501'; END IF;
 e=security.entitlements(t);
 IF metric_value='storage' AND period_value='all' THEN maximum=(e->>'storageBytes')::bigint;
 ELSIF metric_value='catalogs' AND period_value=to_char(now() AT TIME ZONE 'UTC','YYYY-MM') THEN maximum=(e->>'catalogMonthlyLimit')::bigint;
 ELSE RAISE EXCEPTION 'Unknown usage metric' USING ERRCODE='22023'; END IF;
 IF maximum IS NULL THEN RAISE EXCEPTION 'Subscription unavailable' USING ERRCODE='23514'; END IF;
 INSERT INTO app.usage_counters(tenant_id,metric,period,value) VALUES(t,metric_value,period_value,amount)
 ON CONFLICT(tenant_id,metric,period) DO UPDATE SET value=app.usage_counters.value+amount RETURNING value INTO n;
 IF n>maximum THEN RAISE EXCEPTION 'Plan allowance reached' USING ERRCODE='23514'; END IF; RETURN n; END
$$;
GRANT EXECUTE ON FUNCTION security.reserve_usage(uuid,text,text,bigint) TO vayu_api;
CREATE OR REPLACE FUNCTION security.space_access(t uuid,s uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT security.tenant_access(t) AND (security.provider_scope(t) OR (
 EXISTS(SELECT FROM security.space_grants g WHERE g.tenant_id=t AND g.space_id=s AND g.user_id=security.user_id())
 AND EXISTS(SELECT FROM app.spaces p WHERE p.tenant_id=t AND p.id=s AND p.archived_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>now()))))
$$;
CREATE OR REPLACE FUNCTION security.space_write(t uuid,s uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT security.space_access(t,s) AND (security.provider_scope(t) OR EXISTS(
 SELECT FROM security.space_grants g WHERE g.tenant_id=t AND g.space_id=s AND g.user_id=security.user_id() AND g.role IN ('owner','member')))
$$;
CREATE FUNCTION security.manage_space_member(t uuid,s uuid,u uuid,r text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF NOT security.tenant_access(t) OR (NOT security.provider_scope(t) AND NOT EXISTS(SELECT FROM security.space_grants WHERE tenant_id=t AND space_id=s AND user_id=security.user_id() AND role='owner')) THEN
 RAISE EXCEPTION 'Space owner required' USING ERRCODE='42501'; END IF;
 IF r='remove' THEN DELETE FROM security.space_grants WHERE tenant_id=t AND space_id=s AND user_id=u AND role<>'owner';
 ELSE
 IF NOT EXISTS(SELECT FROM control.memberships WHERE tenant_id=t AND user_id=u AND status='active') OR r NOT IN ('member','viewer') THEN RAISE EXCEPTION 'Invalid participant' USING ERRCODE='23514'; END IF;
 INSERT INTO security.space_grants(tenant_id,space_id,user_id,role) VALUES(t,s,u,r) ON CONFLICT(tenant_id,space_id,user_id) DO UPDATE SET role=r WHERE space_grants.role<>'owner'; END IF;
 PERFORM security.append_audit(t,'space.membership.changed','spaces',s::text,jsonb_build_object('userId',u,'role',r)); END
$$;
CREATE FUNCTION security.release_storage(t uuid,m uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE b bigint; BEGIN
 IF NOT security.job_scope(t) THEN RAISE EXCEPTION 'Worker lease required' USING ERRCODE='42501'; END IF;
 UPDATE app.media SET state='rejected',deleted_at=now() WHERE tenant_id=t AND id=m AND state NOT IN ('ready','rejected','deleted') RETURNING byte_size INTO b;
 IF b IS NOT NULL THEN UPDATE app.usage_counters SET value=greatest(0,value-b) WHERE tenant_id=t AND metric='storage' AND period='all'; END IF; END
$$;
CREATE FUNCTION security.record_auth_event(u uuid,event text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN INSERT INTO control.audit_events(actor_id,actor_type,action,entity_type,entity_id) VALUES(u,'identity',event,'users',u::text); END
$$;
CREATE FUNCTION security.configure_provider_org(t uuid,n text,s text,why text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF NOT security.provider_scope(t) OR length(trim(why))<8 THEN RAISE EXCEPTION 'Scoped provider access and reason required' USING ERRCODE='42501'; END IF;
 UPDATE control.organizations SET name=n,status=s,updated_at=now() WHERE id=t;
 PERFORM security.append_audit(t,'provider.organization.updated','organizations',t::text,jsonb_build_object('name',n,'status',s,'reason',why)); END
$$;
CREATE FUNCTION security.select_trial_plan(t uuid,p uuid,why text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF NOT security.provider_scope(t) OR length(trim(why))<8 THEN RAISE EXCEPTION 'Scoped provider access and reason required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM control.organizations WHERE id=t FOR UPDATE;
 IF NOT EXISTS(SELECT FROM control.plan_versions WHERE id=p AND available) THEN RAISE EXCEPTION 'Plan unavailable' USING ERRCODE='23514'; END IF;
 UPDATE control.subscriptions SET plan_version_id=p,updated_at=now() WHERE tenant_id=t AND status='trialing';
 IF NOT FOUND THEN RAISE EXCEPTION 'Paid plan changes require verified billing events' USING ERRCODE='23514'; END IF;
 PERFORM security.append_audit(t,'provider.trial_plan.updated','subscriptions',t::text,jsonb_build_object('planVersion',p,'reason',why)); END
$$;
GRANT EXECUTE ON FUNCTION security.manage_space_member(uuid,uuid,uuid,text),security.configure_provider_org(uuid,text,text,text),security.select_trial_plan(uuid,uuid,text) TO vayu_api;
GRANT EXECUTE ON FUNCTION security.record_auth_event(uuid,text) TO vayu_identity;
GRANT EXECUTE ON FUNCTION security.release_storage(uuid,uuid) TO vayu_jobs;
-- Keep secrets, job payloads and bearer credentials out of all normal read surfaces.
REVOKE SELECT ON app.integration_keys,app.webhook_endpoints FROM vayu_api;
GRANT SELECT(tenant_id,id,name,scopes,expires_at,revoked_at,created_at,updated_at,version,created_by) ON app.integration_keys TO vayu_api;
GRANT SELECT(tenant_id,id,url,events,disabled_at,created_at,updated_at,version,created_by) ON app.webhook_endpoints TO vayu_api;
REVOKE UPDATE ON control.organizations FROM vayu_api;
GRANT UPDATE(name,settings,updated_at) ON control.organizations TO vayu_api;
CREATE FUNCTION security.immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'History is immutable' USING ERRCODE='42501'; END
$$;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON control.audit_events FOR EACH ROW EXECUTE FUNCTION security.immutable_history();
CREATE TRIGGER immutable_release BEFORE UPDATE OR DELETE ON app.website_releases FOR EACH ROW EXECUTE FUNCTION security.immutable_history();
CREATE TRIGGER immutable_revision BEFORE UPDATE OR DELETE ON app.record_revisions FOR EACH ROW EXECUTE FUNCTION security.immutable_history();
