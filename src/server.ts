import "dotenv/config";

import { createApp } from "./app.js";
import { createFirebaseTokenVerifier } from "./auth/firebaseTokenVerifier.js";
import { FirestoreCommentService } from "./comments/firestoreCommentService.js";
import { loadConfig } from "./config.js";
import { getFirebaseAdminApp } from "./firebase.js";
import { FirestoreWorkspaceService } from "./workspace/firestoreWorkspaceService.js";
import { R2SceneStorage } from "./workspace/r2SceneStorage.js";
import { KanbanCrypto } from "./kanban/crypto.js";
import { FirestoreKanbanService } from "./kanban/firestoreKanbanService.js";
import { FirestorePresentationService } from "./presentations/firestorePresentationService.js";
import { FirestoreJiraConnectionStore } from "./jira/firestoreJiraConnectionStore.js";
import { AtlassianJiraService } from "./jira/atlassianJiraService.js";
import { DefaultConnectorService } from "./connectors/connectorService.js";
import { FirestoreConnectorConnectionStore } from "./connectors/firestoreConnectorConnectionStore.js";
import { GoogleWorkspaceProvider } from "./connectors/googleWorkspaceProvider.js";
import { NotionProvider } from "./connectors/notionProvider.js";
import { SlackProvider } from "./connectors/slackProvider.js";
import { GitHubProvider } from "./connectors/githubProvider.js";

const config = loadConfig();
const firebaseApp = getFirebaseAdminApp(config.firebaseProjectId);
const sceneStorage = new R2SceneStorage(config);
const connectorProviders = config.connectors
  ? [
      ...(config.connectors.googleWorkspace
        ? [
            new GoogleWorkspaceProvider(
              config.connectors.googleWorkspace,
              config.connectors.httpTimeoutMs,
            ),
          ]
        : []),
      ...(config.connectors.notion
        ? [
            new NotionProvider(
              config.connectors.notion,
              config.connectors.httpTimeoutMs,
            ),
          ]
        : []),
      ...(config.connectors.slack
        ? [
            new SlackProvider(
              config.connectors.slack,
              config.connectors.httpTimeoutMs,
            ),
          ]
        : []),
      ...(config.connectors.github
        ? [
            new GitHubProvider(
              config.connectors.github,
              config.connectors.httpTimeoutMs,
            ),
          ]
        : []),
    ]
  : [];
const app = createApp({
  config,
  tokenVerifier: createFirebaseTokenVerifier(firebaseApp),
  workspaceService: new FirestoreWorkspaceService(firebaseApp, sceneStorage),
  presentationService: new FirestorePresentationService(
    firebaseApp,
    sceneStorage,
  ),
  commentService: new FirestoreCommentService(firebaseApp),
  kanbanService: new FirestoreKanbanService(
    firebaseApp,
    new KanbanCrypto(
      config.kanban.encryptionKeys,
      config.kanban.encryptionKeyVersion,
      config.kanban.emailDigestKey,
    ),
    {
      eventMs: config.kanban.eventRetentionMs,
      operationMs: config.kanban.operationRetentionMs,
      invitesPerHour: config.kanban.invitesPerHour,
    },
  ),
  jiraService: config.jira
    ? new AtlassianJiraService(
        config.jira,
        new FirestoreJiraConnectionStore(firebaseApp),
      )
    : undefined,
  connectorService: config.connectors
    ? new DefaultConnectorService(
        config.connectors,
        connectorProviders,
        new FirestoreConnectorConnectionStore(firebaseApp),
      )
    : undefined,
});

const server = app.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      level: "info",
      message: "server_started",
      service: "drawsy-ai-backend",
      env: config.env,
      host: config.host,
      port: config.port,
    }),
  );
});

const shutdown = (signal: NodeJS.Signals) => {
  console.log(
    JSON.stringify({ level: "info", message: "server_stopping", signal }),
  );
  server.close((error) => {
    if (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "server_shutdown_failed",
          error: error.message,
        }),
      );
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
