# Operations and release gates

This runbook describes configuration still to perform on **new, explicitly selected services**. It is not evidence that the controls have been provisioned. Do not run against the existing application's Cloudflare, GitHub, database or deployment credentials.

## Database and recovery

- Use managed PostgreSQL with encryption, automatic daily backups and point-in-time recovery. Select retention and geography with the provider/customer requirements; proposed starting targets are RPO 15 minutes and RTO 4 hours, subject to a measured restore drill.
- Provision a migration owner and three independent runtime logins. Each runtime login may assume only its matching `vayu_api`, `vayu_identity` or `vayu_jobs` role. Never give runtime identities ownership, superuser, `CREATEROLE` or `BYPASSRLS` privileges.
- Run checksummed migrations once through a release job. Take/verify recovery coverage before destructive schema changes. Prefer expand/backfill/contract migrations; never edit an applied SQL file to change its checksum.
- Perform a full database + object recovery drill into an isolated environment. Verify tenant isolation, media checksums, invoice/catalog version references and audit retention before reopening traffic. Recovery must not re-enable revoked credentials or resurrect disabled provider access.
- Audit history is append-only to runtime roles. Database administrators remain an operational trust boundary; independent append-only log export/WORM retention is still required if tamper evidence against database operators is a business requirement.

## Private storage

- Keep the bucket private, deny anonymous access and scope access credentials to this application's bucket. Configure CORS for the exact application origin, PUT and required content/checksum headers. Do not allow wildcard origins with cookies.
- Configure expiry of abandoned quarantine objects and reconcile reserved storage for incomplete uploads. Add orphan cleanup for objects written before a database failure. These scheduled cleanup handlers are not yet implemented.
- Decide archive/original-image retention separately from sanitized delivery copies. Do not treat R2 durability as an independent backup; keep an encrypted recovery copy/inventory in an independently controlled destination.
- Configure and test the PDF scanner before accepting uploaded catalogs/documents in production. Missing scanner configuration leaves PDFs quarantined. Test malformed/polyglot files, oversized images, checksum mismatch and upload URL replay against the actual storage provider.
- The verifier adapter uses `DOCUMENT_SCANNER_URL` and `DOCUMENT_SCANNER_TOKEN` together. It POSTs PDF bytes with `Content-Type: application/pdf` and bearer service authorization to an operator-selected HTTPS endpoint. The service must return `application/json` with exactly `{"verdict":"clean"}` or `{"verdict":"infected"}`; outages, redirects, malformed or oversized replies fail closed. Requests time out after 30 seconds. Select the verifier's file retention and geography explicitly before setting these variables; no verifier is contacted by default. Provide the same settings to the API and worker.

## Identity and provider support

- Configure the real OIDC issuer, registered callback, verified-email policy and account recovery. Require MFA for provider staff and consider it for gallery owners. Test the exact ACR emitted by the chosen IdP; no generic `amr` flag from the browser grants provider access.
- Bootstrap the first provider only from an existing verified identity using the offline operator command. Review access reasons and export provider activity to an independently monitored destination.
- Rotate database/storage/client credentials and the encryption key through a versioned secret-management procedure. Existing encrypted login attempts and pending invitation payloads require a key transition/migration strategy, not a silent key replacement.
- Configure logout/back-channel revocation integration and user session management before general availability. Local session expiry/revocation is implemented; upstream identity suspension is not yet pushed automatically into existing sessions.

## Hosting and custom domains

- Deploy the API behind Cloudflare with managed SSL, WAF rules, DDoS protection and edge rate limits for authentication, uploads and public routes. Block direct origin access. Use a supported Node/serverless runtime and managed database pooling; native image/PDF jobs run separately.
- Set cache rules by surface: private APIs and preview data are `no-store`; published images are briefly cacheable. Add cache purge when unpublishing, suspending a gallery or revoking public media.
- A custom domain remains pending until its TXT challenge matches, routing is provisioned and the certificate is active. A successful DNS challenge alone does not activate public service. Certificate/custom-hostname provisioning and renewal handlers are still to be integrated with the newly chosen Cloudflare configuration.

## Monitoring and workload controls

- Collect structured `http.request`, `http.error` and `job.completed` events. Never ingest cookies, authorization headers, request bodies, tokens, signed URLs, customer messages or connection strings.
- Alert on error rate, latency, database pool saturation, failed logins, provider access anomalies, oldest pending job, dead-letter count and storage accounting mismatches. `/health/live` checks process life; `/health/ready` currently checks database connectivity, not full external dependency health.
- Current rate buckets are a baseline. Add trusted edge IP throttling, active-session limits, periodic expired bucket/session/login-attempt cleanup and monitoring of abusive signup/invite traffic.
- Before high-volume use, add per-gallery fair queue scheduling, lease heartbeats for long jobs, graceful bounded shutdown, failure-state reconciliation for catalog status, and dead-letter replay controls. Never retry a payment/email/webhook without an idempotency contract with its destination.

## Test gate

1. `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run build` in this directory.
2. Run the legacy suite and frontend build in the parent redesign directory.
3. Use an actual disposable PostgreSQL service to test simultaneous seat reservations, invitation acceptance, artwork sale/reservation locking, job claims, migration locking and pooled-connection context cleanup. PGlite tests are single-connection and do not establish live lock behavior.
4. Validate the real OIDC provider and R2/S3 bucket, including email verification/MFA failures, session revocation, bucket CORS, checksum signing and short-lived URLs.
5. Complete browser E2E, accessibility, mobile layouts, load tests, security review and recovery drill after connecting the UI and remaining workflows.
6. Do not describe the system as production-ready until these gates and the missing functionality in README are complete. Deployment requires explicit authorization.
