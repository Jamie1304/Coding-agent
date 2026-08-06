/**
 * Generic IDE bridge contract.
 *
 * Any IDE integration (VS Code, JetBrains, Neovim, etc.) implements this
 * interface so the core orchestrator can request context and surface results
 * without taking a direct dependency on any specific IDE's API.
 */

/** A file currently open in the IDE editor. */
export interface OpenFile {
  /** Absolute file path. */
  path: string;
  /** Language identifier (e.g. "typescript", "python"). */
  languageId: string;
  /** Whether this file has unsaved changes. */
  isDirty: boolean;
}

/** A region of text selected by the user in the active editor. */
export interface TextSelection {
  /** Absolute file path of the editor that owns the selection. */
  filePath: string;
  /** Zero-based start line. */
  startLine: number;
  /** Zero-based end line (inclusive). */
  endLine: number;
  /** The selected text. */
  text: string;
}

/** Diagnostics (errors, warnings) from the IDE's language servers. */
export interface DiagnosticItem {
  filePath: string;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  line: number;
  column: number;
  source?: string;
}

/** Workspace context the IDE can provide to the agent. */
export interface IdeWorkspaceContext {
  /** Root folder of the workspace (the checked-out repository path). */
  workspaceRoot: string;
  /** All currently open files. */
  openFiles: OpenFile[];
  /** Active text selection, if any. */
  activeSelection: TextSelection | null;
  /** Current diagnostics visible to the user. */
  diagnostics: DiagnosticItem[];
}

/** Methods an IDE bridge implementation must provide. */
export interface IdeBridge {
  /** Name of the IDE this bridge targets (e.g. "vscode", "jetbrains"). */
  readonly ideId: string;

  /** Returns the current workspace context. */
  getWorkspaceContext(): Promise<IdeWorkspaceContext>;

  /**
   * Opens a file in the IDE editor, optionally jumping to a specific line.
   * @param filePath Absolute file path to open.
   * @param line Zero-based line number to scroll to (optional).
   */
  openFile(filePath: string, line?: number): Promise<void>;

  /**
   * Shows a notification banner in the IDE.
   * @param message Human-readable message.
   * @param level Log/notification level.
   */
  showNotification(message: string, level: "info" | "warning" | "error"): Promise<void>;

  /**
   * Applies a set of text edits to a file without opening it visually.
   * Used to stage AI-generated changes into the editor buffer so the user can
   * review them via the IDE diff viewer before saving.
   *
   * @param filePath Absolute path to the file.
   * @param newContent Complete new content of the file.
   */
  applyEdit(filePath: string, newContent: string): Promise<void>;

  /**
   * Asks the user a yes/no question via the IDE quick-pick / dialog.
   * Returns true if the user confirmed, false if they declined or dismissed.
   */
  askConfirmation(question: string): Promise<boolean>;

  /**
   * Disposes any resources held by this bridge (event listeners, IPC sockets, etc.).
   */
  dispose(): void;
}

/**
 * Null implementation of IdeBridge for use in tests and CLI-only contexts
 * where no IDE is present.
 */
export class NoopIdeBridge implements IdeBridge {
  readonly ideId = "noop";

  async getWorkspaceContext(): Promise<IdeWorkspaceContext> {
    return { workspaceRoot: process.cwd(), openFiles: [], activeSelection: null, diagnostics: [] };
  }

  async openFile(): Promise<void> {}
  async showNotification(): Promise<void> {}
  async applyEdit(): Promise<void> {}

  async askConfirmation(): Promise<boolean> {
    return false;
  }

  dispose(): void {}
}
