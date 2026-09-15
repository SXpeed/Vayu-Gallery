# Vayu-Gallery

An independent gallery-management application for desktop and mobile browsers, with its own Git repository and deployment setup.

## Install and run

Use Node.js 22.16 or newer.

1. Run `npm install` in this directory.
2. Run `npm ci --prefix production` to install the API and background-job dependencies.

The production architecture and service configuration are in [production/README.md](production/README.md). Configure a new PostgreSQL database, private R2 bucket, OIDC identity provider and Node hosting before running the production API.

- `npm run build`: compile the production API, job runner and authenticated frontend.
- `npm --prefix production start`: start the configured production API.
- `npm --prefix production run start:worker`: start background jobs.
- `npm run dev:platform`: develop the production frontend against the API on port 4180.
- `npm run dev:preview`: run the separate passwordless sample preview on port 4178.
- `npm run build:preview`: build that local preview only.

The sample preview must stay local. It is not the public SaaS entry and its sample identities are not production login credentials. No dependencies are resolved from the original application.

## Features and validation

The project retains the catalog designer, multiple artwork images and continuation-page layouts, customers/enquiries, invoices/proforma invoices with addresses and GSTINs, private rooms, messaging and provider/organization flows. [Feature parity](production/FEATURE-PARITY.md) distinguishes connected production modules from the full local preview.

Run `npm test`, `npm run test:production`, `npm run check:production` and `npm run test:hosting`.

## GitHub

The private repository is [SXpeed/Vayu-Gallery](https://github.com/SXpeed/Vayu-Gallery), with `main` as its default branch. This directory connects only to that repository; its Git history is separate from the previous app.

Existing Git history, saved application data, logins, node_modules, generated bundles, live environment files and Cloudflare account settings were excluded. Sample fixtures in source are retained for local development and tests.

## Separate Cloudflare account

Use only the intended new Cloudflare account. The Worker/project slug is **vayu-gallery**. Follow the [Cloudflare setup guide](deploy/cloudflare/README.md).

Run `npm run prepare:cloudflare` to create the production asset package locally. Configure your own public application origin, protected Node API origin and signed-storage origin using that guide. Live Wrangler config, account secrets and generated assets are excluded from Git. The checked-in Wrangler example contains no account ID or live domain.

The GitHub deployment instructions use Cloudflare Workers Builds; the build installs both dependency sets and deploys only after the new account and backend origins are configured. The API and image/PDF job processes need Node hosting; uploading the frontend alone is not a complete hosted app. Remaining public SaaS launch requirements, including payment/subscription integrations and live-service checks, are documented in the production README.

