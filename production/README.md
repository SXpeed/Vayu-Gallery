# Vayu production platform

This is the PostgreSQL platform and separate authenticated React workspace for the production rebuild. It is **not yet a launch-ready SaaS**. Port 4178 remains the full local feature preview. The production entry point connects to the real resource APIs and has no sample-data fallback. No customer data was migrated, no external services were configured, and nothing was deployed.

The implementation establishes the requested schema, tenancy, identity, storage, durable jobs and module boundaries before migrating the rest of the features. It has no sample-login endpoint, SQLite fallback, default password, or seeded customer data. Missing configuration stops startup.

## Implemented and tested

- Eight ordered, checksummed PostgreSQL migrations, with advisory locking and transactional application.
- Normalized gallery data, composite tenant foreign keys, forced row-level security, separate runtime/identity/job database roles, and transaction-local identity and tenant context.
- OIDC authorization code flow with PKCE, nonce, state, JWT signature validation, verified email, fresh authentication, hashed database sessions, encrypted temporary verifiers, HTTP-only session cookies, CSRF and origin checks.
- Multiple gallery memberships per identity, role checks, four versioned plans, reserved invitation seats, verified invitation acceptance, ownership transfer and suspension enforcement.
- Provider access without customer membership or employee-seat use. Provider MFA, explicit gallery scope, expiry, revocation and audit attribution. Private messages retain their original author and protected revision history after provider edits.
- Validated artist, artwork, location, collection, exhibition, contact, enquiry, catalog, task and website-draft API operations. Updates use `If-Match` versions; supported business records can be archived/restored.
- R2/S3 signed uploads and short-lived downloads, tenant-prefixed immutable delivery keys, upload quarantine, byte checksums, image decode/re-encoding, pixel limits and storage accounting. Uploaded PDFs remain quarantined until a document scanner is configured.
- Durable PostgreSQL jobs with `SKIP LOCKED`, leases, fencing tokens, bounded attempts, backoff, dead-letter state and idempotency. Workers can only access the gallery of their current lease.
- Background image processing and PDF generation. The PDF worker reuses the existing catalog renderer, including templates, gradients, fonts, logo size/placement, hidden fields and image layout controls; generated versions are saved in the library.
- Multiple artwork images and display/banner selection, private direct/group/collector spaces, messaging, administrator audit history and provider organization controls.
- Website drafts, authenticated preview data, explicit artwork selection, immutable release snapshots, responsive HTML, SEO fields and allowlisted public image delivery. Private inventory, prices hidden by the gallery, contacts and business records never enter a public release.
- Custom-domain ownership challenges and a DNS verification worker. Verification does **not** activate a hostname or claim that a certificate exists.
- Structured request/job logs without bodies or credentials, request IDs, health endpoints, error mapping, application rate buckets and database-backed integration tests.
- Production sign-in, verified invitation landing, gallery creation/switching and reason-based provider access. Aborting a request on a gallery switch also invalidates later upload/save continuations from the previous workspace.
- Separate Catalog Library and Designer lists with server pagination/search. Ordered artwork selections and personal drafts persist in PostgreSQL; stale drafts cannot overwrite newer saves. The existing designer's templates, logo controls, gradients, typography, image adjustments and background-removal tool use scoped production media and save operations.
- Artwork creation, bulk/camera image intake, image reordering, separate display/banner choices, background generation, stored PDF editions and catalog archival. Gallery administrators/provider staff can inspect audit details; other employees see processing status.
- Direct-conversation participants cannot change. Quarantine cleanup is retried after media finalization without charging storage twice.

## Run locally against your own new services

Use Node 22.16 or later, PostgreSQL 17/18, a private R2/S3 bucket and an OIDC provider. Use a separate disposable PostgreSQL database for integration/staging validation. Neither the existing project's environment files nor its deployment configurations are loaded.

```powershell
cd D:\Webapp\Vayu-Gallery\production
npm ci --ignore-scripts
npm run check
npm test
npm run build
```

Set the variables documented in `.env.example` through your environment or secret manager. The example file is documentation, not a credential file, and is never loaded automatically. For local PostgreSQL without TLS, `NODE_ENV=development` permits only a loopback database hostname. Production database connections verify TLS; `PG_CA_FILE` supports a private CA.

Run `npm run migrate` **only against a newly selected database** using `MIGRATION_DATABASE_URL`. Migrations create the non-login roles `vayu_api`, `vayu_identity` and `vayu_jobs`. A database operator must provision separate login credentials with membership in exactly their corresponding role. The migration owner must not be a runtime login, and runtime logins must not be superusers, table owners or have `BYPASSRLS`.

Then use `npm start` for the API and compiled production workspace (default port 4180), and `npm run start:worker` for the job runner. Open `APP_ORIGIN` to sign in. The public website path is `/site/<gallery-slug>/<page-slug>`. The build serves only its compiled entry, assets and fonts; unknown API routes do not fall back to HTML or source files.

For frontend development, run `npm run dev:platform` from the Vayu-Gallery root folder. This loopback Vite server uses port 4182 and proxies only `/api` and `/auth` to the production API at 4180. Set `APP_ORIGIN=http://127.0.0.1:4182` and register that exact callback when using this arrangement. The normal `npm run dev` remains the separate preview on 4178. The two clients never share a data adapter.

Register the exact OIDC callback `<APP_ORIGIN>/auth/callback`. Configure the provider's MFA policy and set `OIDC_MFA_ACR` to the exact assurance values it emits after MFA. The first provider owner must already have a verified identity, then be assigned with the offline `bootstrap:provider` command. There is no HTTP self-promotion endpoint.

## API conventions

All business routes are under `/api/galleries/:tenant/...`. This path is a requested scope, not proof of access. Identity always comes from the validated server session. Set `X-CSRF-Token` to the CSRF cookie for mutations, use JSON bodies, and send `If-Match: <version>` for edits, archive/restore and catalog generation.

Provider staff first call `POST /api/provider/access` with a gallery ID and reason; subsequent requests include the returned ID in `X-Provider-Access`. A context cannot be reused for another gallery, identity or session. Access evidence commits before the business transaction, so a failed edit cannot erase the access record.

Lists use bounded pages. Resource list cursors have `before` (timestamp) and `after` (UUID), returned together in `next`. Audit pagination uses its monotonic `before` ID. The feature API, validation and service contracts live in `src/http/app.ts` and `src/modules`; SQL remains outside UI components.

## Still required before production launch

1. Finish connecting the remaining workspace modules, team administration, provider plan management, website CMS and private messaging/rooms. The production Catalog/Artwork/Activity slice and verified sign-in are connected; the other full interfaces remain in the local preview. Preserve [FEATURE-PARITY.md](FEATURE-PARITY.md).
2. Finish transactional offers/orders, reservations, payments, delivery, analytics, API-key authorization and integration management. Invoices and proforma invoices now support draft editing, addresses/GSTIN, immutable issuance and PI conversion; payment-provider settlement and jurisdiction-specific tax integrations still require implementation. The other full interfaces remain available in the local preview.
3. Select and integrate a payment provider: checkout, signed webhooks, replay protection, subscription reconciliation and plan changes. Paid subscriptions cannot be activated by a browser request. Plan prices and tax rules are not invented.
4. Configure an email transport and implement its job handler; select/configure the implemented document-verification adapter, and implement bulk import and webhook delivery workers. Unsupported jobs retry visibly and reach dead-letter state; they are never acknowledged as successfully processed. No emails were sent during this work.
5. Configure new hosting, database, identity, storage, Cloudflare DNS/CDN/WAF/custom-hostname certificates, shared edge rate limits, bucket CORS/lifecycle and secret rotation. These require separately selected services and deployment authorization. No existing Cloudflare/GitHub account or Wrangler configuration has been used.
6. Exercise live PostgreSQL contention, the actual IdP, actual S3/R2 signatures, load tests, backup restoration, monitoring/alerts, browser accessibility and full workflow tests. The current SQL integration suite uses PGlite, an embedded PostgreSQL engine with one connection; it proves SQL/policy behavior, not production concurrency or capacity.

See [ARCHITECTURE.md](ARCHITECTURE.md) and [OPERATIONS.md](OPERATIONS.md) for boundaries, scaling and release requirements.

## Validation recorded on 13 September 2026

- 48 backend checks passed, including catalog ordering, stale drafts, cross-gallery selections, private media, provider access, direct-message membership and quarantine retry cleanup.
- 82 existing local checks and 12 production-client checks passed. Both frontend entries and the API/worker build compile.
- An explicitly enabled, temporary loopback fixture exercised the compiled production UI with the real API, PGlite policies and job runner. Browser checks covered gallery selection, catalog save, asynchronous PDF generation, saved editions in Library, bulk upload of two synthetic images and persisted display/banner choices. The 390px mobile Library layout was inspected.
- The next mobile editor check and browser viewport cleanup were blocked by browser-tool usage limits. Full mobile/editor accessibility and real external-service tests remain release gates.

The optional `tests/browser-server.ts` requires `VAYU_BROWSER_TEST=1`, binds only to 127.0.0.1:4183 and uses disposable in-memory fixtures. It is excluded from runtime bundles and must never be used as a public app or authentication mechanism.

## Invoices and Cloudflare preparation — 15 September 2026

The production workspace includes **Invoices & PI**. Both document types keep seller/customer names, multiline addresses and optional GSTINs. Drafts are editable; issuing allocates a tenant-scoped document number and freezes party and line-item snapshots. An issued PI converts idempotently to a separate invoice draft, and is excluded from payable documents and sales. GSTIN validation checks format only; it does not verify registration or calculate jurisdiction-specific tax treatment. Prices use integer currency minor units and tax rates use basis points with per-line rounding. Users can choose Print / Save PDF to use their browser's print workflow.

The API lives at `/api/galleries/:tenant/invoices` with draft create/update, issue, convert, detail, list and customer/artwork selectors. Migration `009_invoice_documents.sql` adds tenant-scoped line items, document sequences, access controls and immutable issued snapshots. Owner/admin/manager/staff roles and scoped provider access can work with invoices; collector access is denied.

Validation: 66 production tests pass, including 14 invoice checks, and TypeScript/build checks pass. Browser verification exercised PI creation, issuance, conversion and invoice issuance with preserved addresses/GSTINs and matching totals. PGlite does not prove live PostgreSQL contention, and the browser print dialog still requires a user-selected printer/PDF destination.

The [Vayu-Gallery Cloudflare preparation guide](../deploy/cloudflare/README.md) provides an isolated `vayu-gallery` Worker/static-assets package and secure proxy configuration. It requires your selected public/API/storage origins and backend services. It does not deploy or configure your account, and it excludes the local preview.
