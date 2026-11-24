# VK LeadBot

Independent VK community lead-generation and affiliate-offer administration project.

## Current application

The Replit entrypoint restores the original catalogue bundle and starts the maintained server-v2 application when present. The original research datasets remain unchanged.

Included:
- Russian-language responsive admin dashboard: overview, bot scenario, offers, leads, CSV import, campaigns, sources, analytics, integrations and settings.
- SQLite import of 123 researched offer records and official brand assets.
- Separate public terms and editable CPA URL, ERID and internal note fields. Every offer stays draft and disabled.
- CSV audience import with deduplication and evidence fields for personal-data consent, advertising consent and VK message permission.
- Campaign drafts, eligibility preview, dry-run simulation and recipient decision logs.
- Unsubscribe and suppression handling.
- Password-protected admin session, rate-limited login, same-origin mutation checks and production Secure cookie.

## Safety boundaries

- Real VK delivery is hard-disabled in server-v2. The campaign send endpoint returns HTTP 423. Dry-run only calculates and records eligibility; it sends zero messages.
- No group-member scraping, cold bulk messages, VK permission bypass or live VK Ads launch.
- A phone number or imported row is not consent evidence. Eligibility requires a VK ID, separate personal-data consent with timestamp and evidence source, separate advertising consent with timestamp and evidence source, VK message permission with timestamp and evidence source, and no unsubscribe or suppression.
- Unknown CPA URLs, ERID values, rates and campaign terms remain empty. Public research is not legal approval.
- Do not commit VK tokens, secrets or personal lead data. Add credentials only through protected Replit Secrets after separate review.

## Run

Requirements: Node.js 22+.

Set a unique ADMIN_PASSWORD in the environment, then start with node bootstrap.mjs. Open the Replit preview or http://localhost:3000.

CI restores the original catalogue bundle, runs tests from test-v2 and starts server-v2 to check that all 123 offers are imported as drafts.

## CSV columns

vk_user_id, phone, source, personal_data_consent, personal_data_consent_at, personal_data_consent_source, advertising_consent, advertising_consent_at, advertising_consent_source, vk_messages_allowed, vk_messages_allowed_at, vk_messages_allowed_source.

A true consent is accepted only with matching timestamp and evidence source. False revokes the corresponding permission. Blank values do not upgrade permissions. Do not import data without a documented lawful basis.

## Supplied research

- research/official-offer-enrichment-2026-11-22.json — 123 enriched source records.
- research/official-brand-assets-2026-11-22.json — official logo and image references.

Research checked on 2026-11-22; manual legal and campaign-specific validation remains required.
