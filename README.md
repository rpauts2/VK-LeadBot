# VK LeadBot

Independent VK affiliate lead-generation project. This repository is separate from Bonvera.

## Current milestone

The current working milestone is the **admin offer catalogue**. It restores a small Node.js application from the committed source bundle, imports the research datasets into SQLite, and provides search, filters and an offer detail editor.

The app deliberately keeps every offer in `draft` and `public_bot_eligible = false`. Broker/aggregator/KPK records remain distinct from MFO/MKK/MFK lenders. Public website terms are stored separately from campaign-specific CPA terms, URL and ERID fields.

The VK bot, real callback integration, lead collection, CPA postbacks and advertising workflows are not connected yet. The application has not been published.

## Run locally

Requirements: Node.js 22 or newer.

```bash
cp .env.example .env
# Set a unique, long ADMIN_PASSWORD in .env
npm start
```

Open `http://localhost:3000`.

Without `ADMIN_PASSWORD`, the catalogue is read-only. Never commit `.env`, credentials, VK tokens, CPA secrets or personal lead data.

## Source restore and checks

`bootstrap.mjs` restores the app source from `.bundle/part-*.b64` and starts the server. The GitHub Actions workflow runs the restore step, `npm test` and `npm run check` on pushes and pull requests.

## Research datasets

- `research/official-offer-enrichment-2026-11-22.json`: 123 researched offer records with public terms, sources, confidence and notes.
- `research/official-brand-assets-2026-11-22.json`: 66 official image/brand asset mappings.

The research is not advertising or legal approval. Missing fields remain unknown. The research does not replace the original CPA campaign URLs or ERID values; those must be supplied and checked separately against the active campaign in the affiliate account.

## Before any public use

Verify every lender's current legal identity and Bank of Russia status, campaign availability and permitted VK placement, exact campaign-specific amount/term/rates/PSK/promotional limitations, ERID and legally required advertising disclosures. Verify the legal basis for personal-data processing and transfer, and keep advertising consent separate from processing consent. Messaging must only be sent where the recipient has the required prior advertising consent and VK permission.

No offer should be activated and no advertising or bulk messaging should be started without a separate approval.
