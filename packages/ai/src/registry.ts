import type {
  AiProvider,
  CapabilityEvidence,
  ProviderCapabilities,
  ProviderRecord,
  ProviderSupport,
  ProviderTransport
} from "./contracts.js";

/**
 * Static transport and metadata records for the built-in provider types.
 * These describe how a provider was verified and what its privacy/cost posture is.
 */
const providerMeta: Record<
  string,
  {
    transport: ProviderTransport;
    privacyClassification: ProviderRecord["privacyClassification"];
    documentationUrl: string | null;
    mayPerformRepositoryWrites: boolean;
    costMetadata: ProviderRecord["costMetadata"];
  }
> = {
  openai: {
    transport: "api",
    privacyClassification: "remote-may-train",
    documentationUrl: "https://platform.openai.com/docs",
    mayPerformRepositoryWrites: false,
    costMetadata: { currency: "USD", notes: "Pay-per-token; see platform.openai.com/pricing" }
  },
  anthropic: {
    transport: "api",
    privacyClassification: "remote-no-training",
    documentationUrl: "https://docs.anthropic.com",
    mayPerformRepositoryWrites: false,
    costMetadata: { currency: "USD", notes: "Pay-per-token; see anthropic.com/pricing" }
  },
  google: {
    transport: "api",
    privacyClassification: "remote-may-train",
    documentationUrl: "https://ai.google.dev/gemini-api/docs",
    mayPerformRepositoryWrites: false,
    costMetadata: { currency: "USD", notes: "Pay-per-token; see ai.google.dev/pricing" }
  },
  xai: {
    transport: "api",
    privacyClassification: "remote-may-train",
    documentationUrl: "https://docs.x.ai",
    mayPerformRepositoryWrites: false,
    costMetadata: { currency: "USD", notes: "Pay-per-token; see x.ai/api" }
  },
  ollama: {
    transport: "local-backend",
    privacyClassification: "local-only",
    documentationUrl: "https://ollama.com/docs",
    mayPerformRepositoryWrites: false,
    costMetadata: null
  },
  "openai-compatible": {
    transport: "openai-compatible-api",
    privacyClassification: "unknown",
    documentationUrl: null,
    mayPerformRepositoryWrites: false,
    costMetadata: null
  },
  codex: {
    transport: "app-server",
    privacyClassification: "remote-no-training",
    documentationUrl: "https://platform.openai.com/docs/codex",
    mayPerformRepositoryWrites: true,
    costMetadata: { currency: "USD", notes: "Session-based billing; requires Codex entitlement" }
  }
};

/**
 * Builds capability evidence records from a provider's declared capabilities.
 * All built-in capabilities are verified by inference from the provider implementation
 * rather than a live test, since live tests require credentials.
 */
export function buildCapabilityEvidence(
  capabilities: ProviderCapabilities,
  verifiedAt: string | null = null
): CapabilityEvidence[] {
  return (Object.entries(capabilities) as Array<[keyof ProviderCapabilities, boolean]>).map(
    ([capability, supported]) => ({
      capability,
      supported,
      verifiedAt,
      method: "inferred" as const,
      notes: supported
        ? `Supported by ${capability} implementation`
        : `Not supported; ${capability} is not implemented for this provider type`
    })
  );
}

/**
 * Computes the ProviderSupport status for a provider based on health and configuration.
 */
export function computeSupport(
  hasCredential: boolean,
  healthy: boolean,
  lastDiagnosticAt: string | null
): ProviderSupport {
  if (!hasCredential) return "not-configured";
  if (!lastDiagnosticAt) return "not-verified";
  if (!healthy) return "unavailable";
  return "verified";
}

/**
 * Builds a ProviderRecord from an AiProvider instance plus runtime context.
 */
export function buildProviderRecord(
  provider: AiProvider,
  context: {
    models: string[];
    healthy: boolean;
    hasCredential: boolean;
    lastSuccessfulDiagnosticAt: string | null;
    lastVerifiedVersion: string | null;
    lastVerifiedAt: string | null;
    redactedConfiguration: Record<string, unknown>;
  }
): ProviderRecord {
  const meta = providerMeta[provider.type] ??
    providerMeta["openai-compatible"] ?? {
      transport: "api" as ProviderTransport,
      privacyClassification: "unknown" as const,
      documentationUrl: null,
      mayPerformRepositoryWrites: false,
      costMetadata: null
    };

  const capabilities = provider.getCapabilities();
  const support = computeSupport(
    context.hasCredential,
    context.healthy,
    context.lastSuccessfulDiagnosticAt
  );

  const unavailableReason: Partial<Record<keyof ProviderCapabilities, string>> = {};
  for (const [key, supported] of Object.entries(capabilities) as Array<
    [keyof ProviderCapabilities, boolean]
  >) {
    if (!supported) {
      unavailableReason[key] = `${key} is not implemented for ${provider.type}`;
    }
  }

  return {
    id: provider.id,
    displayName: provider.displayName,
    transport: meta.transport,
    support,
    capabilityEvidence: buildCapabilityEvidence(capabilities, context.lastSuccessfulDiagnosticAt),
    models: context.models,
    healthy: context.healthy,
    lastSuccessfulDiagnosticAt: context.lastSuccessfulDiagnosticAt,
    lastVerifiedVersion: context.lastVerifiedVersion,
    lastVerifiedAt: context.lastVerifiedAt,
    privacyClassification: meta.privacyClassification,
    costMetadata: meta.costMetadata,
    mayPerformRepositoryWrites: meta.mayPerformRepositoryWrites,
    unavailableReasonByCapability: unavailableReason,
    documentationUrl: meta.documentationUrl,
    redactedConfiguration: context.redactedConfiguration
  };
}
