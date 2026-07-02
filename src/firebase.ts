import {
  applicationDefault,
  getApp,
  getApps,
  initializeApp,
} from "firebase-admin/app";

import type { App } from "firebase-admin/app";

export const getFirebaseAdminApp = (projectId: string): App => {
  const existing = getApps().find((app) => app.options.projectId === projectId);
  if (existing) {
    return existing;
  }

  if (getApps().length > 0) {
    const defaultApp = getApp();
    if (
      defaultApp.options.projectId &&
      defaultApp.options.projectId !== projectId
    ) {
      throw new Error("Firebase Admin is initialized for another project");
    }
    return defaultApp;
  }

  return initializeApp({
    credential: applicationDefault(),
    projectId,
  });
};
