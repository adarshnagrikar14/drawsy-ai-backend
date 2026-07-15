import {
  AssumeRoleCommand,
  GetCallerIdentityCommand,
  STSClient,
} from "@aws-sdk/client-sts";
import { DescribeRegionsCommand, EC2Client } from "@aws-sdk/client-ec2";
import { z } from "zod";

import { ApiError } from "../http/apiError.js";

import type { AwsCredentialIdentity } from "@aws-sdk/types";
import type { AppConfig } from "../config.js";
import type {
  ConnectorAuthorizationResult,
  ConnectorProvider,
  ConnectorTokens,
} from "./types.js";

const accountIdSchema = z.string().regex(/^\d{12}$/);
const regionSchema = z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/);

export const awsCredentialDescriptorSchema = z
  .object({
    roleArn: z.string().min(20).max(2_048),
    externalId: z.string().min(2).max(1_224),
    regions: z.array(regionSchema).max(64),
  })
  .strict();

export type AwsCredentialDescriptor = z.infer<
  typeof awsCredentialDescriptorSchema
>;

type AwsProviderDependencies = {
  assumeRole?: (
    roleArn: string,
    externalId: string,
  ) => Promise<AwsCredentialIdentity | null>;
  listRegions?: (credentials: AwsCredentialIdentity) => Promise<string[]>;
  identify?: (credentials: AwsCredentialIdentity) => Promise<string | null>;
};

const temporaryCredentials = (
  value:
    | {
        AccessKeyId?: string;
        SecretAccessKey?: string;
        SessionToken?: string;
      }
    | undefined,
): AwsCredentialIdentity | null =>
  value?.AccessKeyId && value.SecretAccessKey && value.SessionToken
    ? {
        accessKeyId: value.AccessKeyId,
        secretAccessKey: value.SecretAccessKey,
        sessionToken: value.SessionToken,
      }
    : null;

const isPendingRoleError = (error: unknown) =>
  error instanceof Error &&
  [
    "AccessDenied",
    "AccessDeniedException",
    "InvalidClientTokenId",
    "UnrecognizedClientException",
  ].includes(error.name);

export class AwsProvider implements ConnectorProvider {
  readonly supportsPkce = false;
  readonly summary = {
    id: "aws",
    name: "AWS",
    capabilities: ["aws"],
    executionMode: "provider_api",
    availability: "preview",
  } as const;

  private readonly assumeRole: NonNullable<
    AwsProviderDependencies["assumeRole"]
  >;
  private readonly listRegions: NonNullable<
    AwsProviderDependencies["listRegions"]
  >;
  private readonly identify: NonNullable<AwsProviderDependencies["identify"]>;

  constructor(
    private readonly config: NonNullable<
      NonNullable<AppConfig["connectors"]>["aws"]
    >,
    private readonly httpTimeoutMs: number,
    dependencies: AwsProviderDependencies = {},
  ) {
    this.assumeRole =
      dependencies.assumeRole ||
      (async (roleArn, externalId) => {
        try {
          const response = await new STSClient({
            region: this.config.setupRegion,
          }).send(
            new AssumeRoleCommand({
              RoleArn: roleArn,
              ExternalId: externalId,
              RoleSessionName: "drawsy-connection-check",
              DurationSeconds: 900,
            }),
            { abortSignal: AbortSignal.timeout(this.httpTimeoutMs) },
          );
          return temporaryCredentials(response.Credentials);
        } catch (error) {
          if (isPendingRoleError(error)) return null;
          throw error;
        }
      });
    this.listRegions =
      dependencies.listRegions ||
      (async (credentials) => {
        const response = await new EC2Client({
          region: this.config.setupRegion,
          credentials,
        }).send(new DescribeRegionsCommand({ AllRegions: false }), {
          abortSignal: AbortSignal.timeout(this.httpTimeoutMs),
        });
        return (response.Regions || [])
          .map((region) => region.RegionName)
          .filter((region): region is string => Boolean(region))
          .filter((region) => regionSchema.safeParse(region).success)
          .sort();
      });
    this.identify =
      dependencies.identify ||
      (async (credentials) => {
        const identity = await new STSClient({
          region: this.config.setupRegion,
          credentials,
        }).send(new GetCallerIdentityCommand({}), {
          abortSignal: AbortSignal.timeout(this.httpTimeoutMs),
        });
        return identity.Account || null;
      });
  }

  getAuthorizationUrl(): string {
    throw new ApiError(
      400,
      "connector_authorization_flow_invalid",
      "AWS uses a guided account setup flow.",
    );
  }

  getSetupUrl(state: string, accountId: string) {
    const account = accountIdSchema.parse(accountId);
    const target = new URL(
      `https://console.aws.amazon.com/cloudformation/home`,
    );
    target.searchParams.set("region", this.config.setupRegion);
    target.hash = `/stacks/quickcreate?${new URLSearchParams({
      templateURL: this.config.templateUrl,
      stackName: "Drawsy-Infrastructure-Read-Access",
      param_DrawsyPrincipalArn: this.config.principalArn,
      param_DrawsyExternalId: state,
      param_DrawsyRoleName: this.config.roleName,
      param_DrawsyAccountId: account,
    })}`;
    return target.toString();
  }

  async verifySetup(
    state: string,
    accountId: string,
  ): Promise<ConnectorAuthorizationResult | null> {
    const account = accountIdSchema.parse(accountId);
    const roleArn = `arn:aws:iam::${account}:role/${this.config.roleName}`;
    let credentials;
    try {
      credentials = await this.assumeRole(roleArn, state);
    } catch (error) {
      throw new ApiError(
        503,
        "connector_aws_backend_identity_unavailable",
        error instanceof Error && error.name === "CredentialsProviderError"
          ? "Drawsy's AWS runtime identity is not configured."
          : "Drawsy could not verify the AWS role.",
      );
    }
    if (!credentials) return null;
    const identifiedAccount = await this.identify(credentials);
    if (identifiedAccount !== account) {
      throw new ApiError(
        502,
        "connector_aws_account_mismatch",
        "AWS returned a different account than the one selected.",
      );
    }
    let regions: string[] = [];
    try {
      regions = await this.listRegions(credentials);
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "connector_aws_regions_unavailable",
          accountId: account,
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
    const descriptor: AwsCredentialDescriptor = {
      roleArn,
      externalId: state,
      regions,
    };
    return {
      account: {
        id: account,
        name: `AWS account ${account}`,
        email: null,
        avatarUrl: null,
        manageUrl: `https://console.aws.amazon.com/iam/home#/roles/details/${encodeURIComponent(
          this.config.roleName,
        )}`,
      },
      tokens: {
        accessToken: JSON.stringify(descriptor),
        refreshToken: null,
        expiresAt: null,
        scopes: ["infrastructure:read", ...regions.map((r) => `region:${r}`)],
      },
      capabilities: ["aws"],
    };
  }

  refresh(tokens: ConnectorTokens) {
    return Promise.resolve(tokens);
  }

  revoke() {
    return Promise.resolve();
  }
}
