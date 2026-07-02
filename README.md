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
- `DELETE /v1/canvases/:id?baseVersion=N` - deletes a canvas

Protected requests use:

```http
Authorization: Bearer <firebase-id-token>
```

The backend verifies client ID tokens with Firebase Admin. It never accepts a
user ID supplied by the client as proof of identity.

Project and canvas metadata is stored below the authenticated user's Firestore
path. Full scenes are stored under user-scoped R2 object keys in authenticated
AES-256-GCM envelopes. Updates use a required `baseVersion`; stale writes return
`409 version_conflict` instead of overwriting another device.

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

This repository does not contain Firebase client configuration, service-account
keys, R2 credentials, or frontend code.
