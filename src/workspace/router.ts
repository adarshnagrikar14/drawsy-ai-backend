import { Router } from "express";

import { ApiError } from "../http/apiError.js";
import {
  deleteVersionSchema,
  idSchema,
  patchCanvasSchema,
  putCanvasSchema,
  putProjectSchema,
} from "./schemas.js";

import type { createAuthenticate } from "../http/authenticate.js";
import type { CommentService } from "../comments/types.js";
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
  commentService?: CommentService,
) => {
  const router = Router();
  router.use(authenticate);
  const removeDeletedCanvasComments = async (
    userId: string,
    canvasIds: string[],
  ) => {
    if (!commentService || canvasIds.length === 0) {
      return;
    }
    const results = await Promise.allSettled(
      canvasIds.map((canvasId) =>
        commentService.deleteAllForCanvas(userId, canvasId),
      ),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(
          JSON.stringify({
            level: "error",
            message: "comment_cleanup_failed",
            userId,
            canvasId: canvasIds[index],
          }),
        );
      }
    });
  };

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
    const userId = getUserId(response);
    const result = await workspaceService.deleteProject(
      userId,
      projectId,
      baseVersion,
    );
    await removeDeletedCanvasComments(userId, result.deletedCanvasIds);
    response.json(result);
  });

  router.put("/canvases/:canvasId", async (request, response) => {
    const input = putCanvasSchema.parse(request.body);
    assertPathId(request.params.canvasId, input.id);
    const canvas = await workspaceService.putCanvas(getUserId(response), input);
    response.status(input.baseVersion === 0 ? 201 : 200).json({ canvas });
  });

  router.patch("/canvases/:canvasId", async (request, response) => {
    const input = patchCanvasSchema.parse(request.body);
    assertPathId(request.params.canvasId, input.id);
    const canvas = await workspaceService.patchCanvas(
      getUserId(response),
      input,
    );
    response.json({ canvas });
  });

  router.delete("/canvases/:canvasId", async (request, response) => {
    const canvasId = idSchema.parse(request.params.canvasId);
    const { baseVersion } = deleteVersionSchema.parse(request.query);
    const userId = getUserId(response);
    await workspaceService.deleteCanvas(userId, canvasId, baseVersion);
    await removeDeletedCanvasComments(userId, [canvasId]);
    response.status(204).send();
  });

  return router;
};
