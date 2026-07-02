import type { AuthenticatedUser } from "../auth/types.js";

declare global {
  namespace Express {
    interface Locals {
      requestId: string;
      user?: AuthenticatedUser;
    }
  }
}

export {};
