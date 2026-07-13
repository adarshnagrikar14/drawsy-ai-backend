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

const config = loadConfig();
const firebaseApp = getFirebaseAdminApp(config.firebaseProjectId);
const sceneStorage = new R2SceneStorage(config);
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
