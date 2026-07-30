import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

interface Connection {
  url: string;
  token: string;
}

let status: vscode.StatusBarItem;
let explicitlySelected: vscode.WorkspaceFolder | null = null;
let extensionContext: vscode.ExtensionContext;
let publishTimer: NodeJS.Timeout | null = null;
let clientInstanceId = "";

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  clientInstanceId = context.globalState.get<string>("clientInstanceId") ?? randomUUID();
  void context.globalState.update("clientInstanceId", clientInstanceId);
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  status.command = "personalCodexAgent.open";
  status.text = "$(plug) Codex Agent: connecting";
  status.show();
  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("personalCodexAgent.open", openDesktop),
    vscode.commands.registerCommand("personalCodexAgent.sendSelection", sendSelection),
    vscode.commands.registerCommand("personalCodexAgent.setActiveProject", setActiveProject),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleWorkspacePublish(context)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleWorkspacePublish(context)),
    { dispose: () => publishTimer && clearTimeout(publishTimer) }
  );
  void publishWorkspace(context);
}

function scheduleWorkspacePublish(context: vscode.ExtensionContext): void {
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishTimer = null;
    void publishWorkspace(context);
  }, 250);
}

export function deactivate(): void {}

async function connection(context: vscode.ExtensionContext): Promise<Connection> {
  const configured = vscode.workspace
    .getConfiguration("personalCodexAgent")
    .get<string>("dataDirectory");
  const directory =
    configured ||
    join(process.env.LOCALAPPDATA ?? context.globalStorageUri.fsPath, "PersonalCodexAgent");
  const parsed = JSON.parse(await readFile(join(directory, "daemon.json"), "utf8")) as Connection;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(parsed.url)) throw new Error("Invalid local daemon URL");
  return parsed;
}

function activeFolder(): vscode.WorkspaceFolder | null {
  if (explicitlySelected) return explicitlySelected;
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder;
  }
  return vscode.workspace.workspaceFolders?.[0] ?? null;
}

async function publishWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const folder = activeFolder();
  if (!folder) {
    status.text = "$(warning) Codex Agent: no workspace";
    return;
  }
  if (!vscode.workspace.isTrusted) {
    status.text = "$(shield) Codex Agent: workspace untrusted";
  }
  try {
    const daemon = await connection(context);
    const response = await fetch(`${daemon.url}/api/workspace/current`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-token": daemon.token },
      body: JSON.stringify({
        snapshot: {
          path: folder.uri.fsPath,
          name: folder.name,
          trusted: vscode.workspace.isTrusted,
          activeFile: vscode.window.activeTextEditor?.document.uri.fsPath ?? null,
          source: "vscode"
        },
        metadata: {
          source: "vscode",
          timestamp: new Date().toISOString(),
          clientInstanceId
        }
      })
    });
    if (!response.ok) throw new Error(`daemon returned ${response.status}`);
    status.text = vscode.workspace.isTrusted
      ? `$(check) Codex Agent: ${folder.name}`
      : `$(shield) Codex Agent: ${folder.name} (read-only)`;
    status.tooltip = `Active project: ${folder.uri.fsPath}`;
  } catch (error) {
    status.text = "$(debug-disconnect) Codex Agent: offline";
    status.tooltip = String(error);
  }
}

async function setActiveProject(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage("Open a folder before selecting an active project.");
    return;
  }
  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
    { title: "Select the project Personal Codex Agent may inspect" }
  );
  if (selected) {
    explicitlySelected = selected.folder;
    await publishWorkspace(extensionContext);
  }
}

async function openDesktop(): Promise<void> {
  const uri = vscode.Uri.parse("personal-codex-agent://open");
  const opened = await vscode.env.openExternal(uri);
  if (!opened) {
    void vscode.window.showInformationMessage(
      "Start the desktop app with npm run dev or from the packaged application."
    );
  }
}

async function sendSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const selection = editor?.document.getText(editor.selection).trim();
  if (!selection) {
    void vscode.window.showWarningMessage("Select prompt text in the active editor first.");
    return;
  }
  await vscode.env.clipboard.writeText(selection);
  await openDesktop();
  void vscode.window.showInformationMessage("Selection copied. Paste it into the new-run prompt.");
}
