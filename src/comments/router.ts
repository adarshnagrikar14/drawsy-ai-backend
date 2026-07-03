import { Router } from "express";

import { ApiError } from "../http/apiError.js";
import { idSchema } from "../workspace/schemas.js";
import { createCommentSchema, deleteCommentSchema } from "./schemas.js";

import type { createAuthenticate } from "../http/authenticate.js";
import type { CommentService } from "./types.js";
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

const getCanvasId = (params: Record<string, string | undefined>) =>
  idSchema.parse(params.canvasId);

export const createCommentsRouter = (
  authenticate: ReturnType<typeof createAuthenticate>,
  commentService: CommentService,
) => {
  const router = Router({ mergeParams: true });
  router.use(authenticate);

  router.get("/", async (request, response) => {
    const canvasId = getCanvasId(request.params);
    response.json({
      comments: await commentService.list(getUserId(response), canvasId),
    });
  });

  router.post("/", async (request, response) => {
    const canvasId = getCanvasId(request.params);
    const input = createCommentSchema.parse(request.body);
    const comment = await commentService.create(getUserId(response), {
      ...input,
      canvasId,
    });
    response.status(201).json({ comment });
  });

  router.delete("/:commentId", async (request, response) => {
    const canvasId = getCanvasId(request.params);
    const commentId = idSchema.parse(request.params.commentId);
    const { baseVersion } = deleteCommentSchema.parse(request.query);
    await commentService.delete(
      getUserId(response),
      canvasId,
      commentId,
      baseVersion,
    );
    response.status(204).send();
  });

  return router;
};
