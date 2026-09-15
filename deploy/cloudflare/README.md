# Vayu-Gallery hosting preparation

This folder prepares **Vayu-Gallery** (`vayu-gallery`) for a deployment that you perform yourself. It does not deploy, log in, create resources, modify DNS, or use the original project's Cloudflare/GitHub access. The example has no account ID, credentials, domain or live resource identifiers.

The production platform still has launch requirements in [production/README.md](../../production/README.md). A successful build is not proof that the whole SaaS is ready to accept paying galleries. In particular, checkout/webhook reconciliation, remaining production module parity, live service integration, concurrency/load tests and backup restoration must be completed before a public paid launch.

## Deployment structure

```text
Browser → your application domain → Cloudflare Worker: vayu-gallery
                                     ├─ public/ (compiled production React interface)
                                     └─ /api, /auth, /site → HTTPS origin protected by Access
                                                                  └─ Node API process
                                                                       ├─ PostgreSQL
                                                                       └─ private R2 bucket
                                                              Node job process
                                                                       ├─ PostgreSQL job leases
                                                                       └─ private R2 bucket
```

The API and job runner are two processes of the same modular application. Host them on a service that supports Node 22.16+ and the native `sharp`/`@napi-rs/canvas` dependencies. This folder does not pretend that those Node processes can be uploaded as a static site or run unchanged inside a Worker. A Cloudflare Containers adaptation would be a separate implementation and validation task.

Use Cloudflare DNS, SSL, CDN and WAF for the application domain. The Worker serves only the production frontend and forwards authenticated requests without caching their responses. It preserves the OIDC redirects, session/CSRF cookies, tenant path, provider context and edit-version headers. It does not make authorization decisions on behalf of the API. The existing PostgreSQL row policies and session checks remain authoritative.

The local SQLite preview (`localhost:4178`, `server/`, root `dist/`) is excluded. Never upload the repository or either server directory as public assets. The packaging command only includes the production entry, compiled JS/CSS and fonts.

## Configure your services

1. Provision a **new production PostgreSQL database**, with backups and tested restoration. Apply `production` migrations using the separate migration owner. Provision different non-superuser logins for `vayu_api`, `vayu_identity` and `vayu_jobs`; runtime logins must not own tables or have `BYPASSRLS`. See the production README for migration and provider-owner bootstrap commands.
2. Host the Node API and the job process. Give both the documented runtime configuration using the host's secret manager; do not add values to this folder. Build using `npm run build` from `production/`; run `npm start` for the API and `npm run start:worker` for jobs, with `production/` as their working directory. Install dependencies for the host's own operating system; do not copy Windows native dependencies onto Linux.
3. Set the API's `APP_ORIGIN` to your **public application origin**, not its internal/origin hostname. Set `NODE_ENV=production`. Register exactly `<APP_ORIGIN>/auth/callback` at your OIDC provider, and configure the actual MFA assurance values. No sample login is shipped in this entry.
4. Expose the API at a separate HTTPS hostname protected by a Cloudflare Access **Service Auth** policy. Create a service token restricted to that application. Ensure every API/auth/site path is protected, disable any unprotected host-provider URL, and restrict direct origin ingress so requests cannot bypass Access. Validate that an unauthenticated direct request is denied before you point the Worker at it. Access is an origin gate; gallery users still authenticate through the application's OIDC provider.
5. Provision a private R2 bucket. Keep public access disabled. Set `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_REGION=auto`, `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY` only on the Node hosts. Scope credentials to the required bucket. Set CORS to your exact public application origin; permit the signed upload/download methods and the headers required by the signed request, including content type and checksum headers. Test a real upload, quarantine verification and signed download. Configure lifecycle/retention without expiring active gallery objects. PDF uploads require the documented document-scanner configuration.
6. Configure the public domain's WAF and rate limiting, monitoring/alerts, backup retention and secret rotation. Do not enable cache-everything rules for `/api/*`, `/auth/*` or `/site/*`. Customer website custom domains require their own verified hostname/certificate activation; this single application-domain entry does not activate them automatically.

The runtime settings are documented in [production/.env.example](../../production/.env.example). That file contains placeholders and is not automatically loaded. Database passwords, OIDC client secret, storage credentials, token-encryption key and scanner token belong only in the selected Node host's secret manager. The current API/jobs use the S3-compatible R2 integration and PostgreSQL job queue; this edge Worker does not require an R2, D1, Hyperdrive or Queue binding.

## Prepare files locally

From `Vayu-Gallery/deploy/cloudflare`, with the project's local dependencies installed:

```powershell
npm test
npm run build
```

`build` rebuilds the **production** entry, copies only allowed files to `public/`, and writes a SHA-256 build manifest outside that public folder. It contacts no Cloudflare service. Rebuild after changing application sources.

Select the new Cloudflare account and copy its Account ID from the dashboard. Supply that ID explicitly along with your three non-secret origins. Replace the values below with your actual selected HTTPS hosts; `.example` placeholders intentionally fail validation:

```powershell
node prepare.mjs --configure --account-id REPLACE_WITH_NEW_ACCOUNT_ID --public-origin https://app.your-domain.example --api-origin https://origin.your-domain.example --storage-origin https://your-signed-storage-host.example
npm run check
```

`PUBLIC_ORIGIN` must match `APP_ORIGIN`. `API_ORIGIN` is the protected Node API hostname. `STORAGE_ORIGIN` is the origin in the **actual signed URLs returned by your storage integration**; confirm it with your R2 configuration, including any bucket subdomain. It becomes the browser's CSP upload allowlist. Supply origins only, without paths, ports or credentials.

The configure command creates `wrangler.jsonc` without overwriting an existing file. Review it yourself. Its Worker name is `vayu-gallery`, its custom-domain route is your application hostname, and `workers.dev` and preview URLs are disabled. This avoids exposing an alternate host with mismatched session/OIDC configuration. No live route is configured until you supply it. The generated account_id pins this project to the account you selected. Preflight rejects an absent account ID or a conflicting CLOUDFLARE_ACCOUNT_ID in your shell. Authenticate using that new account yourself; no existing Cloudflare credentials were copied.

Add these two Worker **secrets**, using Cloudflare's dashboard or your chosen secret-management workflow:

| Worker secret | Value |
| --- | --- |
| `ORIGIN_ACCESS_CLIENT_ID` | The origin Access service-token client ID |
| `ORIGIN_ACCESS_CLIENT_SECRET` | The matching service-token secret |

Do not put either in `vars` or in the frontend. The Worker fails closed when any origin, secret or asset binding is missing. The example file is deliberately not a deployable live configuration.

## Your deployment and release checks

You control Cloudflare authentication and deployment. Use the generated config in **this directory**, not the original project's Wrangler configuration. No GitHub connection is required. The `build.command` in that config runs the local preflight check and refuses missing or altered asset files. Before using the CLI, install a current supported Wrangler version in your own tooling environment and validate the config/types with that version; these local Node tests do not exercise the actual workerd runtime.

After you deploy a staging configuration, verify:

- `/health/live` proves only that the edge function runs. `/health/ready` additionally checks the API's database readiness and the production entry; neither verifies every external integration.
- Real OIDC sign-in/callback/logout, cookie flags and CSRF rejection. Open two separate galleries and verify that files, invoices, catalogs and employee access remain isolated.
- Provider MFA, access expiry and audit attribution; a normal employee cannot open the admin audit log.
- Actual R2 upload/checksum/CORS, quarantine processing, generated PDFs, saved editions and signed downloads. Job retries must not duplicate results or accounting.
- Direct origin requests without the service token fail. Missing configuration fails closed. Private responses do not enter an edge cache.
- Desktop/mobile workflows, configured document addresses/GST details, and all remaining production launch requirements in the production README.

Use an independently configured staging origin/database/bucket/IdP client first. Keep a known-good release and a tested database rollback/forward-fix plan. Do not restore a database blindly after accepting new customer writes.

## Reference documentation

Checked against Cloudflare documentation on 15 September 2026:

- [Workers static asset bindings and routing](https://developers.cloudflare.com/workers/static-assets/binding/) — `ASSETS`, `run_worker_first` and explicit asset routing.
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) — compatibility date, secret storage, streaming and observability.
- [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) — service authentication to a protected origin.
- [R2 CORS configuration](https://developers.cloudflare.com/r2/buckets/cors/) — allowed browser origins, methods and request headers.

Account selection reference: [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#inheritable-keys).
