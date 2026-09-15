import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, Building2, Check, ChevronRight, Leaf, LogOut, Plus, ShieldCheck, X } from 'lucide-react';
import { Avatar, Button, Modal } from './lib.jsx';
import { createPlatformClient } from './platform-client.mjs';
import './platform-auth.css';

const INVITATION_KEY = 'vayu.pending-invitation';
const VALID_INVITATION = /^[A-Za-z0-9_-]{32,128}$/;
function clearInvitation() { try { sessionStorage.removeItem(INVITATION_KEY); } catch { /* Browser storage may be disabled. */ } }
function pendingInvitation() {
  const token = location.hash.match(/^#\/invite\/([A-Za-z0-9_-]{32,128})$/)?.[1];
  if (token) {
    try { sessionStorage.setItem(INVITATION_KEY, token); } catch { /* It remains in component memory for this visit. */ }
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return token;
  }
  try { const saved = sessionStorage.getItem(INVITATION_KEY); return VALID_INVITATION.test(saved || '') ? saved : null; } catch { return null; }
}
function Brand() { return <div className="platform-brand"><span><Leaf size={27} strokeWidth={1.3}/></span><strong>vayu<span>.</span><small>A PLACE FOR YOUR GALLERY</small></strong></div>; }
function ErrorNotice({ error, onDismiss }) {
  if (!error) return null;
  return <div className="platform-error" role="alert"><div><strong>{error.message || 'This request could not be completed.'}</strong>{error.code === 'PROVIDER_MFA' && <a href="/auth/login">Verify your identity again<ArrowRight size={15}/></a>}{error.requestId && <small>Support reference: {error.requestId}</small>}</div>{onDismiss && <button className="icon-button" aria-label="Dismiss error" onClick={onDismiss}><X size={17}/></button>}</div>;
}

export function ProductionShell({ renderWorkspace }) {
  const clientRef = useRef(null);
  if (!clientRef.current) clientRef.current = createPlatformClient();
  const client = clientRef.current;
  const [session, setSession] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(null);
  const [gallery, setGallery] = useState(null), [providerAccessId, setProviderAccessId] = useState(null);
  const [invitation, setInvitation] = useState(pendingInvitation), [busy, setBusy] = useState(false);
  const [providerItems, setProviderItems] = useState([]), [providerLoading, setProviderLoading] = useState(false), [tab, setTab] = useState('galleries');
  const [createOpen, setCreateOpen] = useState(false), [accessGallery, setAccessGallery] = useState(null);
  const lifecycle = useRef(0);

  const report = failure => {
    if (failure?.code === 'SCOPE_CHANGED' || failure?.name === 'AbortError') return;
    if (failure?.status === 401) { client.selectGallery(null); setSession(null); setGallery(null); setProviderAccessId(null); }
    setError(failure);
  };
  const reloadSession = async () => { const value = await client.session(); setSession(value); return value; };
  useEffect(() => {
    let active = true;
    const current = ++lifecycle.current;
    client.session().then(value => { if (active) setSession(value); }).catch(failure => {
      if (active && failure.status !== 401) setError(failure);
    }).finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      // React StrictMode performs an immediate setup after its rehearsal cleanup.
      queueMicrotask(() => { if (lifecycle.current === current) client.dispose(); });
    };
  }, [client]);
  useEffect(() => {
    if (!session?.provider || tab !== 'provider') return;
    const controller = new AbortController();
    setProviderLoading(true);
    client.request('/api/provider/organizations', { signal: controller.signal }).then(value => setProviderItems(value.items || [])).catch(report).finally(() => { if (!controller.signal.aborted) setProviderLoading(false); });
    return () => controller.abort();
  }, [client, session?.id, session?.provider, tab]);

  const choose = (organization, accessId = null) => {
    client.selectGallery(organization.id, accessId);
    setError(null); setGallery(organization); setProviderAccessId(accessId);
  };
  const switchGallery = async () => {
    const accessId = providerAccessId;
    client.selectGallery(null); setGallery(null); setProviderAccessId(null); setBusy(true); setError(null);
    try {
      if (accessId) await client.request(`/api/provider/access/${accessId}/close`, { method: 'POST', body: {} });
      await reloadSession();
    } catch (failure) { report(failure); } finally { setBusy(false); }
  };
  const signOut = async () => {
    clearInvitation(); setInvitation(null); setBusy(true); setError(null);
    try { await client.logout(); setGallery(null); setProviderAccessId(null); setSession(null); }
    catch (failure) { setGallery(null); setProviderAccessId(null); report(failure); }
    finally { setBusy(false); }
  };
  const accept = async () => {
    setBusy(true); setError(null);
    try {
      const result = await client.request('/api/invitations/accept', { method: 'POST', body: { token: invitation } });
      clearInvitation(); setInvitation(null);
      const updated = await reloadSession();
      const joined = updated.organizations?.find(item => item.id === (result.tenantId || result.tenantid));
      if (joined) choose(joined);
    } catch (failure) { report(failure); } finally { setBusy(false); }
  };

  if (loading) return <div className="platform-loading"><Brand/><span className="platform-loading-line"/><p>Opening your gallery workspace…</p></div>;
  if (session && gallery) return <><div className="platform-workspace-notice"><ErrorNotice error={error} onDismiss={() => setError(null)}/></div>{renderWorkspace({ client, session, gallery, providerAccessId, onSwitchGallery: switchGallery, onSignOut: signOut })}</>;
  return <div className="platform-page"><header className="platform-header"><Brand/>{session ? <div className="platform-account"><Avatar user={session}/><span>{session.name}<small>{session.email}</small></span><Button variant="ghost" icon={LogOut} busy={busy} onClick={signOut}>Sign out</Button></div> : <span className="platform-header-note"><ShieldCheck size={16}/>Your gallery, securely connected</span>}</header>
    <main className={session ? 'platform-chooser' : 'platform-welcome'}>
      {!session ? <><section className="platform-welcome-copy"><span className="eyebrow">THE ART OF WORKING TOGETHER</span><h1>Your art.<br/>Your people.<br/><em>Room to grow.</em></h1><p>A thoughtful home for your collection, your collectors, and everything that brings them together.</p><ErrorNotice error={error} onDismiss={() => setError(null)}/>{invitation && <div className="platform-invitation-note"><Check size={18}/><span>Your gallery invitation is ready. Sign in with the email address that received it.</span></div>}<a className="button platform-signin" href="/auth/login">Sign in securely<ArrowRight size={18}/></a><small className="platform-auth-explainer">Continue with your identity provider. Your password stays with them.</small></section><div className="platform-welcome-art" aria-hidden="true"><div className="platform-art-arch"/><div className="platform-art-disc"/><div className="platform-art-frame"/><span>A LITTLE MORE SPACE TO CREATE</span></div></> : <>
        <div className="platform-chooser-heading"><div><span className="eyebrow">WELCOME BACK, {session.name?.split(' ')[0]?.toUpperCase() || 'GALLERY TEAM'}</span><h1>A place to begin.</h1><p>Choose a gallery to open its workspace.</p></div><Button icon={Plus} disabled={busy} onClick={() => setCreateOpen(true)}>Create gallery</Button></div>
        <ErrorNotice error={error} onDismiss={() => setError(null)}/>
        {invitation && <div className="platform-invitation-note"><div><strong>You have a gallery invitation</strong><p>Accept using {session.email}. Your verified email must match the invitation.</p></div><Button busy={busy} onClick={accept}>Accept invitation<ArrowRight size={16}/></Button><Button variant="ghost" disabled={busy} onClick={() => { clearInvitation(); setInvitation(null); }}>Dismiss</Button></div>}
        {session.provider && <nav className="platform-tabs" aria-label="Organization access"><button className={tab === 'galleries' ? 'active' : ''} onClick={() => setTab('galleries')}>My galleries</button><button className={tab === 'provider' ? 'active' : ''} onClick={() => setTab('provider')}><ShieldCheck size={16}/>Provider console</button></nav>}
        {tab === 'provider' && session.provider && <p className="platform-provider-note">Provider access includes private gallery content. Opening a workspace records your identity and reason in its activity log.</p>}
        {providerLoading && tab === 'provider' ? <p className="platform-inline-loading" role="status">Loading organizations…</p> : <div className="platform-gallery-grid">{(tab === 'provider' && session.provider ? providerItems : session.organizations || []).map(item => <button className="platform-gallery-card" key={item.id} disabled={busy || tab !== 'provider' && item.status !== 'active'} onClick={() => tab === 'provider' ? setAccessGallery(item) : choose(item)}><span className="platform-gallery-mark"><Building2 size={25} strokeWidth={1.3}/></span><strong>{item.name}</strong><small>{tab === 'provider' ? 'Provider access' : (item.role || 'Member')}<span>·</span>{item.status}</small><span className="platform-gallery-open">{tab === 'provider' ? 'Manage organization' : item.status === 'active' ? 'Open workspace' : 'Access is paused'}<ChevronRight size={17}/></span></button>)}</div>}
        {!providerLoading && (tab === 'provider' ? !providerItems.length : !session.organizations?.length) && <div className="platform-empty"><Building2 size={34} strokeWidth={1}/><h2>{tab === 'provider' ? 'No organizations yet' : 'Your next chapter starts here'}</h2><p>{tab === 'provider' ? 'New gallery organizations will appear here.' : 'Create your gallery or accept an invitation from your team.'}</p></div>}
        {tab === 'provider' && providerItems.length >= 100 && <p className="platform-list-limit">Showing the latest 100 organizations.</p>}
      </>}
    </main><footer className="platform-footer"><span>VAYU · GALLERY WORKSPACE</span><span>Made for the art of everyday.</span></footer>
    {createOpen && <CreateGallery client={client} onClose={() => setCreateOpen(false)} onCreated={async id => { setCreateOpen(false); const updated = await reloadSession(); const created = updated.organizations?.find(item => item.id === id); if (created) choose(created); }} onError={report}/>}
    {accessGallery && <ProviderAccess gallery={accessGallery} client={client} onClose={() => setAccessGallery(null)} onGranted={id => { const item = accessGallery; setAccessGallery(null); choose(item, id); }} onError={report}/>}
  </div>;
}

function CreateGallery({ client, onClose, onCreated, onError }) {
  const [name, setName] = useState(''), [slug, setSlug] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const editedSlug = useRef(false);
  return <Modal title="Create your gallery" onClose={busy ? () => {} : onClose}><form className="platform-dialog-form" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError(null);
    try { const result = await client.request('/api/organizations', { method: 'POST', body: { name: name.trim(), slug } }); await onCreated(result.id); }
    catch (failure) { setError(failure); if (failure.status === 401) onError(failure); } finally { setBusy(false); }
  }}><p>A separate workspace for your artwork, your team, and your gallery website.</p><label>Gallery name<input autoFocus required minLength={2} maxLength={120} value={name} onChange={event => { const value = event.target.value; setName(value); if (!editedSlug.current) setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 63)); }}/></label><label>Gallery address<input required minLength={3} maxLength={63} pattern="[a-z0-9][a-z0-9-]{1,61}[a-z0-9]" value={slug} onChange={event => { editedSlug.current = true; setSlug(event.target.value.toLowerCase()); }} aria-describedby="platform-slug-help"/><small id="platform-slug-help">3–63 lowercase letters, numbers or hyphens. Start and finish with a letter or number.</small></label><ErrorNotice error={error}/><footer><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button busy={busy}>Create gallery<ArrowRight size={16}/></Button></footer></form></Modal>;
}
function ProviderAccess({ gallery, client, onClose, onGranted, onError }) {
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(null);
  return <Modal title={`Open ${gallery.name}`} onClose={busy ? () => {} : onClose}><form className="platform-dialog-form" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError(null);
    try { const result = await client.request('/api/provider/access', { method: 'POST', body: { tenantId: gallery.id, reason: reason.trim() } }); onGranted(result.id); }
    catch (failure) { setError(failure); if (failure.status === 401) onError(failure); } finally { setBusy(false); }
  }}><p>Your provider access includes gallery records, messages and private rooms. Actions remain attributed to you.</p><label>Reason for access<textarea autoFocus required minLength={8} maxLength={500} rows={4} value={reason} placeholder="For example, helping the gallery update its catalog" onChange={event => setReason(event.target.value)}/></label><small>Include the support purpose. Avoid passwords or other sensitive information.</small><ErrorNotice error={error}/><footer><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button busy={busy} icon={ShieldCheck}>Open workspace</Button></footer></form></Modal>;
}
