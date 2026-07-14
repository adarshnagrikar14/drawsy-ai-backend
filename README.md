# Drawsy AI Backend

Authenticated workspace API for Drawsy AI. It coordinates Firebase identity,
Firestore workspace metadata, and Cloudflare R2 canvas scenes without replacing
the Excalidraw editor core.

## Current API

- `GET /health` - public service health
- `GET /v1/me` - verifies a Firebase ID token and returns its normalized user
- `GET /v1/workspace` - lists the user's project and canvas metadata
- `GET /v1/canvases/:id/scene` - loads an authorized canvas scene
- `PUT /v1/projects/:id` - creates or updates a versioned project
- `DELETE /v1/projects/:id?baseVersion=N` - deletes a project and its canvases
- `PUT /v1/canvases/:id` - creates or updates a versioned canvas and R2 scene
- `PATCH /v1/canvases/:id` - updates canvas metadata without rewriting its scene
- `DELETE /v1/canvases/:id?baseVersion=N` - deletes a canvas
- `GET /v1/canvases/:id/comments` - lists the owner's private comments
- `POST /v1/canvases/:id/comments` - creates a private comment
- `DELETE /v1/canvases/:id/comments/:commentId?baseVersion=N` - deletes a comment

### Kanban

- `GET /v1/kanban/boards` - lists authorized boards
- `POST /v1/kanban/boards` - creates an encrypted board
- `GET /v1/kanban/boards/:id/snapshot` - loads the canonical board
- `GET /v1/kanban/boards/:id/changes?afterRevision=N` - loads bounded deltas
- `GET /v1/kanban/boards/:id/events` - authenticated SSE revision/role stream
- `POST /v1/kanban/boards/:id/commands` - applies ordered idempotent commands
- `GET /v1/kanban/boards/:id/members` - lists members
- `PATCH /v1/kanban/boards/:id/members/:userId` - changes editor/viewer role
- `DELETE /v1/kanban/boards/:id/members/:userId` - removes access or leaves
- `POST /v1/kanban/boards/:id/ownership-transfer` - transfers ownership after recent authentication
- `POST /v1/kanban/boards/:id/invitations` - creates a single-use email-bound invite link
- `DELETE /v1/kanban/boards/:id/invitations/:invitationId` - revokes an invitation
- `POST /v1/kanban/invitations/inspect` - inspects a token without exposing board data
- `POST /v1/kanban/invitations/accept` - accepts with the verified invited email

### Connectors

- `GET /v1/connectors` - lists configured providers and the user's connections
- `POST /v1/connectors/:providerId/oauth/start` - starts provider OAuth
- `GET /v1/connectors/oauth/attempts/:attemptId` - reports OAuth completion
- `GET /v1/connectors/:providerId/oauth/callback` - public OAuth callback
- `DELETE /v1/connectors/connections/:connectionId` - revokes and removes access
- `POST /v1/connectors/ai/grants` - mints a short-lived, user-authenticated connector grant for one local AI turn
- `POST /v1/connectors/ai/execute` - executes grant-scoped, read-only `search` or `read` against a connected provider

The connector control plane owns OAuth, encrypted credentials, account-scoped
permissions, refresh, and revocation for Google Workspace, Notion, Slack, and
GitHub. One Google Workspace account supplies Mail, Calendar, and Drive with
granted read-only scopes. Provider adapters keep product APIs and future MCP
consumers behind the same authorization boundary. Drawsy's local MCP service
uses short-lived signed grants and never receives provider access or refresh
tokens.

The grant endpoint requires the normal Firebase bearer token and accepts:

```json
{
  "sessionId": "local-session-id",
  "turnId": "turn-id",
  "connectionId": "owned-connection-id",
  "capabilities": ["mail", "drive"]
}
```

The returned grant is valid only for that authenticated user, local session,
turn, connection, and capability allowlist. The MCP process supplies it as the
Bearer token to `/v1/connectors/ai/execute`, repeating the exact session, turn,
connection, and one allowed capability in the body. Execution accepts either a
bounded `search` request (`query`, optional `cursor` and `limit`) or a `read`
request using an opaque `resourceId` returned by search. Results share one
normalized item envelope across Mail, Calendar, Drive, Notion, Slack, and
GitHub. Grants expire by default after two minutes; provider calls use fixed
HTTPS hosts, timeouts, strict response validation, and an output byte ceiling.

Provider applications must be registered before their cards become available:

- Google Workspace: web OAuth client, enabled Gmail/Calendar/Drive APIs, consent
  screen, and Google verification for the requested restricted scopes.
- Notion: public connection with the backend callback URI.
- Slack: distributed or approved internal app with the documented user scopes.
- GitHub: GitHub App with installation permissions and user authorization.

Use HTTPS callback/success URLs and a deployment secret manager in production.
Configure Firestore TTL on `deleteAt` for the `connectorOAuthStates` and
`connectorOAuthAttempts` collection groups.

Protected requests use:

```http
Authorization: Bearer <firebase-id-token>
```

The backend verifies client ID tokens with Firebase Admin. It never accepts a
user ID supplied by the client as proof of identity.

Project and canvas metadata is stored below the authenticated user's Firestore
path. Full scenes are stored under user-scoped R2 object keys in authenticated
compressed AES-256-GCM envelopes. Canonical scene hashes make retrying an
identical checkpoint idempotent. Updates use a required `baseVersion`; stale
writes return `409 version_conflict` instead of overwriting another device.

Comments live below the authenticated user's canvas in Firestore. They are not
stored in scene JSON, R2 scene objects, shared links, collaboration payloads, or
exports. Removing a canvas also removes its comments.

Kanban is local-first in the frontend. Firestore stores normalized board state,
idempotent operation results, and encrypted delta events. Board/card/checklist
content and invitation email are protected with per-board AES-256-GCM data keys;
only wrapped data keys are stored. Realtime uses the authenticated SSE endpoint
and multiplexed canonical Firestore listeners. It does not poll and does not add
Kanban traffic to the Excalidraw collaboration server.

Back up `WORKSPACE_ENCRYPTION_KEY` in the deployment secret manager. Losing it
makes existing workspace scenes unrecoverable.

## Local setup

Requirements:

- Node.js 22 or newer
- Access to the owned Firebase project
- Google Application Default Credentials

```bash
cp .env.example .env
npm install
npm run dev
```

For local credentials, set `GOOGLE_APPLICATION_CREDENTIALS` to an absolute path
to a service-account JSON file. Do not commit that file. On Google Cloud,
Application Default Credentials use the service account attached to the
runtime, so no credential file is required.

## Commands

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm start
```

## Configuration

- `NODE_ENV`: `development`, `test`, or `production`
- `APP_HOST`: bind host
- `APP_PORT`: bind port
- `APP_ALLOWED_ORIGINS`: comma-separated exact browser origins
- `FIREBASE_PROJECT_ID`: Firebase project used to verify token audience
- `APP_SCENE_SIZE_LIMIT_BYTES`: maximum accepted serialized canvas size
- `R2_ENDPOINT_URL`: S3-compatible Cloudflare R2 endpoint
- `R2_BUCKET_NAME`: owned R2 bucket
- `R2_REGION`: normally `auto` for R2
- `R2_KEY_PREFIX`: isolated workspace object prefix
- `R2_ACCESS_KEY_ID`: server-only R2 access key
- `R2_SECRET_ACCESS_KEY`: server-only R2 secret
- `WORKSPACE_ENCRYPTION_KEY`: base64-encoded 32-byte scene encryption key
- `GOOGLE_WORKSPACE_OAUTH_CLIENT_ID`: Google web OAuth client ID
- `GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET`: server-only Google OAuth secret
- `GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI`: exact backend OAuth callback URL
- `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET`, `NOTION_OAUTH_REDIRECT_URI`: Notion public connection OAuth
- `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET`, `SLACK_OAUTH_REDIRECT_URI`: Slack app OAuth
- `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URI`: GitHub App user OAuth
- `CONNECTORS_OAUTH_SUCCESS_URL`: trusted frontend URL after OAuth completes
- `CONNECTOR_ENCRYPTION_KEY`: optional dedicated base64-encoded 32-byte token key
- `CONNECTOR_ENCRYPTION_KEY_VERSION`: positive current connector key version
- `CONNECTOR_ENCRYPTION_PREVIOUS_KEYS`: comma-separated `version:base64-key` rotation entries
- `CONNECTOR_OAUTH_STATE_TTL_SECONDS`: one-use connector OAuth state lifetime
- `CONNECTOR_HTTP_TIMEOUT_MS`: connector provider request timeout
- `CONNECTOR_AI_GRANT_TTL_SECONDS`: signed AI connector grant lifetime, 30–300 seconds (default `120`)
- `CONNECTOR_AI_MAX_OUTPUT_BYTES`: maximum provider response and normalized execution payload, 16 KiB–1 MiB (default `262144`)
- `KANBAN_ENCRYPTION_KEY`: current base64-encoded 32-byte wrapping key; defaults to the workspace key for local compatibility
- `KANBAN_ENCRYPTION_KEY_VERSION`: positive current key version
- `KANBAN_ENCRYPTION_PREVIOUS_KEYS`: comma-separated `version:base64-key` entries required during rotation
- `KANBAN_EMAIL_DIGEST_KEY`: stable base64-encoded 32-byte invitation-email HMAC key
- `KANBAN_SSE_HEARTBEAT_MS`: keepalive interval; does not query Firestore
- `KANBAN_EVENT_RETENTION_DAYS`: encrypted delta retention/TTL
- `KANBAN_OPERATION_RETENTION_DAYS`: idempotency result retention/TTL
- `KANBAN_INVITES_PER_HOUR`: durable per-owner/board invitation limit
- `KANBAN_RECENT_AUTH_SECONDS`: maximum auth age for ownership transfer

This repository does not contain Firebase client configuration, service-account
keys, R2 credentials, or frontend code.
