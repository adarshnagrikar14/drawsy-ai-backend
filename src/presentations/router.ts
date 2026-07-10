import { Router } from "express";

import { ApiError } from "../http/apiError.js";
import { deleteVersionSchema, idSchema } from "../workspace/schemas.js";
import { patchPresentationSchema, putPresentationSchema } from "./schemas.js";

import type { createAuthenticate } from "../http/authenticate.js";
import type { PresentationService } from "./types.js";
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
};

export const createPresentationsRouter = (
  authenticate: ReturnType<typeof createAuthenticate>,
  presentationService: PresentationService,
) => {
  const router = Router();
  router.use(authenticate);

  router.get("/presentations", async (_request, response) => {
    response.json(
      await presentationService.getPresentations(getUserId(response)),
    );
  });

  router.get(
    "/presentations/:presentationId/scene",
    async (request, response) => {
      const presentationId = idSchema.parse(request.params.presentationId);
      response.json({
        scene: await presentationService.getPresentationScene(
          getUserId(response),
          presentationId,
        ),
      });
    },
  );

  router.put("/presentations/:presentationId", async (request, response) => {
    const input = putPresentationSchema.parse(request.body);
    assertPathId(request.params.presentationId, input.id);
    const presentation = await presentationService.putPresentation(
      getUserId(response),
      input,
    );
    response.status(input.baseVersion === 0 ? 201 : 200).json({ presentation });
  });

  router.patch("/presentations/:presentationId", async (request, response) => {
    const input = patchPresentationSchema.parse(request.body);
    assertPathId(request.params.presentationId, input.id);
    const presentation = await presentationService.patchPresentation(
      getUserId(response),
      input,
    );
    response.json({ presentation });
  });

  router.delete("/presentations/:presentationId", async (request, response) => {
    const presentationId = idSchema.parse(request.params.presentationId);
    const { baseVersion } = deleteVersionSchema.parse(request.query);
    await presentationService.deletePresentation(
      getUserId(response),
      presentationId,
      baseVersion,
    );
    response.status(204).send();
  });

  return router;
};
