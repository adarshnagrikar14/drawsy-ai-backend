import { Router } from "express";

import { ApiError } from "../http/apiError.js";
import {
  deleteVersionSchema,
  idSchema,
  putCanvasSchema,
  putProjectSchema,
} from "./schemas.js";

import type { createAuthenticate } from "../http/authenticate.js";
import type { WorkspaceService } from "./types.js";
import type { Response } from "express";

const getUserId = (response: Response) => {
  const userId = response.locals.user?.id;
  if (!userId) {
    throw new ApiError(
      401,
      "authentication_required",
      "Authentication is required.",
    );
  }
  return userId;
};

const assertPathId = (pathId: string | undefined, bodyId: string) => {
  const parsedPathId = idSchema.parse(pathId);
  if (parsedPathId !== bodyId) {
    throw new ApiError(
      400,
      "id_mismatch",
      "The path and body identifiers must match.",
    );
  }
  return parsedPathId;
};

export const createWorkspaceRouter = (
  authenticate: ReturnType<typeof createAuthenticate>,
  workspaceService: WorkspaceService,
) => {
  const router = Router();
  router.use(authenticate);

  router.get("/workspace", async (_request, response) => {
    response.json(await workspaceService.getWorkspace(getUserId(response)));
  });

  router.get("/canvases/:canvasId/scene", async (request, response) => {
    const canvasId = idSchema.parse(request.params.canvasId);
    response.json({
      scene: await workspaceService.getCanvasScene(
        getUserId(response),
        canvasId,
      ),
    });
  });

  router.put("/projects/:projectId", async (request, response) => {
    const input = putProjectSchema.parse(request.body);
    assertPathId(request.params.projectId, input.id);
    const project = await workspaceService.putProject(
      getUserId(response),
      input,
    );
    response.status(input.baseVersion === 0 ? 201 : 200).json({ project });
  });

  router.delete("/projects/:projectId", async (request, response) => {
    const projectId = idSchema.parse(request.params.projectId);
    const { baseVersion } = deleteVersionSchema.parse(request.query);
    response.json(
      await workspaceService.deleteProject(
        getUserId(response),
        projectId,
        baseVersion,
      ),
    );
  });

  router.put("/canvases/:canvasId", async (request, response) => {
    const input = putCanvasSchema.parse(request.body);
    assertPathId(request.params.canvasId, input.id);
    const canvas = await workspaceService.putCanvas(getUserId(response), input);
    response.status(input.baseVersion === 0 ? 201 : 200).json({ canvas });
  });

  router.delete("/canvases/:canvasId", async (request, response) => {
    const canvasId = idSchema.parse(request.params.canvasId);
    const { baseVersion } = deleteVersionSchema.parse(request.query);
    await workspaceService.deleteCanvas(
      getUserId(response),
      canvasId,
      baseVersion,
    );
    response.status(204).send();
  });

  return router;
};
