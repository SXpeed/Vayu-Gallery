-- Apply using a dedicated migration owner. Runtime roles must NEVER own tables.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='vayu_api') THEN CREATE ROLE vayu_api NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='vayu_identity') THEN CREATE ROLE vayu_identity NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='vayu_jobs') THEN CREATE ROLE vayu_jobs NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
CREATE SCHEMA identity;
CREATE SCHEMA control;
CREATE SCHEMA app;
CREATE SCHEMA security;
CREATE SCHEMA delivery;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA identity,control,app,security,delivery FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE identity.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), issuer text NOT NULL, subject text NOT NULL,
  email text NOT NULL, name text NOT NULL, email_verified boolean NOT NULL DEFAULT false,
  disabled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(issuer,subject)
);
CREATE INDEX users_email ON identity.users(lower(email));
CREATE TABLE identity.sessions (
  token_hash text PRIMARY KEY CHECK(length(token_hash)=64),
  user_id uuid NOT NULL REFERENCES identity.users(id), csrf_hash text NOT NULL,
  authenticated_at timestamptz NOT NULL, mfa_at timestamptz,
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON identity.sessions(expires_at);
CREATE TABLE identity.login_attempts (
  state_hash text PRIMARY KEY, browser_hash text NOT NULL, encrypted_verifier text NOT NULL,
  nonce text NOT NULL, expires_at timestamptz NOT NULL
);

CREATE TABLE control.plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL, version integer NOT NULL CHECK(version>0),
  name text NOT NULL, employee_limit integer NOT NULL CHECK(employee_limit>0), guest_limit integer NOT NULL CHECK(guest_limit>=0),
  storage_bytes bigint NOT NULL CHECK(storage_bytes>=0), artwork_limit integer NOT NULL CHECK(artwork_limit>=0),
  catalog_monthly_limit integer NOT NULL CHECK(catalog_monthly_limit>=0), features jsonb NOT NULL DEFAULT '{}',
  available boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(code,version)
);
-- Product allowances, deliberately no invented prices or active paid subscriptions.
INSERT INTO control.plan_versions(code,version,name,employee_limit,guest_limit,storage_bytes,artwork_limit,catalog_monthly_limit,features,available) VALUES
 ('starter',1,'Starter',1,10,1073741824,250,10,'{"catalogs":true,"website":true,"messaging":false,"privateRooms":false}',true),
 ('studio',1,'Studio',3,50,10737418240,2000,100,'{"catalogs":true,"website":true,"messaging":true,"privateRooms":true}',true),
 ('gallery',1,'Gallery',10,250,53687091200,10000,500,'{"catalogs":true,"website":true,"messaging":true,"privateRooms":true,"customDomains":true,"api":true}',true),
 ('enterprise',1,'Enterprise',30,1000,214748364800,100000,2000,'{"catalogs":true,"website":true,"messaging":true,"privateRooms":true,"customDomains":true,"api":true}',true);
CREATE TABLE control.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE CHECK(slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  name text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','closed')),
  settings jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.memberships (
  tenant_id uuid NOT NULL REFERENCES control.organizations(id), user_id uuid NOT NULL REFERENCES identity.users(id),
  role text NOT NULL CHECK(role IN ('owner','admin','manager','staff','viewer','collector')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,user_id)
);
CREATE INDEX membership_user ON control.memberships(user_id,tenant_id) WHERE status='active';
CREATE UNIQUE INDEX one_owner ON control.memberships(tenant_id) WHERE role='owner' AND status='active';
CREATE TABLE control.subscriptions (
  tenant_id uuid PRIMARY KEY REFERENCES control.organizations(id), plan_version_id uuid NOT NULL REFERENCES control.plan_versions(id),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','trialing','active','past_due','canceled')),
  trial_ends_at timestamptz, period_end timestamptz, billing_customer_id text UNIQUE, billing_subscription_id text UNIQUE,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.allowance_overrides (
  tenant_id uuid PRIMARY KEY REFERENCES control.organizations(id), employee_limit integer CHECK(employee_limit>0),
  guest_limit integer CHECK(guest_limit>=0), storage_bytes bigint CHECK(storage_bytes>=0),
  reason text NOT NULL CHECK(length(reason)>=8), expires_at timestamptz NOT NULL,
  actor_id uuid NOT NULL REFERENCES identity.users(id)
);
CREATE TABLE control.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES control.organizations(id),
  email text NOT NULL CHECK(email=lower(email)), role text NOT NULL CHECK(role IN ('admin','manager','staff','viewer','collector')),
  token_hash text NOT NULL UNIQUE, invited_by uuid NOT NULL REFERENCES identity.users(id),
  expires_at timestamptz NOT NULL, accepted_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_pending ON control.invitations(tenant_id,expires_at) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE TABLE control.provider_staff (
  user_id uuid PRIMARY KEY REFERENCES identity.users(id), role text NOT NULL CHECK(role IN ('owner','super_admin')),
  disabled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.provider_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES control.organizations(id),
  session_hash text NOT NULL REFERENCES identity.sessions(token_hash), user_id uuid NOT NULL REFERENCES identity.users(id),
  reason text NOT NULL CHECK(length(reason)>=8), expires_at timestamptz NOT NULL, closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid REFERENCES control.organizations(id),
  actor_id uuid, actor_type text NOT NULL CHECK(actor_type IN ('member','provider','system','identity')),
  provider_access_id uuid REFERENCES control.provider_access(id), request_id text,
  action text NOT NULL, entity_type text NOT NULL, entity_id text, before_data jsonb, after_data jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant_time ON control.audit_events(tenant_id,occurred_at DESC,id DESC);
CREATE TABLE control.rate_buckets (
  key text PRIMARY KEY, hits integer NOT NULL, reset_at timestamptz NOT NULL
);

CREATE FUNCTION security.user_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT s.user_id FROM identity.sessions s JOIN identity.users u ON u.id=s.user_id
 WHERE s.token_hash=nullif(current_setting('vayu.session',true),'') AND s.expires_at>now() AND s.revoked_at IS NULL AND u.disabled_at IS NULL
$$;
CREATE FUNCTION security.tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('vayu.tenant',true),'')::uuid
$$;
CREATE FUNCTION security.provider() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT FROM control.provider_staff p JOIN identity.sessions s ON s.user_id=p.user_id
  WHERE p.user_id=security.user_id() AND p.disabled_at IS NULL AND s.token_hash=current_setting('vayu.session',true)
    AND s.mfa_at>now()-interval '30 minutes')
$$;
CREATE FUNCTION security.provider_scope(t uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT security.provider() AND EXISTS(SELECT FROM control.provider_access a
  WHERE a.id=nullif(current_setting('vayu.provider_access',true),'')::uuid AND a.tenant_id=t
  AND a.user_id=security.user_id() AND a.session_hash=current_setting('vayu.session',true)
  AND a.closed_at IS NULL AND a.expires_at>now())
$$;
CREATE FUNCTION security.member_role(t uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT m.role FROM control.memberships m JOIN control.organizations o ON o.id=m.tenant_id
 WHERE m.tenant_id=t AND m.user_id=security.user_id() AND m.status='active' AND o.status='active'
$$;
CREATE FUNCTION security.tenant_access(t uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT t=security.tenant_id() AND (security.provider_scope(t) OR security.member_role(t) IS NOT NULL)
$$;
CREATE FUNCTION security.employee_access(t uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT security.tenant_access(t) AND (security.provider_scope(t) OR security.member_role(t) <> 'collector')
$$;
CREATE FUNCTION security.can_edit(t uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT security.tenant_access(t) AND (security.provider_scope(t) OR security.member_role(t) IN ('owner','admin','manager','staff'))
$$;
CREATE FUNCTION security.can_admin(t uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT security.tenant_access(t) AND (security.provider_scope(t) OR security.member_role(t) IN ('owner','admin'))
$$;
CREATE FUNCTION security.session_info() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'provider',security.provider(),
  'organizations',coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'name',o.name,'slug',o.slug,'role',m.role,'status',o.status))
  FROM control.memberships m JOIN control.organizations o ON o.id=m.tenant_id WHERE m.user_id=u.id AND m.status='active'),'[]'::jsonb))
 FROM identity.users u WHERE u.id=security.user_id()
$$;
CREATE FUNCTION security.check_csrf(h text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT FROM identity.sessions WHERE token_hash=current_setting('vayu.session',true) AND csrf_hash=h AND user_id=security.user_id())
$$;
CREATE FUNCTION security.revoke_session() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 UPDATE identity.sessions SET revoked_at=now() WHERE token_hash=current_setting('vayu.session',true) AND user_id=security.user_id()
$$;
CREATE FUNCTION security.consume_rate(k text, maximum integer, seconds integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE n integer; BEGIN
 INSERT INTO control.rate_buckets(key,hits,reset_at) VALUES(k,1,now()+make_interval(secs=>seconds))
 ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN control.rate_buckets.reset_at<=now() THEN 1 ELSE control.rate_buckets.hits+1 END,
 reset_at=CASE WHEN control.rate_buckets.reset_at<=now() THEN now()+make_interval(secs=>seconds) ELSE control.rate_buckets.reset_at END RETURNING hits INTO n;
 RETURN n<=maximum; END
$$;
CREATE FUNCTION security.open_provider_access(t uuid, why text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE result uuid; BEGIN
 IF NOT security.provider() THEN RAISE EXCEPTION 'Recent provider MFA required' USING ERRCODE='42501'; END IF;
 IF length(trim(why))<8 OR length(why)>500 THEN RAISE EXCEPTION 'An access reason is required' USING ERRCODE='22023'; END IF;
 INSERT INTO control.provider_access(tenant_id,user_id,session_hash,reason,expires_at)
 VALUES(t,security.user_id(),current_setting('vayu.session',true),why,now()+interval '30 minutes') RETURNING id INTO result;
 INSERT INTO control.audit_events(tenant_id,actor_id,actor_type,provider_access_id,request_id,action,entity_type,entity_id,after_data)
 VALUES(t,security.user_id(),'provider',result,current_setting('vayu.request',true),'provider.access.opened','organizations',t::text,jsonb_build_object('reason',why));
 RETURN result; END
$$;
CREATE FUNCTION security.close_provider_access(a uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE t uuid; BEGIN
 UPDATE control.provider_access SET closed_at=now() WHERE id=a AND user_id=security.user_id() AND session_hash=current_setting('vayu.session',true) RETURNING tenant_id INTO t;
 IF t IS NOT NULL THEN INSERT INTO control.audit_events(tenant_id,actor_id,actor_type,provider_access_id,request_id,action,entity_type,entity_id)
 VALUES(t,security.user_id(),'provider',a,current_setting('vayu.request',true),'provider.access.closed','organizations',t::text); END IF; END
$$;
CREATE FUNCTION security.append_audit(t uuid, event text, entity text, entity_key text, detail jsonb DEFAULT '{}') RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF NOT security.tenant_access(t) AND NOT (t IS NULL AND security.provider()) THEN RAISE EXCEPTION 'Audit scope denied' USING ERRCODE='42501'; END IF;
 INSERT INTO control.audit_events(tenant_id,actor_id,actor_type,provider_access_id,request_id,action,entity_type,entity_id,after_data)
 VALUES(t,security.user_id(),CASE WHEN security.provider() THEN 'provider' ELSE 'member' END,
 nullif(current_setting('vayu.provider_access',true),'')::uuid,current_setting('vayu.request',true),event,entity,entity_key,detail); END
$$;

ALTER TABLE control.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_read ON control.organizations FOR SELECT TO vayu_api USING(security.tenant_access(id) OR security.provider());
CREATE POLICY org_update ON control.organizations FOR UPDATE TO vayu_api USING(security.can_admin(id)) WITH CHECK(security.can_admin(id));
ALTER TABLE control.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON control.audit_events FOR SELECT TO vayu_api USING(security.can_admin(tenant_id) OR (tenant_id IS NULL AND security.provider()));
-- Audit writes happen only through restricted functions/triggers. No UPDATE/DELETE/TRUNCATE grants.
GRANT USAGE ON SCHEMA security,control,app TO vayu_api;
GRANT SELECT,UPDATE ON control.organizations TO vayu_api;
GRANT SELECT ON control.plan_versions,control.audit_events TO vayu_api;
GRANT USAGE ON SCHEMA identity TO vayu_identity;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA identity TO vayu_identity;
GRANT USAGE ON SCHEMA security TO vayu_identity;
GRANT EXECUTE ON FUNCTION security.consume_rate(text,integer,integer) TO vayu_identity;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA security TO vayu_api;
