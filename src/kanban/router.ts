import { Router } from "express";

import { ApiError } from "../http/apiError.js";
import { idSchema } from "../workspace/schemas.js";
import {
  changesQuerySchema,
  commandBatchSchema,
  createBoardSchema,
  createInvitationSchema,
  invitationTokenSchema,
  transferOwnershipSchema,
  updateMemberSchema,
} from "./schemas.js";

import type { createAuthenticate } from "../http/authenticate.js";
import type { KanbanService } from "./types.js";
import type { Response } from "express";

const getUser = (response: Response) => {
  const user = response.locals.user;
  if (!user) {
    throw new ApiError(
      401,
      "authentication_required",
      "Authentication is required.",
    );
  }
  return user;
};

export const createKanbanRouter = (
  authenticate: ReturnType<typeof createAuthenticate>,
  service: KanbanService,
  options: { sseHeartbeatMs: number; recentAuthMs: number },
) => {
  const router = Router();
  const streams = new Set<Response>();
  let heartbeat: NodeJS.Timeout | null = null;
  const registerStream = (response: Response) => {
    streams.add(response);
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        streams.forEach((stream) => {
          if (!stream.writableEnded) {
            stream.write(": keepalive\n\n");
          }
        });
      }, options.sseHeartbeatMs);
      heartbeat.unref();
    }
    return () => {
      streams.delete(response);
      if (streams.size === 0 && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };
  };

  router.post("/kanban/invitations/inspect", async (request, response) => {
    const { token } = invitationTokenSchema.parse(request.body);
    response.json(await service.inspectInvitation(token));
  });

  router.use(authenticate);

  router.get("/kanban/boards", async (_request, response) => {
    response.json({ boards: await service.listBoards(getUser(response).id) });
  });

  router.post("/kanban/boards", async (request, response) => {
    const input = createBoardSchema.parse(request.body);
    response.status(201).json({
      snapshot: await service.createBoard(getUser(response).id, input),
    });
  });

  router.get("/kanban/boards/:boardId/snapshot", async (request, response) => {
    const boardId = idSchema.parse(request.params.boardId);
    response.json({
      snapshot: await service.getSnapshot(getUser(response).id, boardId),
    });
  });

  router.get("/kanban/boards/:boardId/changes", async (request, response) => {
    const boardId = idSchema.parse(request.params.boardId);
    const { afterRevision } = changesQuerySchema.parse(request.query);
    response.json(
      await service.getChanges(getUser(response).id, boardId, afterRevision),
    );
  });

  router.get("/kanban/boards/:boardId/events", async (request, response) => {
    const boardId = idSchema.parse(request.params.boardId);
    const userId = getUser(response).id;
    const initial = await service.getRealtimeState(userId, boardId);
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    const send = (event: unknown) => {
      if (!response.writableEnded) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };
    send({ type: "revision", latestRevision: initial.latestRevision });

    let unsubscribe: () => void = () => undefined;
    let releaseStream: () => void = () => undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      releaseStream();
      unsubscribe();
    };
    releaseStream = registerStream(response);
    unsubscribe = service.subscribeToRealtime(
      userId,
      boardId,
      (event) => {
        send(event);
        if (event.type === "access_revoked") {
          cleanup();
          response.end();
        }
      },
      () => {
        cleanup();
        response.end();
      },
    );
    if (cleaned) {
      unsubscribe();
    }
    request.once("close", cleanup);
  });

  router.post("/kanban/boards/:boardId/commands", async (request, response) => {
    const boardId = idSchema.parse(request.params.boardId);
    const { clientId, commands } = commandBatchSchema.parse(request.body);
    response.json({
      results: await service.applyCommands(
        getUser(response).id,
        boardId,
        clientId,
        commands,
      ),
    });
  });

  router.get("/kanban/boards/:boardId/members", async (request, response) => {
    const boardId = idSchema.parse(request.params.boardId);
    response.json({
      members: await service.listMembers(getUser(response).id, boardId),
    });
  });

  router.patch(
    "/kanban/boards/:boardId/members/:memberId",
    async (request, response) => {
      const boardId = idSchema.parse(request.params.boardId);
      const memberId = idSchema.parse(request.params.memberId);
      const { role } = updateMemberSchema.parse(request.body);
      response.json({
        member: await service.updateMemberRole(
          getUser(response).id,
          boardId,
          memberId,
          role,
        ),
      });
    },
  );

  router.delete(
    "/kanban/boards/:boardId/members/:memberId",
    async (request, response) => {
      const boardId = idSchema.parse(request.params.boardId);
      const memberId = idSchema.parse(request.params.memberId);
      await service.removeMember(getUser(response).id, boardId, memberId);
      response.status(204).send();
    },
  );

  router.post(
    "/kanban/boards/:boardId/ownership-transfer",
    async (request, response) => {
      const boardId = idSchema.parse(request.params.boardId);
      const user = getUser(response);
      if (!user.authTime || Date.now() - user.authTime > options.recentAuthMs) {
        throw new ApiError(
          403,
          "recent_authentication_required",
          "Sign in again before transferring ownership.",
        );
      }
      const { targetUserId } = transferOwnershipSchema.parse(request.body);
      response.json(
        await service.transferOwnership(user.id, boardId, targetUserId),
      );
    },
  );

  router.post(
    "/kanban/boards/:boardId/invitations",
    async (request, response) => {
      const boardId = idSchema.parse(request.params.boardId);
      const input = createInvitationSchema.parse(request.body);
      response
        .status(201)
        .json(
          await service.createInvitation(getUser(response).id, boardId, input),
        );
    },
  );

  router.delete(
    "/kanban/boards/:boardId/invitations/:invitationId",
    async (request, response) => {
      const boardId = idSchema.parse(request.params.boardId);
      const invitationId = idSchema.parse(request.params.invitationId);
      await service.revokeInvitation(
        getUser(response).id,
        boardId,
        invitationId,
      );
      response.status(204).send();
    },
  );

  router.post("/kanban/invitations/accept", async (request, response) => {
    const { token } = invitationTokenSchema.parse(request.body);
    response.json({
      board: await service.acceptInvitation(getUser(response), token),
    });
  });

  return router;
};
