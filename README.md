# VK LeadBot

Independent VK community lead-generation and affiliate-offer administration project.

## Current application

The Replit entrypoint restores the original catalogue bundle and starts the maintained server-v2 application when present. The original research datasets remain unchanged.

Included:
- Russian-language responsive admin dashboard: overview, bot scenario, offers, leads, CSV import, campaigns, sources, analytics, integrations and settings.
- SQLite import of 123 researched offer records and official brand assets.
- Draft partner showcase seeded with 129 user-provided Bit-do links; 128 are visible for review, one (ЖелДорЗайм) is excluded because the Bank of Russia records it as no longer active and notes removal from the MFO register on 2020-01-27.
- CPA showcase has an admin review page. A link can be enabled only after the admin supplies the advertiser's legal name and HTTPS site and confirms the partner terms and ERID. The startup import preserves approvals only while the underlying CPA URL and ERID stay unchanged.
- CSV audience import retained for legacy/testing; it is not the user-facing offer-request flow.
- Request-led VK bot dialogue: greeting, “Получить предложения” button, short phone-use notice, phone capture and offer response. It only processes a private message initiated by the user; Callback event IDs are deduplicated.
- No separate consent screens, in-bot unsubscribe screen, STOP command or stored consent-event history. Existing consent-history table is removed on startup. VK message-denial and user-block events are still respected.
- Password-protected admin session, rate-limited login, same-origin mutation checks and production Secure cookie.

## Safety boundaries

- Bulk campaign delivery remains hard-disabled: the campaign send endpoint returns HTTP 423, and dry-run sends zero messages. One-to-one bot replies are a separate feature, disabled by default, and can only be enabled with a community token plus `VK_BOT_REPLIES_ENABLED=true`. The bot responds only to a user's inbound private message.
- The public `/api/vk/callback` endpoint validates the configured community ID and secret, responds to VK's confirmation challenge and stores deduplicated event metadata. Message text and raw payloads are not stored. When bot replies are enabled, incoming messages drive the request-led dialogue and a valid phone number is stored as a lead.
- The showcase is available at `/showcase`. It initially displays draft cards without outbound links. After manual review, approved cards show the legal advertiser, advertiser site, “Реклама” label and ERID. The bot sends at most four approved offers plus a fifth “Все предложения” button. With fewer than four approved offers, it only sends those approved and links to the catalogue. Offer 2110 (Желдорзайм) remains excluded.
- No group-member scraping, cold bulk messages, VK permission bypass or live VK Ads launch.
- A phone number or imported row is not, by itself, permission for unsolicited marketing. The product flow is request-led: the user starts the conversation and asks to receive offers. No separate advertising-consent screen, in-bot unsubscribe screen or STOP command is included. Do not send unsolicited promotional broadcasts; respect VK message-denial/block events and platform restrictions. Data processing and transfer to partners still require a valid legal basis, a privacy notice and appropriate safeguards.
- Unknown CPA URLs, ERID values, rates and campaign terms remain empty. Public research is not legal approval.
- Do not commit VK tokens, secrets or personal lead data. Add credentials only through protected Replit Secrets after separate review.

## Run

Requirements: Node.js 22+.

Set a unique `ADMIN_PASSWORD`, then start with `node bootstrap.mjs`. For Callback API, configure `VK_COMMUNITY_ID=243658195`, `VK_CALLBACK_CONFIRMATION` and `VK_CALLBACK_SECRET`. To enable replies to users who message the community, additionally configure `VK_ACCESS_TOKEN` (community token), `VK_BOT_REPLIES_ENABLED=true` and `PUBLIC_BASE_URL` (the public HTTPS origin). Keep these in Replit Secrets, never in GitHub or chat. Without the token and explicit flag, the bot records inbound events but does not reply. Open the Replit preview or http://localhost:3000.

The admin Integrations page shows the callback URL, bot reply status and recent event metadata. Configure VK with `message_new`, `message_allow`, `message_deny`, `user_block` and `user_unblock` events. The bot accepts a phone number sent as text after the user chooses to receive offers. A phone already linked to another VK ID is rejected. Direct partner links are returned only after admin approval in the CPA showcase. No automated advertising campaigns are enabled.

CI restores the original catalogue bundle, runs unit/API tests and checks the imported catalogue. The VK bot flow has an integration test using a local mock of VK API; it never sends real messages.

## CSV columns

vk_user_id, phone, source, personal_data_consent, personal_data_consent_at, personal_data_consent_source, advertising_consent, advertising_consent_at, advertising_consent_source, vk_messages_allowed, vk_messages_allowed_at, vk_messages_allowed_source.

A true consent is accepted only with matching timestamp and evidence source. False revokes the corresponding permission. Blank values do not upgrade permissions. Do not import data without a documented lawful basis.

## Supplied research

- research/official-offer-enrichment-2026-11-22.json — 123 enriched source records.
- research/cpa-offer-links-2026-11-24.json — 129 CPA URLs supplied by the user; URLs and ERID strings preserved as received and not independently validated.
- research/official-brand-assets-2026-11-22.json — official logo and image references.

Research checked on 2026-11-22; manual legal and campaign-specific validation remains required.
