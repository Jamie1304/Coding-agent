export const PRODUCT_NAME = "Personal Codex Agent";
export const PRODUCT_VERSION = "0.3.0";
export const DAEMON_PROTOCOL_VERSION = 1;
export const APPLICATION_DATA_FOLDER = "PersonalCodexAgent";
export const APPLICATION_ID = "com.jamiekanbier.personalcodexagent";

export function isLoopbackUrl(value: string): boolean {
  return /^http:\/\/127\.0\.0\.1:\d+$/.test(value);
}
