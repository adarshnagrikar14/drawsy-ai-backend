import { describe, expect, it, vi } from "vitest";

import {
  AwsProvider,
  awsCredentialDescriptorSchema,
} from "../src/connectors/awsProvider.js";

const config = {
  principalArn: "arn:aws:iam::123456789012:role/DrawsyBackendRole",
  templateUrl:
    "https://drawsy-templates.s3.ap-south-1.amazonaws.com/aws/read-role.yaml",
  roleName: "DrawsyInfrastructureReadRole",
  setupRegion: "ap-south-1",
};

const credentials = {
  accessKeyId: "temporary-access",
  secretAccessKey: "temporary-secret",
  sessionToken: "temporary-session",
};

describe("AwsProvider", () => {
  it("builds a reviewable CloudFormation quick-create URL", async () => {
    const provider = new AwsProvider(config, 15_000);
    const target = new URL(
      await provider.getSetupUrl("external-state", "999999999999"),
    );
    const parameters = new URLSearchParams(target.hash.split("?")[1]);

    expect(target.hostname).toBe("console.aws.amazon.com");
    expect(target.searchParams.get("region")).toBe("ap-south-1");
    expect(parameters.get("templateURL")).toBe(config.templateUrl);
    expect(parameters.get("param_DrawsyPrincipalArn")).toBe(
      config.principalArn,
    );
    expect(parameters.get("param_DrawsyExternalId")).toBe("external-state");
    expect(parameters.get("param_DrawsyAccountId")).toBe("999999999999");
  });

  it("uses a short-lived template URL for the private S3 object", async () => {
    const getTemplateUrl = vi
      .fn()
      .mockResolvedValue(
        "https://drawsy-templates.s3.ap-south-1.amazonaws.com/aws/read-role.yaml?token=short",
      );
    const provider = new AwsProvider(
      {
        ...config,
        templateUrl: undefined,
        templateS3: {
          bucket: "drawsy-templates",
          key: "aws/read-role.yaml",
          region: "ap-south-1",
        },
      },
      15_000,
      { getTemplateUrl },
    );

    const target = new URL(
      await provider.getSetupUrl("external-state", "999999999999"),
    );
    const parameters = new URLSearchParams(target.hash.split("?")[1]);

    expect(getTemplateUrl).toHaveBeenCalledOnce();
    expect(parameters.get("templateURL")).toBe(
      "https://drawsy-templates.s3.ap-south-1.amazonaws.com/aws/read-role.yaml?token=short",
    );
  });

  it("verifies the role with temporary credentials and discovers regions", async () => {
    const assumeRole = vi.fn().mockResolvedValue(credentials);
    const provider = new AwsProvider(config, 15_000, {
      assumeRole,
      identify: vi.fn().mockResolvedValue("999999999999"),
      listRegions: vi.fn().mockResolvedValue(["ap-south-1", "us-east-1"]),
    });

    const result = await provider.verifySetup("external-state", "999999999999");

    expect(assumeRole).toHaveBeenCalledWith(
      "arn:aws:iam::999999999999:role/DrawsyInfrastructureReadRole",
      "external-state",
    );
    expect(result?.account).toMatchObject({
      id: "999999999999",
      name: "AWS account 999999999999",
    });
    expect(result?.capabilities).toEqual(["aws"]);
    expect(
      awsCredentialDescriptorSchema.parse(
        JSON.parse(result?.tokens.accessToken || ""),
      ),
    ).toEqual({
      roleArn: "arn:aws:iam::999999999999:role/DrawsyInfrastructureReadRole",
      externalId: "external-state",
      regions: ["ap-south-1", "us-east-1"],
    });
  });

  it("stays pending until AWS trusts the Drawsy role", async () => {
    const provider = new AwsProvider(config, 15_000, {
      assumeRole: vi.fn().mockResolvedValue(null),
    });

    await expect(
      provider.verifySetup("external-state", "999999999999"),
    ).resolves.toBeNull();
  });
});
