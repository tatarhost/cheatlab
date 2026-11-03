# CheatLab Mail — architecture and launch requirements

Status: architecture foundation only. No mailbox is live until the domain and mail provider are onboarded and DNS is verified.

## Product contract

- Mail addresses use the `@cheatlab.fun` domain.
- Each existing CheatLab account may own at most five mailboxes.
- Mailbox identity is separate from the CheatLab login identity. Existing nick/password sessions remain the account authority; mailbox creation requires an authenticated session.
- Messages, attachments, and mailbox settings are private to the owning account. Public Cloudinary assets must never be used for private mail.
- Do not show a mailbox as active until the provider confirms that the address/domain is provisioned.
- Never claim a message was delivered until the mail provider returns a successful send result.

## Existing application

The repository is already a static GitHub Pages frontend plus a Cloudflare Worker API, Cloudflare D1, KV, and Cloudinary for public media. The existing account system is a custom nickname/password flow in `worker/src/accounts.js` and `worker/src/index.js`; it is not Firebase Authentication. Do not replace it with Firebase without a migration plan. Firebase's browser apiKey is not a mail-server credential, and Cloudinary is a media CDN, not a mailbox host.

## Proposed architecture

1. **Frontend:** add a Mail section to the existing app shell; keep the current black/white design language and use restrained translucent glass surfaces for the mail workspace.
2. **Identity:** reuse the existing CheatLab session. Enforce the five-mailbox cap in the Worker and in a database constraint/transaction; never trust a client-side counter.
3. **Mail API:** authenticated Worker routes for mailbox list/create/rename/delete, inbox/sent views, read state, compose, send, and attachment download. Apply per-account and per-mailbox rate limits, strict recipient validation, CSRF/origin checks, and abuse controls.
4. **Inbound:** route domain mail to a dedicated Worker email handler. Parse MIME with a maintained MIME parser, validate the envelope recipient against an active mailbox, and store the message before acknowledging receipt.
5. **Outbound:** use a verified sending provider with SPF, DKIM, and DMARC. Queue sends, record provider message IDs and bounces, and apply per-account sending limits and abuse monitoring.
6. **Storage:** D1 stores mailbox/message metadata; a private object store (prefer Cloudflare R2) stores raw MIME and attachments. Keep private email objects separate from public Cloudinary media. Enforce quotas and attachment size limits.
7. **Security:** TLS in transit, private object access through authenticated Worker endpoints, HTML sanitization on display, attachment content-type sniffing, malware scanning where available, password/session protections, audit events, account deletion/export, and retention controls.

## Mailbox data model (planned)

- `mailboxes`: id, owner_user_id, local_part, address, status, created_at, updated_at. Unique address and unique (owner_user_id, local_part).
- `mail_messages`: id, mailbox_id, owner_user_id, direction, envelope_from, from_header, to_header, cc_header, subject, text_body, sanitized_html_key, raw_object_key, provider_message_id, in_reply_to, is_read, received_at, sent_at, deleted_at.
- `mail_attachments`: id, message_id, object_key, filename, mime_type, size_bytes, content_id.
- `mail_outbox`: id, owner_user_id, mailbox_id, recipient, payload_object_key, status, attempts, provider_message_id, last_error, created_at, sent_at.

The Worker must enforce the five-mailbox limit atomically (for example, a transaction/conditional insert), not with a separate count-then-insert race.

## Free-tier reality and deployment blocker

Cloudflare Email Routing can receive mail and route it to a Worker on the Free plan, but it is not a hosted IMAP mailbox by itself. Cloudflare Email Sending's current documentation says arbitrary-recipient outbound sending is available on Workers Paid; Free is limited to verified destination addresses. Cloudflare Email Service also requires the domain to use Cloudflare DNS and be onboarded in the Cloudflare dashboard.

Therefore, a genuinely usable public mail service (receive and send to arbitrary external addresses) cannot be activated solely by committing code to GitHub. It requires:
- control of the `cheatlab.fun` DNS zone and changing/adding MX, SPF, DKIM, and DMARC records;
- a mail provider/account or an owned mail server with public IP, reverse DNS, TLS, anti-abuse controls, and persistent storage;
- private provider credentials/configuration and deployment of the Worker plus database/object-store bindings.

GitHub Pages is static hosting and cannot run SMTP/IMAP daemons. A free inbound-forwarding service alone is not a full mailbox. Do not deploy a fake inbox or accept mail that cannot be durably stored.

## Current implementation in this branch

- Added an Email navigation entry and a responsive mail workspace in the existing site design.
- Added account-authenticated mailbox listing/creation/deletion APIs, with a server-side maximum of five addresses per account and unique `@cheatlab.fun` local parts.
- Added private message-list API and a message reader that detects common one-time verification-code patterns and offers one-click copy.
- Added D1 schema and migration `0007_mail.sql`.
- Mailboxes are deliberately created with `pending` status. No inbound provider is connected yet; the outbound endpoint returns HTTP 503 rather than pretending a message was sent. The UI explains this.

## Deploy prerequisites

The site deploy workflow only publishes `public/` to GitHub Pages. The Worker and D1 schema are deployed separately. After merging and reviewing this branch, apply the migration with `cd worker && npx wrangler d1 migrations apply cheatlab --remote --config wrangler.toml`, then deploy with `npx wrangler deploy --config wrangler.toml`. These commands require an authenticated Cloudflare account with access to the existing D1 database. This does not activate external email delivery; provider onboarding and DNS verification remain separate requirements.

## Delivery phases

- Phase 0: verify domain DNS ownership, current Cloudflare account/zone, available Worker plan, and private storage bindings.
- Phase 1: database migration and authenticated mailbox CRUD; five-address enforcement.
- Phase 2: inbound MIME processing and private object storage; integration tests.
- Phase 3: outbound provider integration, bounce handling, rate limits, and end-to-end tests with external mailboxes.
- Phase 4: webmail UI, search, folders/labels, drafts, attachments, responsive glass design, accessibility, and security review.

## Credentials

Never commit API tokens, SMTP passwords, private keys, Cloudinary API secrets, or Firebase service-account credentials. Put provider credentials in Cloudflare Worker secrets. Firebase's web config is public by design but still needs strict Firestore/Storage Security Rules if Firebase is used for any separate purpose. A Cloudinary API key alone is not sufficient to sign private uploads; the API secret must remain server-side.
