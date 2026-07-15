import type { ConnectorProviderDefinition } from "./types.js";

export const connectorProviderCatalog = [
  {
    id: "google-workspace",
    name: "Google Workspace",
    capabilities: ["mail", "calendar", "drive"],
    executionMode: "provider_api",
    availability: "stable",
  },
  {
    id: "notion",
    name: "Notion",
    capabilities: ["notion"],
    executionMode: "provider_api",
    availability: "stable",
  },
  {
    id: "slack",
    name: "Slack",
    capabilities: ["slack"],
    executionMode: "provider_api",
    availability: "stable",
  },
  {
    id: "github",
    name: "GitHub",
    capabilities: ["github"],
    executionMode: "provider_api",
    availability: "stable",
  },
  {
    id: "read-ai",
    name: "Read AI",
    capabilities: ["read-ai"],
    executionMode: "remote_mcp",
    availability: "preview",
  },
  {
    id: "fireflies",
    name: "Fireflies",
    capabilities: ["fireflies"],
    executionMode: "remote_mcp",
    availability: "stable",
  },
  {
    id: "aws",
    name: "AWS",
    capabilities: ["aws"],
    executionMode: "provider_api",
    availability: "preview",
  },
] as const satisfies readonly ConnectorProviderDefinition[];
