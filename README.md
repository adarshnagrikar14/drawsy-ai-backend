# Drawsy AI Backend

Authenticated API foundation for Drawsy AI. This service will coordinate owned
workspace, project, canvas, storage, and collaboration services without
replacing the Excalidraw editor core.

## Current API

- `GET /health` - public service health
- `GET /v1/me` - verifies a Firebase ID token and returns its normalized user

Protected requests use:

```http
Authorization: Bearer <firebase-id-token>
```

The backend verifies client ID tokens with Firebase Admin. It never accepts a
user ID supplied by the client as proof of identity.

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

This repository does not contain Firebase client configuration, service-account
keys, R2 credentials, or frontend code.
