import { getAuth } from "firebase-admin/auth";

import type { App } from "firebase-admin/app";
import type { AuthenticatedUser, TokenVerifier } from "./types.js";

export const createFirebaseTokenVerifier = (app: App): TokenVerifier => {
  const auth = getAuth(app);

  const getOptionalStringClaim = (
    claims: Record<string, unknown>,
    name: string,
  ) => {
    const value = claims[name];
    return typeof value === "string" ? value : null;
  };

  return {
    async verify(token): Promise<AuthenticatedUser> {
      const decoded = await auth.verifyIdToken(token, true);
      const claims: Record<string, unknown> = decoded;

      return {
        id: decoded.uid,
        email: decoded.email ?? null,
        emailVerified: decoded.email_verified ?? false,
        name: getOptionalStringClaim(claims, "name"),
        picture: getOptionalStringClaim(claims, "picture"),
      };
    },
  };
};
