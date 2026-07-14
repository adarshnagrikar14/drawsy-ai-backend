import { createHash, randomBytes } from "node:crypto";

import { ApiError } from "../http/apiError.js";
import { ConnectorCrypto } from "./crypto.js";
import { connectorProviderCatalog } from "./catalog.js";
import { ConnectorAiGrantSigner } from "./aiGrant.js";
import { ConnectorAiExecutor } from "./aiExecutor.js";

import type { AppConfig } from "../config.js";
import type {
  ConnectorAiExecutionRequest,
  ConnectorAiGrantRequest,
  ConnectorConnectionStore,
  ConnectorCapability,
  ConnectorProvider,
  ConnectorProviderId,
  ConnectorService,
  StoredConnectorConnection,
} from "./types.js";

const connectionIdFor = (providerId: ConnectorProviderId, accountId: string) =>
  createHash("sha256")
    .update(`${providerId}:${accountId}`, "utf8")
    .digest("base64url");

export class DefaultConnectorService implements ConnectorService {
  private readonly providers: ReadonlyMap<
    ConnectorProviderId,
    ConnectorProvider
  >;
  private readonly crypto: ConnectorCrypto;
  private readonly aiGrantSigner: ConnectorAiGrantSigner;
  private readonly aiExecutor: ConnectorAiExecutor;

  constructor(
    private readonly config: NonNullable<AppConfig["connectors"]>,
    providers: ConnectorProvider[],
    private readonly store: ConnectorConnectionStore,
  ) {
    this.providers = new Map(
      providers.map((provider) => [provider.summary.id, provider]),
    );
    this.crypto = new ConnectorCrypto(
      config.encryptionKeys,
      config.encryptionKeyVersion,
    );
    const currentEncryptionKey = config.encryptionKeys.get(
      config.encryptionKeyVersion,
    );
    if (!currentEncryptionKey) {
      throw new Error("Current connector encryption key is unavailable");
    }
    this.aiGrantSigner = new ConnectorAiGrantSigner(
      currentEncryptionKey,
      config.aiGrantTtlMs,
    );
    this.aiExecutor = new ConnectorAiExecutor(
      config.httpTimeoutMs,
      config.aiMaxOutputBytes,
    );
  }

  async getOverview(userId: string) {
    return {
      providers: connectorProviderCatalog.map((provider) => ({
        ...provider,
        configured: this.providers.has(provider.id),
      })),
      connections: await this.store.listConnections(userId),
    };
  }

  async getAuthorizationUrl(userId: string, providerId: ConnectorProviderId) {
    const provider = this.provider(providerId);
    const codeVerifier = provider.supportsPkce
      ? randomBytes(32).toString("base64url")
      : undefined;
    const { state, attemptId } = await this.store.createOAuthState(
      userId,
      providerId,
      Date.now() + this.config.stateTtlMs,
      codeVerifier,
    );
    const codeChallenge = codeVerifier
      ? createHash("sha256").update(codeVerifier).digest("base64url")
      : undefined;
    return {
      authorizationUrl: provider.getAuthorizationUrl(state, codeChallenge),
      attemptId,
    };
  }

  async completeAuthorization(
    providerId: ConnectorProviderId,
    code: string,
    state: string,
  ) {
    const provider = this.provider(providerId);
    const { userId, attemptId, codeVerifier } =
      await this.store.consumeOAuthState(state, providerId);
    try {
      const { account, tokens, capabilities } =
        await provider.exchangeAuthorizationCode(code, codeVerifier);
      const connectionId = connectionIdFor(providerId, account.id);
      const now = Date.now();
      let createdAt = now;
      try {
        createdAt = (await this.store.getConnection(userId, connectionId))
          .createdAt;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) {
          throw error;
        }
      }
      const connection: StoredConnectorConnection = {
        id: connectionId,
        providerId,
        accountId: account.id,
        accountName: account.name,
        accountEmail: account.email,
        accountAvatarUrl: account.avatarUrl,
        capabilities: [...capabilities],
        scopes: tokens.scopes,
        createdAt,
        updatedAt: now,
        tokens: this.crypto.encrypt(providerId, userId, connectionId, tokens),
      };
      await this.store.saveConnection(userId, connection);
      await this.store.setOAuthAttemptStatus(attemptId, {
        status: "connected",
      });
    } catch (error) {
      await this.store.setOAuthAttemptStatus(attemptId, {
        status: "failed",
        error:
          error instanceof Error && "code" in error
            ? String(error.code)
            : "authorization_failed",
      });
      throw error;
    }
  }

  async failAuthorization(
    providerId: ConnectorProviderId,
    state: string,
    error: string,
  ) {
    const { attemptId } = await this.store.consumeOAuthState(state, providerId);
    await this.store.setOAuthAttemptStatus(attemptId, {
      status: "failed",
      error,
    });
  }

  getAuthorizationStatus(userId: string, attemptId: string) {
    return this.store.getOAuthAttemptStatus(userId, attemptId);
  }

  async deleteConnection(userId: string, connectionId: string) {
    const connection = await this.store.getConnection(userId, connectionId);
    const provider = this.provider(connection.providerId);
    let tokens = this.crypto.decrypt(
      connection.providerId,
      userId,
      connectionId,
      connection.tokens,
    );
    try {
      if (
        tokens.refreshToken &&
        tokens.expiresAt !== null &&
        tokens.expiresAt <= Date.now()
      ) {
        tokens = await provider.refresh(tokens);
      }
      await provider.revoke(tokens);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "connector_upstream_revoke_failed",
          providerId: connection.providerId,
          connectionId,
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
    await this.store.deleteConnection(userId, connectionId);
  }

  async getAuthorizedCredential(
    userId: string,
    connectionId: string,
    capability: ConnectorCapability,
  ) {
    const connection = await this.store.getConnection(userId, connectionId);
    if (!connection.capabilities.includes(capability)) {
      throw new ApiError(
        403,
        "connector_capability_forbidden",
        "The connection did not grant this capability.",
      );
    }
    const provider = this.provider(connection.providerId);
    let tokens = this.crypto.decrypt(
      connection.providerId,
      userId,
      connectionId,
      connection.tokens,
    );
    if (tokens.expiresAt !== null && tokens.expiresAt - Date.now() <= 60_000) {
      tokens = await provider.refresh(tokens);
      await this.store.saveConnection(userId, {
        ...connection,
        scopes: tokens.scopes,
        updatedAt: Date.now(),
        tokens: this.crypto.encrypt(
          connection.providerId,
          userId,
          connectionId,
          tokens,
        ),
      });
    }
    return {
      providerId: connection.providerId,
      accessToken: tokens.accessToken,
    };
  }

  async createAiGrant(userId: string, request: ConnectorAiGrantRequest) {
    const connection = await this.store.getConnection(
      userId,
      request.connectionId,
    );
    this.provider(connection.providerId);
    if (
      request.capabilities.some(
        (capability) => !connection.capabilities.includes(capability),
      )
    ) {
      throw new ApiError(
        403,
        "connector_capability_forbidden",
        "The connection did not grant every requested capability.",
      );
    }
    const { grant, claims } = this.aiGrantSigner.issue(userId, request);
    return {
      grant,
      expiresAt: claims.expiresAt,
      connectionId: claims.connectionId,
      capabilities: [...claims.capabilities],
    };
  }

  async executeAiRequest(grant: string, request: ConnectorAiExecutionRequest) {
    const claims = this.aiGrantSigner.verify(grant);
    if (
      claims.sessionId !== request.sessionId ||
      claims.turnId !== request.turnId ||
      claims.connectionId !== request.connectionId ||
      !claims.capabilities.includes(request.capability)
    ) {
      throw new ApiError(
        403,
        "connector_ai_grant_scope_forbidden",
        "The connector grant does not authorize this request.",
      );
    }
    const credential = await this.getAuthorizedCredential(
      claims.subject,
      claims.connectionId,
      request.capability,
    );
    return this.aiExecutor.execute(
      credential.providerId,
      credential.accessToken,
      request,
    );
  }

  private provider(providerId: ConnectorProviderId) {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new ApiError(
        503,
        "connector_provider_unavailable",
        "Connector provider is not configured.",
      );
    }
    return provider;
  }
}
