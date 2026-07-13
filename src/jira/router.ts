import { Router } from "express";
import { z } from "zod";

import type { RequestHandler, Response } from "express";
import type { JiraService } from "./types.js";

const id = z.string().trim().min(1).max(256);
const oauthCode = z.string().trim().min(1).max(4_096);
const routeIds = z.object({ connectionId: id, cloudId: id });
const issueRoute = routeIds.extend({ issueKey: id });
const boardRoute = routeIds.extend({ boardId: id });
const sprintRoute = routeIds.extend({ sprintId: id });
const serviceDeskRoute = routeIds.extend({ serviceDeskId: id });
const queueRoute = serviceDeskRoute.extend({ queueId: id });

const userId = (response: Response) => {
  const user = response.locals.user;
  if (!user) {
    throw new Error("Authenticated Jira request is missing user context");
  }
  return user.id;
};

export const createJiraRouter = (
  authenticate: RequestHandler,
  service: JiraService,
  successUrl: string,
) => {
  const router = Router();

  router.get("/jira/oauth/callback", async (request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
    const result = z
      .object({
        code: oauthCode.optional(),
        state: id.optional(),
        error: id.optional(),
        error_description: z.string().trim().max(2_000).optional(),
      })
      .safeParse(request.query);
    const target = new URL(successUrl);
    if (
      !result.success ||
      result.data.error ||
      !result.data.code ||
      !result.data.state
    ) {
      target.searchParams.set(
        "jira_error",
        result.success
          ? result.data.error || "invalid_response"
          : "invalid_response",
      );
      if (result.success && result.data.error) {
        if (result.data.state) {
          await service
            .failAuthorization(result.data.state, result.data.error)
            .catch(() => undefined);
        }
        console.error(
          JSON.stringify({
            level: "error",
            message: "jira_oauth_denied",
            error: result.data.error,
            description: result.data.error_description,
          }),
        );
      }
      target.searchParams.set("jira", "error");
      response.redirect(303, target.toString());
      return;
    }
    try {
      await service.completeAuthorization(result.data.code, result.data.state);
      target.searchParams.set("jira", "connected");
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "jira_oauth_callback_failed",
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
      target.searchParams.set("jira", "error");
      target.searchParams.set(
        "jira_error",
        error instanceof Error && "code" in error
          ? String(error.code)
          : "authorization_failed",
      );
    }
    response.redirect(303, target.toString());
  });

  router.use("/jira", authenticate);

  router.post("/jira/oauth/start", async (_request, response) => {
    response.json(await service.getAuthorizationUrl(userId(response)));
  });
  router.get("/jira/oauth/attempts/:attemptId", async (request, response) => {
    const { attemptId } = z.object({ attemptId: id }).parse(request.params);
    response.json(
      await service.getAuthorizationStatus(userId(response), attemptId),
    );
  });
  router.get("/jira/connections", async (_request, response) => {
    response.json({
      connections: await service.listConnections(userId(response)),
    });
  });
  router.delete(
    "/jira/connections/:connectionId",
    async (request, response) => {
      const { connectionId } = z
        .object({ connectionId: id })
        .parse(request.params);
      await service.deleteConnection(userId(response), connectionId);
      response.status(204).end();
    },
  );

  router.get(
    "/jira/connections/:connectionId/sites/:cloudId/projects",
    async (request, response) => {
      const values = routeIds.parse(request.params);
      response.json(
        await service.request(
          userId(response),
          values.connectionId,
          values.cloudId,
          "/project/search?expand=description,lead,issueTypes&maxResults=100&orderBy=name",
        ),
      );
    },
  );
  router.get(
    "/jira/connections/:connectionId/sites/:cloudId/users/assignable",
    async (request, response) => {
      const values = routeIds.parse(request.params);
      const { projectKey } = z.object({ projectKey: id }).parse(request.query);
      response.json(
        await service.request(
          userId(response),
          values.connectionId,
          values.cloudId,
          `/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=100`,
        ),
      );
    },
  );
  router.get(
    "/jira/connections/:connectionId/sites/:cloudId/priorities",
    async (request, response) => {
      const values = routeIds.parse(request.params);
      const priorities = await service.request<unknown[]>(
        userId(response),
        values.connectionId,
        values.cloudId,
        "/priority",
      );
      response.json({ values: priorities });
    },
  );
  router.get(
    "/jira/connections/:connectionId/sites/:cloudId/boards",
    async (request, response) => {
      const values = routeIds.parse(request.params);
      const query = z
        .object({ projectKey: id.optional() })
        .parse(request.query);
      const suffix = query.projectKey
        ? `?projectKeyOrId=${encodeURIComponent(query.projectKey)}&maxResults=100`
        : "?maxResults=100";
      response.json(
        await service.request(
          userId(response),
          values.connectionId,
          values.cloudId,
          `/board${suffix}`,
          {},
          "software",
        ),
      );
    },
  );
  router.post(
    "/jira/connections/:connectionId/sites/:cloudId/issues/search",
    async (request, response) => {
      const values = routeIds.parse(request.params);
      const body = z
        .object({
          jql: z.string().trim().min(1).max(10_000),
          maxResults: z.number().int().min(1).max(100).default(100),
          nextPageToken: z.string().optional(),
        })
        .parse(request.body);
      response.json(
        await service.request(
          userId(response),
          values.connectionId,
          values.cloudId,
          "/search/jql",
          {
            method: "POST",
            body: JSON.stringify({
              ...body,
              fields: [
                "summary",
                "description",
                "status",
                "issuetype",
                "priority",
                "assignee",
                "updated",
                "comment",
                "sprint",
                "customfield_10016",
              ],
              expand: "names,schema",
            }),
          },
        ),
      );
    },
  );
  router.get(
    "/jira/connections/:connectionId/sites/:cloudId/issues/:issueKey",
    async (request, response) => {
      const values = issueRoute.parse(request.params);
      response.json(
        await service.request(
          userId(response),
          values.connectionId,
          values.cloudId,
          `/issue/${encodeURIComponent(values.issueKey)}?expand=names,schema,renderedFields,transitions`,
        ),
      );
    },
  );
  router.post(
    "/jira/connections/:connectionId/sites/:cloudId/issues",
    async (request, response) => {
      const values = routeIds.parse(request.params);
      const body = z
        .object({ fields: z.record(z.string(), z.unknown()) })
        .parse(request.body);
      response.status(201).json(
        await service.request(
          userId(response),
          values.connectionId,
          values.cloudId,
          "/issue",
          {
            method: "POST",
            body: JSON.stringify(body),
          },
        ),
      );
    },
  );
  router.put(
    "/jira/connections/:connectionId/sites/:cloudId/issues/:issueKey",
    async (request, response) => {
      const values = issueRoute.parse(request.params);
      const body = z
        .object({
          fields: z.record(z.string(), z.unknown()).optional(),
          update: z.record(z.string(), z.unknown()).optional(),
        })
        .refine((value) => value.fields || value.update)
        .parse(request.body);
      await service.request(
        userId(response),
        values.connectionId,
        values.cloudId,
        `/issue/${encodeURIComponent(values.issueKey)}`,
        {
          method: "PUT",
          body: JSON.stringify(body),
        },
      );
      response.status(204).end();
    },
  );
  router.get(
    "/jira/connections/:connectionId/sites/:cloudId/issues/:issueKey/transitions",
    async (request, response) => {
      const values = issueRoute.parse(request.params);
      response.json(
        await service.request(
          userId(response),
          values.connectionId,
          values.cloudId,
          `/issue/${encodeURIComponent(values.issueKey)}/transitions?expand=transitions.fields`,
        ),
      );
    },
  );
  router.post(
    "/jira/connections/:connectionId/sites/:cloudId/issues/:issueKey/transitions",
    async (request, response) => {
      const values = issueRoute.parse(request.params);
      const body = z
        .object({ transition: z.object({ id }) })
        .parse(request.body);
      await service.request(
        userId(response),
        values.connectionId,
        values.cloudId,
        `/issue/${encodeURIComponent(values.issueKey)}/transitions`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );
      response.status(204).end();
    },
  );
  router.post(
    "/jira/connections/:connectionId/sites/:cloudId/issues/:issueKey/comments",
    async (request, response) => {
      const values = issueRoute.parse(request.params);
      const body = z.object({ body: z.unknown() }).parse(request.body);
      response.status(201).json(
        await service.request(
          userId(response),
          values.connectionId,
          values.cloudId,
          `/issue/${encodeURIComponent(values.issueKey)}/comment`,
          {
            method: "POST",
            body: JSON.stringify(body),
          },
        ),
      );
    },
  );
  router.get(
    "/jira/connections/:connectionId/sites/:cloudId/boards/:boardId/sprints",
    async (request, response) => {
      const values = boardRoute.parse(request.params);
      const state = z
        .enum(["active", "future", "closed"])
        .optional()
        .parse(request.query.state);
      response.json(
        await service.request(
          userId(response),
          values.connectionId,
          values.cloudId,
          `/board/${encodeURIComponent(values.boardId)}/sprint?maxResults=100${state ? `&state=${state}` : ""}`,
          {},
          "software",
        ),
      );
    },
  );
  router.get(
    "/jira/connections/:connectionId/sites/:cloudId/boards/:boardId/backlog",
    async (request, response) => {
      const values = boardRoute.parse(request.params);
      response.json(
        await service.request(
          userId(response),
          values.connectionId,
          values.cloudId,
          `/board/${encodeURIComponent(values.boardId)}/backlog?maxResults=100`,
          {},
          "software",
        ),
      );
    },
  );
  router.put(
    "/jira/connections/:connectionId/sites/:cloudId/sprints/:sprintId",
    async (request, response) => {
      const values = sprintRoute.parse(request.params);
      const body = z
        .object({ state: z.enum(["active", "closed"]) })
        .parse(request.body);
      response.json(
        await service.request(
          userId(response),
          values.connectionId,
          values.cloudId,
          `/sprint/${encodeURIComponent(values.sprintId)}`,
          { method: "PUT", body: JSON.stringify(body) },
          "software",
        ),
      );
    },
  );
  router.get(
    "/jira/connections/:connectionId/sites/:cloudId/service-desks",
    async (request, response) => {
      const values = routeIds.parse(request.params);
      response.json(
        await service.request(
          userId(response),
          values.connectionId,
          values.cloudId,
          "/servicedesk?limit=100",
          {},
          "servicedesk",
        ),
      );
    },
  );
  router.get(
    "/jira/connections/:connectionId/sites/:cloudId/service-desks/:serviceDeskId/queues",
    async (request, response) => {
      const values = serviceDeskRoute.parse(request.params);
      response.json(
        await service.request(
          userId(response),
          values.connectionId,
          values.cloudId,
          `/servicedesk/${encodeURIComponent(values.serviceDeskId)}/queue?limit=100`,
          {},
          "servicedesk",
        ),
      );
    },
  );
  router.get(
    "/jira/connections/:connectionId/sites/:cloudId/service-desks/:serviceDeskId/queues/:queueId/issues",
    async (request, response) => {
      const values = queueRoute.parse(request.params);
      response.json(
        await service.request(
          userId(response),
          values.connectionId,
          values.cloudId,
          `/servicedesk/${encodeURIComponent(values.serviceDeskId)}/queue/${encodeURIComponent(values.queueId)}/issue?limit=100`,
          {},
          "servicedesk",
        ),
      );
    },
  );

  return router;
};
