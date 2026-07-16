import {
  DescribeStacksCommand,
  GetTemplateCommand,
  ListStackResourcesCommand,
  ListStacksCommand,
  CloudFormationClient,
} from "@aws-sdk/client-cloudformation";
import { DescribeRegionsCommand, EC2Client } from "@aws-sdk/client-ec2";
import {
  ResourceExplorer2Client,
  SearchCommand,
} from "@aws-sdk/client-resource-explorer-2";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

import { ApiError } from "../http/apiError.js";
import { awsCredentialDescriptorSchema } from "./awsProvider.js";

import type { AwsCredentialIdentity } from "@aws-sdk/types";

const ACTIVE_STACK_STATUSES = [
  "CREATE_IN_PROGRESS",
  "CREATE_FAILED",
  "CREATE_COMPLETE",
  "ROLLBACK_IN_PROGRESS",
  "ROLLBACK_FAILED",
  "ROLLBACK_COMPLETE",
  "DELETE_IN_PROGRESS",
  "DELETE_FAILED",
  "UPDATE_IN_PROGRESS",
  "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
  "UPDATE_COMPLETE",
  "UPDATE_FAILED",
  "UPDATE_ROLLBACK_IN_PROGRESS",
  "UPDATE_ROLLBACK_FAILED",
  "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
  "UPDATE_ROLLBACK_COMPLETE",
  "REVIEW_IN_PROGRESS",
  "IMPORT_IN_PROGRESS",
  "IMPORT_COMPLETE",
  "IMPORT_ROLLBACK_IN_PROGRESS",
  "IMPORT_ROLLBACK_FAILED",
  "IMPORT_ROLLBACK_COMPLETE",
] as const;

const regionPattern = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/;

export class AwsConnectorClient {
  constructor(
    private readonly timeoutMs: number,
    private readonly setupRegion = "us-east-1",
  ) {}

  async listRegions(accessToken: string) {
    const { credentials, descriptor } = await this.credentials(accessToken);
    if (descriptor.regions.length) return descriptor.regions;
    const response = await new EC2Client({
      region: this.setupRegion,
      credentials,
    }).send(new DescribeRegionsCommand({ AllRegions: false }), {
      abortSignal: AbortSignal.timeout(this.timeoutMs),
    });
    return (response.Regions || [])
      .map((region) => region.RegionName)
      .filter((region): region is string =>
        Boolean(region && regionPattern.test(region)),
      )
      .sort();
  }

  async searchResources(input: {
    accessToken: string;
    region: string;
    query: string;
    cursor?: string;
    limit: number;
  }) {
    this.assertRegion(input.region);
    const { credentials } = await this.credentials(input.accessToken);
    try {
      return await new ResourceExplorer2Client({
        region: input.region,
        credentials,
      }).send(
        new SearchCommand({
          QueryString: input.query,
          MaxResults: input.limit,
          NextToken: input.cursor,
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        ["UnauthorizedException", "ResourceNotFoundException"].includes(
          error.name,
        )
      ) {
        throw new ApiError(
          409,
          "connector_aws_resource_explorer_unavailable",
          "AWS Resource Explorer has no usable view in this region. Do not retry this search in the same turn; use CloudFormation inventory, or enable Resource Explorer in AWS for broader discovery.",
        );
      }
      if (error instanceof Error && error.name === "ValidationException") {
        throw new ApiError(
          400,
          "connector_aws_query_invalid",
          "AWS rejected the Resource Explorer query. Use an empty query for all discoverable resources, or valid Resource Explorer search filters.",
        );
      }
      throw this.providerError(
        error,
        "AWS Resource Explorer could not search this region. Do not retry this search in the same turn; use CloudFormation inventory instead.",
      );
    }
  }

  async getResource(accessToken: string, region: string, arn: string) {
    this.assertRegion(region);
    const { credentials } = await this.credentials(accessToken);
    try {
      const result = await new ResourceExplorer2Client({
        region,
        credentials,
      }).send(new SearchCommand({ QueryString: `id:${arn}`, MaxResults: 10 }), {
        abortSignal: AbortSignal.timeout(this.timeoutMs),
      });
      return result.Resources?.find((resource) => resource.Arn === arn) || null;
    } catch (error) {
      throw this.providerError(error, "The AWS resource could not be read.");
    }
  }

  async listStacks(input: {
    accessToken: string;
    region: string;
    cursor?: string;
    limit: number;
  }) {
    this.assertRegion(input.region);
    const { credentials } = await this.credentials(input.accessToken);
    try {
      const result = await new CloudFormationClient({
        region: input.region,
        credentials,
      }).send(
        new ListStacksCommand({
          StackStatusFilter: [...ACTIVE_STACK_STATUSES],
          NextToken: input.cursor,
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
      return {
        stacks: (result.StackSummaries || []).slice(0, input.limit),
        nextCursor: result.NextToken || null,
      };
    } catch (error) {
      throw this.providerError(
        error,
        "CloudFormation stacks could not be listed.",
      );
    }
  }

  async getStack(accessToken: string, region: string, stackId: string) {
    this.assertRegion(region);
    const { credentials } = await this.credentials(accessToken);
    const client = new CloudFormationClient({ region, credentials });
    try {
      const [details, template] = await Promise.all([
        client.send(new DescribeStacksCommand({ StackName: stackId }), {
          abortSignal: AbortSignal.timeout(this.timeoutMs),
        }),
        client.send(
          new GetTemplateCommand({
            StackName: stackId,
            TemplateStage: "Processed",
          }),
          { abortSignal: AbortSignal.timeout(this.timeoutMs) },
        ),
      ]);
      const resources = [];
      let nextToken: string | undefined;
      do {
        const page = await client.send(
          new ListStackResourcesCommand({
            StackName: stackId,
            NextToken: nextToken,
          }),
          { abortSignal: AbortSignal.timeout(this.timeoutMs) },
        );
        resources.push(...(page.StackResourceSummaries || []));
        nextToken = page.NextToken;
      } while (nextToken && resources.length < 2_000);
      return {
        stack: details.Stacks?.[0] || null,
        resources: resources.slice(0, 2_000),
        templateBody: template.TemplateBody || null,
        stagesAvailable: template.StagesAvailable || [],
      };
    } catch (error) {
      throw this.providerError(
        error,
        "The CloudFormation stack could not be read.",
      );
    }
  }

  private async credentials(accessToken: string) {
    let descriptor;
    try {
      descriptor = awsCredentialDescriptorSchema.parse(JSON.parse(accessToken));
    } catch {
      throw new ApiError(
        401,
        "connector_reauthorization_required",
        "Reconnect AWS to refresh its account access.",
      );
    }
    let result;
    try {
      result = await new STSClient({ region: this.setupRegion }).send(
        new AssumeRoleCommand({
          RoleArn: descriptor.roleArn,
          ExternalId: descriptor.externalId,
          RoleSessionName: "drawsy-infrastructure-read",
          DurationSeconds: 900,
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        ["AccessDenied", "AccessDeniedException"].includes(error.name)
      ) {
        throw new ApiError(
          401,
          "connector_reauthorization_required",
          "AWS access changed. Reconnect the account to continue.",
        );
      }
      throw new ApiError(
        503,
        "connector_aws_unavailable",
        "AWS temporary credentials could not be created.",
      );
    }
    const value = result.Credentials;
    if (!value?.AccessKeyId || !value.SecretAccessKey || !value.SessionToken) {
      throw new ApiError(
        502,
        "connector_aws_credentials_invalid",
        "AWS did not return usable temporary credentials.",
      );
    }
    const credentials: AwsCredentialIdentity = {
      accessKeyId: value.AccessKeyId,
      secretAccessKey: value.SecretAccessKey,
      sessionToken: value.SessionToken,
    };
    return { credentials, descriptor };
  }

  private assertRegion(region: string) {
    if (!regionPattern.test(region)) {
      throw new ApiError(
        400,
        "connector_aws_region_invalid",
        "The AWS region is invalid.",
      );
    }
  }

  private providerError(error: unknown, message: string) {
    if (error instanceof ApiError) return error;
    if (
      error instanceof Error &&
      ["AccessDenied", "AccessDeniedException"].includes(error.name)
    ) {
      return new ApiError(
        403,
        "connector_aws_access_denied",
        "AWS denied this read. Check the Drawsy role or narrow the request.",
      );
    }
    return new ApiError(502, "connector_aws_request_failed", message);
  }
}
