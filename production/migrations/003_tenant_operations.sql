CREATE FUNCTION security.entitlements(t uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('plan',p.code,'name',p.name,'version',p.version,'status',s.status,
 'enabled',s.status='active' OR (s.status='trialing' AND s.trial_ends_at>now()),
 'employeeLimit',coalesce(o.employee_limit,p.employee_limit),'guestLimit',coalesce(o.guest_limit,p.guest_limit),
 'storageBytes',coalesce(o.storage_bytes,p.storage_bytes)::text,'artworkLimit',p.artwork_limit,'catalogMonthlyLimit',p.catalog_monthly_limit,
 'features',p.features,'trialEndsAt',s.trial_ends_at)
 FROM control.subscriptions s JOIN control.plan_versions p ON p.id=s.plan_version_id
 LEFT JOIN control.allowance_overrides o ON o.tenant_id=t AND o.expires_at>now()
 WHERE s.tenant_id=t AND security.tenant_access(t)
$$;
CREATE FUNCTION security.create_organization(n text, slug_value text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE t uuid; u uuid; p uuid; BEGIN
 u=security.user_id(); IF u IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM identity.users WHERE id=u FOR UPDATE;
 IF (SELECT count(*) FROM control.memberships WHERE user_id=u AND role='owner')>=3 THEN RAISE EXCEPTION 'Contact provider to create more galleries' USING ERRCODE='23514'; END IF;
 IF length(trim(n))<2 OR length(n)>120 THEN RAISE EXCEPTION 'Invalid organization name' USING ERRCODE='22023'; END IF;
 SELECT id INTO p FROM control.plan_versions WHERE code='starter' AND available ORDER BY version DESC LIMIT 1;
 INSERT INTO control.organizations(name,slug) VALUES(trim(n),slug_value) RETURNING id INTO t;
 INSERT INTO control.memberships(tenant_id,user_id,role) VALUES(t,u,'owner');
 INSERT INTO control.subscriptions(tenant_id,plan_version_id,status,trial_ends_at) VALUES(t,p,'trialing',now()+interval '14 days');
 INSERT INTO app.site_settings(tenant_id) VALUES(t);
 INSERT INTO control.audit_events(tenant_id,actor_id,actor_type,request_id,action,entity_type,entity_id)
 VALUES(t,u,'member',current_setting('vayu.request',true),'organization.created','organizations',t::text);
 RETURN t; END
$$;
CREATE FUNCTION security.team(t uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN security.can_admin(t) THEN jsonb_build_object(
 'members',coalesce((SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'role',m.role,'status',m.status))
 FROM control.memberships m JOIN identity.users u ON u.id=m.user_id WHERE m.tenant_id=t),'[]'::jsonb),
 'invitations',coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'role',i.role,'expiresAt',i.expires_at))
 FROM control.invitations i WHERE tenant_id=t AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()),'[]'::jsonb)) END
$$;
-- Every seat allocation takes the same organization row lock, including acceptance.
CREATE FUNCTION security.assert_seat(t uuid,r text,except_invite uuid DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE maximum integer; occupied integer; reserved integer; e jsonb; BEGIN
 PERFORM 1 FROM control.organizations WHERE id=t FOR UPDATE;
 e=security.entitlements(t);
 IF e IS NULL OR NOT (e->>'enabled')::boolean THEN RAISE EXCEPTION 'An active subscription or trial is required' USING ERRCODE='23514'; END IF;
 maximum=(e->>CASE WHEN r='collector' THEN 'guestLimit' ELSE 'employeeLimit' END)::integer;
 SELECT count(*) INTO occupied FROM control.memberships WHERE tenant_id=t AND status='active' AND (role='collector')=(r='collector');
 SELECT count(*) INTO reserved FROM control.invitations WHERE tenant_id=t AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()
 AND (role='collector')=(r='collector') AND (except_invite IS NULL OR id<>except_invite);
 IF occupied+reserved>=maximum THEN RAISE EXCEPTION 'Plan seat limit reached' USING ERRCODE='23514'; END IF; END
$$;
CREATE FUNCTION security.invite_member(t uuid,e text,r text,h text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE result uuid; BEGIN
 IF NOT security.can_admin(t) THEN RAISE EXCEPTION 'Admin required' USING ERRCODE='42501'; END IF;
 IF r NOT IN ('admin','manager','staff','viewer','collector') OR length(h)<>64 OR length(e)>254 THEN RAISE EXCEPTION 'Invalid invitation' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM control.organizations WHERE id=t FOR UPDATE;
 IF EXISTS(SELECT FROM control.memberships m JOIN identity.users u ON u.id=m.user_id WHERE m.tenant_id=t AND lower(u.email)=lower(e) AND m.status='active')
 OR EXISTS(SELECT FROM control.invitations WHERE tenant_id=t AND email=lower(e) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()) THEN
 RAISE EXCEPTION 'This person is already a member or invited' USING ERRCODE='23505'; END IF;
 PERFORM security.assert_seat(t,r);
 INSERT INTO control.invitations(tenant_id,email,role,token_hash,invited_by,expires_at) VALUES(t,lower(e),r,h,security.user_id(),now()+interval '7 days') RETURNING id INTO result;
 PERFORM security.append_audit(t,'member.invited','invitations',result::text,jsonb_build_object('email',lower(e),'role',r)); RETURN result; END
$$;
CREATE FUNCTION security.cancel_invitation(t uuid,i uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF NOT security.can_admin(t) THEN RAISE EXCEPTION 'Admin required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM control.organizations WHERE id=t FOR UPDATE;
 UPDATE control.invitations SET revoked_at=now() WHERE id=i AND tenant_id=t AND accepted_at IS NULL;
 PERFORM security.append_audit(t,'invitation.revoked','invitations',i::text); END
$$;
CREATE FUNCTION security.accept_invitation(h text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE i control.invitations; u identity.users; t uuid; e jsonb; maximum integer; used integer; BEGIN
 SELECT * INTO u FROM identity.users WHERE id=security.user_id() AND email_verified;
 IF u.id IS NULL THEN RAISE EXCEPTION 'Verified sign in required' USING ERRCODE='42501'; END IF;
 SELECT tenant_id INTO t FROM control.invitations WHERE token_hash=h;
 -- Same lock order as invitation creation prevents oversubscribing concurrent acceptances.
 PERFORM 1 FROM control.organizations WHERE id=t AND status='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO i FROM control.invitations WHERE token_hash=h AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() AND email=lower(u.email) FOR UPDATE;
 IF i.id IS NULL THEN RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT FROM control.memberships WHERE tenant_id=t AND user_id=u.id AND status='active') THEN RAISE EXCEPTION 'Already a member' USING ERRCODE='23505'; END IF;
 SELECT CASE WHEN i.role='collector' THEN coalesce(o.guest_limit,p.guest_limit) ELSE coalesce(o.employee_limit,p.employee_limit) END INTO maximum
 FROM control.subscriptions s JOIN control.plan_versions p ON p.id=s.plan_version_id
 LEFT JOIN control.allowance_overrides o ON o.tenant_id=t AND o.expires_at>now()
 WHERE s.tenant_id=t AND (s.status='active' OR s.status='trialing' AND s.trial_ends_at>now());
 SELECT (SELECT count(*) FROM control.memberships WHERE tenant_id=t AND status='active' AND (role='collector')=(i.role='collector'))+
 (SELECT count(*) FROM control.invitations WHERE tenant_id=t AND id<>i.id AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() AND (role='collector')=(i.role='collector')) INTO used;
 IF maximum IS NULL OR used>=maximum THEN RAISE EXCEPTION 'Plan seat limit reached' USING ERRCODE='23514'; END IF;
 INSERT INTO control.memberships(tenant_id,user_id,role) VALUES(t,u.id,i.role) ON CONFLICT(tenant_id,user_id) DO UPDATE SET role=i.role,status='active';
 UPDATE control.invitations SET accepted_at=now() WHERE id=i.id;
 INSERT INTO control.audit_events(tenant_id,actor_id,actor_type,request_id,action,entity_type,entity_id)
 VALUES(t,u.id,'member',current_setting('vayu.request',true),'invitation.accepted','memberships',u.id::text); RETURN t; END
$$;
CREATE FUNCTION security.update_member(t uuid,u uuid,r text,s text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE old_row control.memberships; BEGIN
 IF NOT security.can_admin(t) THEN RAISE EXCEPTION 'Admin required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM control.organizations WHERE id=t FOR UPDATE;
 SELECT * INTO old_row FROM control.memberships WHERE tenant_id=t AND user_id=u FOR UPDATE;
 IF old_row.user_id IS NULL THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='22023'; END IF;
 IF old_row.role='owner' OR r='owner' THEN RAISE EXCEPTION 'Use ownership transfer' USING ERRCODE='42501'; END IF;
 IF s='active' AND (old_row.status<>'active' OR (old_row.role='collector')<>(r='collector')) THEN PERFORM security.assert_seat(t,r); END IF;
 UPDATE control.memberships SET role=r,status=s WHERE tenant_id=t AND user_id=u;
 PERFORM security.append_audit(t,'member.updated','memberships',u::text,jsonb_build_object('role',r,'status',s)); END
$$;
CREATE FUNCTION security.transfer_owner(t uuid,u uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 IF NOT security.provider_scope(t) AND security.member_role(t) IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM control.organizations WHERE id=t FOR UPDATE;
 IF NOT EXISTS(SELECT FROM control.memberships WHERE tenant_id=t AND user_id=u AND status='active' AND role<>'collector') THEN RAISE EXCEPTION 'An active employee is required' USING ERRCODE='23514'; END IF;
 UPDATE control.memberships SET role='admin' WHERE tenant_id=t AND role='owner';
 UPDATE control.memberships SET role='owner' WHERE tenant_id=t AND user_id=u;
 PERFORM security.append_audit(t,'ownership.transferred','memberships',u::text); END
$$;
CREATE FUNCTION security.create_space(t uuid,title_value text,kind_value text,people uuid[]) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE s uuid; u uuid; BEGIN
 IF NOT security.can_edit(t) THEN RAISE EXCEPTION 'Employee access required' USING ERRCODE='42501'; END IF;
 IF cardinality(people)<1 OR cardinality(people)>100 OR length(title_value)>200 THEN RAISE EXCEPTION 'Invalid room participants' USING ERRCODE='22023'; END IF;
 IF kind_value='direct' AND cardinality(people)<>2 THEN RAISE EXCEPTION 'Direct conversations require two participants' USING ERRCODE='22023'; END IF;
 IF NOT security.provider_scope(t) AND NOT security.user_id()=ANY(people) THEN RAISE EXCEPTION 'Creator must be a participant' USING ERRCODE='42501'; END IF;
 FOREACH u IN ARRAY people LOOP
 IF NOT EXISTS(SELECT FROM control.memberships WHERE tenant_id=t AND user_id=u AND status='active') THEN RAISE EXCEPTION 'Participant is not a gallery member' USING ERRCODE='23514'; END IF; END LOOP;
 INSERT INTO app.spaces(tenant_id,title,kind) VALUES(t,title_value,kind_value) RETURNING id INTO s;
 FOREACH u IN ARRAY people LOOP INSERT INTO security.space_grants(tenant_id,space_id,user_id,role)
 VALUES(t,s,u,CASE WHEN u=security.user_id() THEN 'owner' ELSE 'member' END) ON CONFLICT DO NOTHING; END LOOP;
 RETURN s; END
$$;
CREATE FUNCTION security.edit_message(t uuid,m uuid,content text,remove boolean,expected integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 DECLARE old_row app.messages; result jsonb; BEGIN
 SELECT * INTO old_row FROM app.messages WHERE tenant_id=t AND id=m FOR UPDATE;
 IF old_row.id IS NULL OR NOT security.space_write(t,old_row.space_id) OR (old_row.created_by IS DISTINCT FROM security.user_id() AND NOT security.provider_scope(t)) THEN
 RAISE EXCEPTION 'Message access denied' USING ERRCODE='42501'; END IF;
 IF old_row.version<>expected THEN RAISE EXCEPTION 'Message changed; refresh and retry' USING ERRCODE='40001'; END IF;
 INSERT INTO app.record_revisions(tenant_id,entity_type,entity_id,space_id,data) VALUES(t,'messages',m,old_row.space_id,to_jsonb(old_row));
 UPDATE app.messages SET body=CASE WHEN remove THEN '' ELSE content END,edited_at=now(),deleted_at=CASE WHEN remove THEN now() ELSE NULL END WHERE tenant_id=t AND id=m RETURNING to_jsonb(messages) INTO result;
 RETURN result; END
$$;
REVOKE UPDATE ON app.messages FROM vayu_api;
REVOKE ALL ON FUNCTION security.assert_seat(uuid,text,uuid) FROM PUBLIC,vayu_api;
GRANT EXECUTE ON FUNCTION security.entitlements(uuid),security.create_organization(text,text),security.team(uuid),security.invite_member(uuid,text,text,text),
 security.cancel_invitation(uuid,uuid),security.accept_invitation(text),security.update_member(uuid,uuid,text,text),security.transfer_owner(uuid,uuid),
 security.create_space(uuid,text,text,uuid[]),security.edit_message(uuid,uuid,text,boolean,integer) TO vayu_api;
