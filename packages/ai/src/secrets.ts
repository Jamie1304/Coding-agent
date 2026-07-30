import { randomUUID } from "node:crypto";
import { Entry } from "@napi-rs/keyring";
import type { SecretReference } from "./contracts.js";

export interface SecretStore {
  put(service: string, account: string, secret: string): Promise<SecretReference>;
  get(reference: SecretReference): Promise<string | null>;
  delete(reference: SecretReference): Promise<boolean>;
}

export class WindowsCredentialStore implements SecretStore {
  async put(service: string, account: string, secret: string): Promise<SecretReference> {
    if (process.platform !== "win32") {
      throw new Error("Windows Credential Manager is available only on Windows");
    }
    const secretId = randomUUID();
    const target = `${service}:${secretId}`;
    new Entry(target, account).setPassword(secret);
    return {
      provider: "windows-credential-manager",
      service,
      account,
      secretId
    };
  }

  async get(reference: SecretReference): Promise<string | null> {
    const value = new Entry(
      `${reference.service}:${reference.secretId}`,
      reference.account
    ).getPassword();
    return value ?? null;
  }

  async delete(reference: SecretReference): Promise<boolean> {
    try {
      new Entry(`${reference.service}:${reference.secretId}`, reference.account).deletePassword();
      return true;
    } catch {
      return false;
    }
  }
}

export class MemorySecretStore implements SecretStore {
  private values = new Map<string, string>();

  async put(service: string, account: string, secret: string): Promise<SecretReference> {
    const secretId = randomUUID();
    this.values.set(secretId, secret);
    return { provider: "memory-test-store", service, account, secretId };
  }

  async get(reference: SecretReference): Promise<string | null> {
    return this.values.get(reference.secretId) ?? null;
  }

  async delete(reference: SecretReference): Promise<boolean> {
    return this.values.delete(reference.secretId);
  }
}

export function maskSecret(secret: string): string {
  return secret.length <= 4 ? "••••" : `••••${secret.slice(-4)}`;
}
