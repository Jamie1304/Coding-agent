import type { ProjectConfig } from "@agent/shared";
import { QualityGateRunner, type QualityGateResult } from "./quality.js";

export interface DeploymentContext {
  runId: string;
  cwd: string;
  commit: string;
  config: ProjectConfig;
}

export interface DeploymentResult {
  status: "success" | "failed" | "not_configured";
  environment: "staging" | "production";
  evidence: QualityGateResult[];
}

export interface SmokeTestResult {
  status: "success" | "failed" | "not_configured";
  evidence: QualityGateResult[];
}

export interface RollbackResult {
  status: "success" | "failed" | "not_configured";
  evidence: QualityGateResult[];
}

export interface DeploymentAdapter {
  buildArtifact(context: DeploymentContext): Promise<QualityGateResult[]>;
  deployStaging(context: DeploymentContext): Promise<DeploymentResult>;
  testStaging(context: DeploymentContext): Promise<SmokeTestResult>;
  deployProduction(context: DeploymentContext): Promise<DeploymentResult>;
  testProduction(context: DeploymentContext): Promise<SmokeTestResult>;
  rollback(context: DeploymentContext): Promise<RollbackResult>;
}

export class DisabledDeploymentAdapter implements DeploymentAdapter {
  async buildArtifact(_context: DeploymentContext): Promise<QualityGateResult[]> {
    return [];
  }
  async deployStaging(_context: DeploymentContext): Promise<DeploymentResult> {
    return { status: "not_configured", environment: "staging", evidence: [] };
  }
  async testStaging(_context: DeploymentContext): Promise<SmokeTestResult> {
    return { status: "not_configured", evidence: [] };
  }
  async deployProduction(_context: DeploymentContext): Promise<DeploymentResult> {
    return { status: "not_configured", environment: "production", evidence: [] };
  }
  async testProduction(_context: DeploymentContext): Promise<SmokeTestResult> {
    return { status: "not_configured", evidence: [] };
  }
  async rollback(_context: DeploymentContext): Promise<RollbackResult> {
    return { status: "not_configured", evidence: [] };
  }
}

export class CustomCommandDeploymentAdapter implements DeploymentAdapter {
  constructor(private readonly gates = new QualityGateRunner()) {}

  buildArtifact(context: DeploymentContext): Promise<QualityGateResult[]> {
    return this.gates.run(context.cwd, context.config.deployment.build);
  }
  async deployStaging(context: DeploymentContext): Promise<DeploymentResult> {
    return this.deploy(context, "staging", context.config.deployment.staging);
  }
  async testStaging(context: DeploymentContext): Promise<SmokeTestResult> {
    return this.smoke(context, context.config.deployment.stagingSmoke);
  }
  async deployProduction(context: DeploymentContext): Promise<DeploymentResult> {
    if (context.config.deployment.rollback.length === 0) {
      throw new Error("Production deployment requires a configured rollback command");
    }
    return this.deploy(context, "production", context.config.deployment.production);
  }
  async testProduction(context: DeploymentContext): Promise<SmokeTestResult> {
    return this.smoke(context, context.config.deployment.productionSmoke);
  }
  async rollback(context: DeploymentContext): Promise<RollbackResult> {
    const evidence = await this.gates.run(context.cwd, context.config.deployment.rollback);
    return {
      status:
        evidence.length === 0
          ? "not_configured"
          : evidence.every((item) => item.passed)
            ? "success"
            : "failed",
      evidence
    };
  }

  private async deploy(
    context: DeploymentContext,
    environment: "staging" | "production",
    commands: string[]
  ): Promise<DeploymentResult> {
    const evidence = await this.gates.run(context.cwd, commands);
    return {
      status:
        evidence.length === 0
          ? "not_configured"
          : evidence.every((item) => item.passed)
            ? "success"
            : "failed",
      environment,
      evidence
    };
  }

  private async smoke(context: DeploymentContext, commands: string[]): Promise<SmokeTestResult> {
    const evidence = await this.gates.run(context.cwd, commands);
    return {
      status:
        evidence.length === 0
          ? "not_configured"
          : evidence.every((item) => item.passed)
            ? "success"
            : "failed",
      evidence
    };
  }
}

export class FakeDeploymentAdapter implements DeploymentAdapter {
  productionSmokeFails = false;
  rolledBack = false;

  async buildArtifact(_context: DeploymentContext): Promise<QualityGateResult[]> {
    return [];
  }
  async deployStaging(_context: DeploymentContext): Promise<DeploymentResult> {
    return { status: "success", environment: "staging", evidence: [] };
  }
  async testStaging(_context: DeploymentContext): Promise<SmokeTestResult> {
    return { status: "success", evidence: [] };
  }
  async deployProduction(_context: DeploymentContext): Promise<DeploymentResult> {
    return { status: "success", environment: "production", evidence: [] };
  }
  async testProduction(_context: DeploymentContext): Promise<SmokeTestResult> {
    return { status: this.productionSmokeFails ? "failed" : "success", evidence: [] };
  }
  async rollback(_context: DeploymentContext): Promise<RollbackResult> {
    this.rolledBack = true;
    return { status: "success", evidence: [] };
  }
}
