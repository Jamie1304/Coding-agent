import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { validatePathWithinWorkspace } from "./security.js";

export interface EvidenceClaim {
  id: string;
  claim: string;
  type: "file" | "command" | "test" | "structured" | "external";
  locator: string;
  expectedHash?: string;
  payload?: unknown;
}

export interface VerificationResult {
  claimId: string;
  state: "verified" | "rejected" | "unknown";
  confidence: number;
  evidence: string;
  requiresEscalation: boolean;
}

export class EvidenceVerifier {
  async verify(
    workspace: string,
    claim: EvidenceClaim,
    context: {
      commandEvidence: Array<{ command: string; exitCode: number | null; artifact?: string }>;
      schema?: Record<string, unknown>;
    }
  ): Promise<VerificationResult> {
    if (claim.type === "file") {
      try {
        const path = await validatePathWithinWorkspace(
          workspace,
          isAbsolute(claim.locator) ? claim.locator : join(workspace, claim.locator)
        );
        const details = await stat(path);
        if (!details.isFile()) return rejected(claim.id, "Locator is not a file");
        const content = await readFile(path);
        const hash = createHash("sha256").update(content).digest("hex");
        if (claim.expectedHash && claim.expectedHash !== hash) {
          return rejected(claim.id, "File hash does not match");
        }
        return verified(claim.id, `File exists with sha256:${hash}`);
      } catch {
        return rejected(claim.id, "Referenced file does not exist within the workspace");
      }
    }
    if (claim.type === "command" || claim.type === "test") {
      const evidence = context.commandEvidence.find((item) => item.command === claim.locator);
      if (!evidence) return rejected(claim.id, "No command artifact supports the claim");
      if (evidence.exitCode !== 0)
        return rejected(claim.id, `Command exit code was ${evidence.exitCode}`);
      return verified(
        claim.id,
        `Command completed with exit code 0${evidence.artifact ? `; ${evidence.artifact}` : ""}`
      );
    }
    if (claim.type === "structured") {
      if (!context.schema) return unknown(claim.id, "No validation schema was provided");
      try {
        z.fromJSONSchema(context.schema).parse(claim.payload);
        return verified(claim.id, "Payload conforms to the required JSON schema");
      } catch {
        return rejected(claim.id, "Payload does not conform to the required JSON schema");
      }
    }
    return unknown(claim.id, "External claim has no deterministic local evidence");
  }

  requireSuccess(results: VerificationResult[]): void {
    const invalid = results.find((result) => result.state !== "verified");
    if (invalid) {
      throw new Error(
        invalid.state === "unknown"
          ? `Insufficient evidence: ${invalid.evidence}`
          : `Evidence rejected: ${invalid.evidence}`
      );
    }
  }
}

function verified(claimId: string, evidence: string): VerificationResult {
  return { claimId, state: "verified", confidence: 1, evidence, requiresEscalation: false };
}
function rejected(claimId: string, evidence: string): VerificationResult {
  return { claimId, state: "rejected", confidence: 1, evidence, requiresEscalation: true };
}
function unknown(claimId: string, evidence: string): VerificationResult {
  return { claimId, state: "unknown", confidence: 0, evidence, requiresEscalation: true };
}
