import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentRun,
  PromptRevision,
  Question,
  TimelineEvent,
  WorkspaceAnalysis
} from "@agent/shared";
import type {
  DiscoveredModel,
  ProviderConfiguration,
  ProviderType,
  RoutingConfig,
  RoutingDecision,
  StrategyId
} from "@agent/ai";
import "./styles.css";

interface RunView {
  run: AgentRun;
  analysis?: WorkspaceAnalysis;
  questions: Question[];
  revisions: PromptRevision[];
  events: TimelineEvent[];
}

interface EnvironmentDiagnostic {
  id: string;
  name: string;
  level: "PASS" | "WARNING" | "OPTIONAL" | "ACTION REQUIRED" | "FAIL";
  requirement: "required" | "optional" | "integration";
  detail: string;
  resolvedPath: string | null;
  version: string | null;
  blocking: boolean;
  repairCommand: string | null;
  inAppAction: string | null;
}

interface EnvironmentReport {
  generatedAt: string;
  checks: EnvironmentDiagnostic[];
}

interface RuntimeStatus {
  phase: "starting" | "ready" | "recovering" | "failed" | "stopped";
  message: string;
  attempts: number;
  safeMode: boolean;
  updatedAt: string;
}

interface SetupComponent {
  id: "git" | "codex" | "vscode" | "vscode-extension" | "github" | "ollama";
  name: string;
  requiredFor: string;
  status: "available" | "missing" | "failed" | "not_checked";
  version: string | null;
  detail: string;
  lastCheckedAt: string | null;
  lastActionAt: string | null;
}

interface SetupState {
  schemaVersion: 1;
  productVersion: string;
  updatedAt: string;
  components: SetupComponent[];
}

type Section =
  | "New Run"
  | "Active Run"
  | "Run History"
  | "Project Configuration"
  | "Setup & Connections"
  | "AI Providers"
  | "Model Routing"
  | "Cost Dashboard"
  | "Parallel Execution"
  | "Verification"
  | "Settings"
  | "Help";

function App(): React.JSX.Element {
  const [section, setSection] = useState<Section>("New Run");
  const [connection, setConnection] = useState<{ url: string; token: string } | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus>({
    phase: "starting",
    message: "Starting the local runtime…",
    attempts: 0,
    safeMode: false,
    updatedAt: new Date().toISOString()
  });
  const [workspace, setWorkspace] = useState<WorkspaceAnalysis | null>(null);
  const [prompt, setPrompt] = useState(localStorage.getItem("prompt-draft") ?? "");
  const [run, setRun] = useState<RunView | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [rejection, setRejection] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<ProviderCard[]>([]);
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [usage, setUsage] = useState<Array<Record<string, unknown>>>([]);
  const [environment, setEnvironment] = useState<EnvironmentReport | null>(null);
  const [setupState, setSetupState] = useState<SetupState | null>(null);

  const connectRuntime = async (safeMode = false): Promise<void> => {
    setError(null);
    const details = safeMode
      ? await window.agentDesktop.retryRuntime(true)
      : await window.agentDesktop.connection();
    setConnection(details);
    const response = await fetch(`${details.url}/api/workspace/current`, {
      headers: { "x-agent-token": details.token }
    });
    const data = (await response.json()) as { analysis: WorkspaceAnalysis | null };
    setWorkspace(data.analysis);
    setRuntime(await window.agentDesktop.runtimeStatus());
  };

  useEffect(() => {
    let mounted = true;
    const refresh = async (): Promise<void> => {
      try {
        const status = await window.agentDesktop.runtimeStatus();
        if (mounted) setRuntime(status);
        if (status.phase === "ready" && !connection) await connectRuntime();
      } catch (cause) {
        if (mounted) setError(`Runtime status failed: ${String(cause)}`);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [connection]);

  const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    if (!connection) throw new Error("Daemon is not connected");
    const response = await fetch(`${connection.url}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-agent-token": connection.token,
        ...init?.headers
      }
    });
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
    return body;
  };

  const perform = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const refreshEnvironment = (): void => {
    if (!connection) return;
    void api<EnvironmentReport>("/api/setup/diagnostics")
      .then(setEnvironment)
      .catch((cause: unknown) => setError(`Diagnostic refresh failed: ${String(cause)}`));
  };

  const refreshSetupState = (): void => {
    void window.agentDesktop
      .setupStatus()
      .then((state) => setSetupState(state as SetupState))
      .catch((cause: unknown) => setError(`Setup status failed: ${String(cause)}`));
  };

  useEffect(() => {
    if (!connection) return;
    if (["AI Providers", "Model Routing", "Setup & Connections"].includes(section)) {
      void api<{ providers: ProviderCard[] }>("/api/providers")
        .then((result) => setProviders(result.providers))
        .catch((cause: unknown) => setError(String(cause)));
    }
    if (section === "Setup & Connections") {
      refreshEnvironment();
      refreshSetupState();
    }
    if (section === "Cost Dashboard") {
      void api<{ usage: Array<Record<string, unknown>> }>("/api/usage")
        .then((result) => setUsage(result.usage))
        .catch((cause: unknown) => setError(String(cause)));
    }
  }, [section, connection]);

  useEffect(() => {
    if (!connection || section !== "Model Routing") return;
    void Promise.all(
      providers.map((provider) =>
        api<{ models: DiscoveredModel[] }>(`/api/providers/${provider.configuration.id}/models`)
      )
    ).then((results) => setModels(results.flatMap((result) => result.models)));
  }, [providers, section, connection]);

  const selectWorkspace = (): void => {
    void perform(async () => {
      const path = await window.agentDesktop.selectFolder();
      if (!path) return;
      const data = await api<{ analysis: WorkspaceAnalysis }>("/api/workspace/current", {
        method: "POST",
        body: JSON.stringify({
          snapshot: {
            path,
            name: path.split(/[\\/]/).at(-1),
            trusted: true,
            source: "manual"
          },
          metadata: {
            source: "desktop",
            timestamp: new Date().toISOString(),
            clientInstanceId: getDesktopClientId()
          }
        })
      });
      setWorkspace(data.analysis);
    });
  };

  const createRun = (): void => {
    void perform(async () => {
      if (!workspace) throw new Error("Select the exact workspace before reviewing a prompt");
      const created = await api<RunView>("/api/runs", {
        method: "POST",
        body: JSON.stringify({ workspacePath: workspace.snapshot.path, prompt, relevantPaths: [] })
      });
      setRun(created);
      setSection("Active Run");
      localStorage.removeItem("prompt-draft");
    });
  };

  const answerQuestions = (): void => {
    if (!run) return;
    void perform(async () => {
      const updated = await api<RunView>(`/api/runs/${run.run.id}/answers`, {
        method: "POST",
        body: JSON.stringify({
          answers: run.questions
            .filter((question) => !question.confirmed && answers[question.id])
            .map((question) => ({ questionId: question.id, answer: answers[question.id] }))
        })
      });
      setRun(updated);
    });
  };

  const approve = (): void => {
    if (!run) return;
    void perform(async () => {
      setRun(
        await api<RunView>(`/api/runs/${run.run.id}/approve`, {
          method: "POST",
          body: "{}"
        })
      );
    });
  };

  const reject = (): void => {
    if (!run) return;
    void perform(async () => {
      setRun(
        await api<RunView>(`/api/runs/${run.run.id}/reject`, {
          method: "POST",
          body: JSON.stringify({ reason: rejection })
        })
      );
      setRejection("");
    });
  };

  const currentRevision = run?.revisions.at(-1);
  const setupOk = Boolean(connection);
  const navItems: Section[] = [
    "New Run",
    "Active Run",
    "Run History",
    "Project Configuration",
    "Setup & Connections",
    "AI Providers",
    "Model Routing",
    "Cost Dashboard",
    "Parallel Execution",
    "Verification",
    "Settings",
    "Help"
  ];

  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span className="mark">C</span>
          <div>
            <strong>Personal Codex</strong>
            <small>Autonomous development agent</small>
          </div>
        </div>
        <nav aria-label="Primary">
          {navItems.map((item) => (
            <button
              key={item}
              className={section === item ? "active" : ""}
              onClick={() => setSection(item)}
            >
              <span>{icons[item]}</span>
              {item}
            </button>
          ))}
        </nav>
        <div className="connection">
          <i className={setupOk ? "online" : "offline"} />
          {setupOk ? "Daemon connected" : "Daemon offline"}
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">LOCAL WORKSPACE AGENT</p>
            <h1>{section}</h1>
          </div>
          <div className="header-status">
            <span className={workspace ? "ok" : "warn"}>
              {workspace ? "Workspace ready" : "Workspace required"}
            </span>
            <span>{run ? run.run.state.replaceAll("_", " ") : "No active run"}</span>
          </div>
        </header>
        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}
        {!connection && (
          <RuntimeStartup
            runtime={runtime}
            busy={busy}
            onRetry={() =>
              void perform(async () => {
                await window.agentDesktop.retryRuntime(false);
                await connectRuntime();
              })
            }
            onSafeMode={() =>
              void perform(async () => {
                await connectRuntime(true);
              })
            }
            onExport={() =>
              void perform(async () => {
                const path = await window.agentDesktop.exportDiagnostics();
                if (path) setError(`Diagnostics exported to ${path}`);
              })
            }
            onLogs={() => void window.agentDesktop.openLogs()}
            onExit={() => void window.agentDesktop.quit()}
          />
        )}
        {connection && section === "New Run" && (
          <NewRun
            workspace={workspace}
            prompt={prompt}
            busy={busy}
            onPrompt={(value) => {
              setPrompt(value);
              localStorage.setItem("prompt-draft", value);
            }}
            onSelect={selectWorkspace}
            onReview={createRun}
          />
        )}
        {connection && section === "Active Run" && (
          <ActiveRun
            run={run}
            revision={currentRevision}
            answers={answers}
            rejection={rejection}
            busy={busy}
            onAnswer={(id, value) => setAnswers((current) => ({ ...current, [id]: value }))}
            onContinue={answerQuestions}
            onApprove={approve}
            onReject={reject}
            onRejection={setRejection}
          />
        )}
        {connection && section === "Setup & Connections" && (
          <Setup
            connection={connection}
            workspace={workspace}
            environment={environment}
            setupState={setupState}
            providerCount={providers.length}
            onSelect={selectWorkspace}
            onRetest={refreshEnvironment}
            onInstall={(component) => {
              if (
                !window.confirm(
                  `Install ${component.name}? This runs the approved package-manager command for the optional component.`
                )
              ) {
                return;
              }
              void perform(async () => {
                const state = await window.agentDesktop.installSetupComponent(component.id, true);
                setSetupState(state as SetupState);
              });
            }}
            onRepair={() =>
              void perform(async () => {
                const result = (await window.agentDesktop.repair()) as { setup: SetupState };
                setSetupState(result.setup);
                refreshEnvironment();
              })
            }
            onInstructions={() => setSection("Help")}
          />
        )}
        {connection && section === "AI Providers" && (
          <ProvidersPage
            providers={providers}
            busy={busy}
            api={api}
            perform={perform}
            refresh={async () => {
              const result = await api<{ providers: ProviderCard[] }>("/api/providers");
              setProviders(result.providers);
            }}
          />
        )}
        {connection && section === "Model Routing" && (
          <RoutingPage models={models} api={api} perform={perform} />
        )}
        {connection && section === "Cost Dashboard" && <CostDashboard usage={usage} />}
        {connection && section === "Parallel Execution" && <ParallelView run={run} />}
        {connection && section === "Verification" && <VerificationView run={run} />}
        {connection &&
          ![
            "New Run",
            "Active Run",
            "Setup & Connections",
            "AI Providers",
            "Model Routing",
            "Cost Dashboard",
            "Parallel Execution",
            "Verification"
          ].includes(section) && <EmptySection section={section} run={run} workspace={workspace} />}
        <section className={`logs ${logsOpen ? "open" : ""}`}>
          <button className="log-toggle" onClick={() => setLogsOpen(!logsOpen)}>
            <span>Diagnostics & activity log</span>
            <span>
              {run?.events.length ?? 0} events {logsOpen ? "⌄" : "⌃"}
            </span>
          </button>
          {logsOpen && (
            <div className="log-body">
              {run?.events.length ? (
                run.events.map((event) => (
                  <div key={event.operationId}>
                    <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
                    <code>{event.state}</code>
                    <span>{event.message}</span>
                  </div>
                ))
              ) : (
                <p>Activity will appear here with operation IDs and evidence.</p>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function RuntimeStartup({
  runtime,
  busy,
  onRetry,
  onSafeMode,
  onExport,
  onLogs,
  onExit
}: {
  runtime: RuntimeStatus;
  busy: boolean;
  onRetry(): void;
  onSafeMode(): void;
  onExport(): void;
  onLogs(): void;
  onExit(): void;
}): React.JSX.Element {
  const starting = runtime.phase === "starting" || runtime.phase === "recovering";
  return (
    <section className="card runtime-startup" aria-live="polite">
      <p className="eyebrow">LOCAL RUNTIME</p>
      <h2>{starting ? "Starting Personal Codex Agent" : "Runtime needs attention"}</h2>
      <p className="lead">{runtime.message}</p>
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd>{runtime.phase.replaceAll("_", " ")}</dd>
        </div>
        <div>
          <dt>Recovery attempts</dt>
          <dd>{runtime.attempts}</dd>
        </div>
        <div>
          <dt>Safe mode</dt>
          <dd>{runtime.safeMode ? "Enabled" : "Off"}</dd>
        </div>
      </dl>
      <p className="muted">
        The app starts a loopback-only runtime owned by this desktop session. It does not use a
        system Node.js installation.
      </p>
      <div className="actions">
        <button className="primary" disabled={busy || starting} onClick={onRetry}>
          {busy ? "Retrying…" : "Retry runtime"}
        </button>
        <button className="secondary" disabled={busy || starting} onClick={onSafeMode}>
          Start safe mode
        </button>
        <button className="secondary" onClick={onExport}>
          Export diagnostics
        </button>
        <button className="secondary" onClick={onLogs}>
          Open logs
        </button>
        <button className="secondary" onClick={onExit}>
          Exit
        </button>
      </div>
    </section>
  );
}

function NewRun({
  workspace,
  prompt,
  busy,
  onPrompt,
  onSelect,
  onReview
}: {
  workspace: WorkspaceAnalysis | null;
  prompt: string;
  busy: boolean;
  onPrompt(value: string): void;
  onSelect(): void;
  onReview(): void;
}): React.JSX.Element {
  return (
    <div className="content-grid">
      <section className="card workspace-card">
        <div className="card-title">
          <div>
            <p className="eyebrow">TARGET PROJECT</p>
            <h2>Active workspace</h2>
          </div>
          <button className="secondary" onClick={onSelect}>
            {workspace ? "Change folder" : "Select folder"}
          </button>
        </div>
        {workspace ? (
          <>
            <div className="workspace-name">
              <span className="folder">⌑</span>
              <div>
                <strong>{workspace.snapshot.name}</strong>
                <code>{workspace.snapshot.path}</code>
              </div>
              <span className="badge success">Verified</span>
            </div>
            <dl className="facts">
              <div>
                <dt>Git</dt>
                <dd>{workspace.git.isRepository ? "Repository" : "Not detected"}</dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd>{workspace.git.branch ?? "—"}</dd>
              </div>
              <div>
                <dt>Commit</dt>
                <dd>
                  <code>{workspace.git.commit?.slice(0, 9) ?? "—"}</code>
                </dd>
              </div>
              <div>
                <dt>Working tree</dt>
                <dd className={workspace.git.dirty ? "amber" : "green"}>
                  {workspace.git.dirty ? "Modified" : "Clean"}
                </dd>
              </div>
              <div>
                <dt>Stack</dt>
                <dd>{workspace.technologies.join(", ") || "Unknown"}</dd>
              </div>
              <div>
                <dt>Package manager</dt>
                <dd>{workspace.packageManager ?? "—"}</dd>
              </div>
            </dl>
          </>
        ) : (
          <div className="empty">
            <span>⌑</span>
            <p>
              Select the exact project Codex may inspect. No files are changed during prompt review.
            </p>
          </div>
        )}
      </section>
      <section className="card composer">
        <div className="card-title">
          <div>
            <p className="eyebrow">STEP 1 OF 3</p>
            <h2>Describe the change</h2>
          </div>
          <span className="safe">Read-only review</span>
        </div>
        <label htmlFor="prompt">Development prompt</label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(event) => onPrompt(event.target.value)}
          placeholder="Example: Add keyboard navigation to the command palette, preserve existing shortcuts, and include accessibility tests."
        />
        <div className="context">
          <strong>Detected context</strong>
          <span>
            {workspace
              ? `${workspace.files.length} paths indexed · ${workspace.testCommands.length} quality commands detected`
              : "Select a workspace to generate repository-aware questions."}
          </span>
        </div>
        <div className="actions">
          <button className="secondary" onClick={() => onPrompt("")}>
            Clear
          </button>
          <button
            className="primary"
            disabled={busy || !workspace || prompt.trim().length < 10}
            onClick={onReview}
          >
            {busy ? "Inspecting…" : "Review prompt"} <span>→</span>
          </button>
        </div>
      </section>
    </div>
  );
}

function ActiveRun({
  run,
  revision,
  answers,
  rejection,
  busy,
  onAnswer,
  onContinue,
  onApprove,
  onReject,
  onRejection
}: {
  run: RunView | null;
  revision: PromptRevision | undefined;
  answers: Record<string, string>;
  rejection: string;
  busy: boolean;
  onAnswer(id: string, value: string): void;
  onContinue(): void;
  onApprove(): void;
  onReject(): void;
  onRejection(value: string): void;
}): React.JSX.Element {
  if (!run)
    return (
      <section className="card empty-page">
        <h2>No active run</h2>
        <p>Start with a prompt in New Run.</p>
      </section>
    );
  const unanswered = run.questions.filter(
    (question) => !question.confirmed && !question.superseded
  );
  if (run.run.state === "QUESTIONING")
    return (
      <section className="card questions">
        <p className="eyebrow">CRITICAL ALIGNMENT</p>
        <h2>
          {unanswered.length} decision{unanswered.length === 1 ? "" : "s"} needed
        </h2>
        <p className="lead">
          Only questions that materially affect implementation are shown. Confirmed decisions are
          preserved across revisions.
        </p>
        {unanswered.map((question, index) => (
          <fieldset key={question.id}>
            <legend>
              <span>{index + 1}</span>
              {question.text}
            </legend>
            <p>
              <strong>Why it matters:</strong> {question.reason}
            </p>
            <p>
              <strong>Affects:</strong> {question.affects}
            </p>
            {question.options.length > 0 && (
              <div className="options">
                {question.options.map((option) => (
                  <button
                    key={option}
                    className={answers[question.id] === option ? "selected" : ""}
                    onClick={() => onAnswer(question.id, option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
            <textarea
              aria-label={`Answer to ${question.text}`}
              placeholder="Your answer…"
              value={answers[question.id] ?? ""}
              onChange={(event) => onAnswer(question.id, event.target.value)}
            />
          </fieldset>
        ))}
        <div className="actions">
          <span>
            {run.questions.filter((q) => q.confirmed).length} confirmed decisions retained
          </span>
          <button
            className="primary"
            disabled={busy || unanswered.some((q) => !answers[q.id]?.trim())}
            onClick={onContinue}
          >
            Continue review →
          </button>
        </div>
      </section>
    );
  if (run.run.state === "AWAITING_APPROVAL" && revision)
    return (
      <section className="review">
        <div className="review-head">
          <div>
            <p className="eyebrow">STEP 3 OF 3 · REVISION {revision.revision}</p>
            <h2>Approve the frozen specification</h2>
          </div>
          <span className="badge warn">No writes yet</span>
        </div>
        <div className="diff-grid">
          <article>
            <h3>Original prompt</h3>
            <pre>{run.run.originalPrompt}</pre>
          </article>
          <article className="improved">
            <h3>Improved prompt</h3>
            <pre>{revision.content}</pre>
          </article>
        </div>
        <div className="review-details">
          {[
            ["Changes", revision.changes],
            ["Acceptance criteria", revision.acceptanceCriteria],
            ["Required tests", revision.tests],
            ["Risks", revision.risks]
          ].map(([title, items]) => (
            <div key={title as string}>
              <h3>{title}</h3>
              <ul>
                {(items as string[]).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="reject-box">
          <label htmlFor="rejection">What is incorrect or missing?</label>
          <input
            id="rejection"
            value={rejection}
            onChange={(event) => onRejection(event.target.value)}
            placeholder="Describe the assumption to replace…"
          />
          <button
            className="danger"
            disabled={busy || rejection.trim().length < 3}
            onClick={onReject}
          >
            Reject & revise
          </button>
        </div>
        <div className="approval">
          <p>
            <strong>Approval freezes revision {revision.revision}.</strong>
            <br />
            Only then can Codex work in an isolated Git worktree.
          </p>
          <button className="primary" disabled={busy} onClick={onApprove}>
            Approve & execute →
          </button>
        </div>
      </section>
    );
  return (
    <section className="card progress">
      <p className="eyebrow">EXECUTION TIMELINE</p>
      <h2>{run.run.state.replaceAll("_", " ")}</h2>
      <div className="timeline">
        {run.events.map((event) => (
          <div key={event.operationId} className={event.status}>
            <i />
            <div>
              <strong>{event.state.replaceAll("_", " ")}</strong>
              <p>{event.message}</p>
            </div>
            <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
          </div>
        ))}
      </div>
    </section>
  );
}

function Setup({
  connection,
  workspace,
  environment,
  setupState,
  providerCount,
  onSelect,
  onRetest,
  onInstall,
  onRepair,
  onInstructions
}: {
  connection: { url: string; token: string } | null;
  workspace: WorkspaceAnalysis | null;
  environment: EnvironmentReport | null;
  setupState: SetupState | null;
  providerCount: number;
  onSelect(): void;
  onRetest(): void;
  onInstall(component: SetupComponent): void;
  onRepair(): void;
  onInstructions(): void;
}): React.JSX.Element {
  const checks = [
    ["Local daemon", Boolean(connection), connection?.url ?? "Start npm run dev:daemon"],
    ["SQLite data", Boolean(connection), "Local persistence is available"],
    [
      "VS Code workspace",
      Boolean(workspace),
      workspace?.snapshot.path ?? "Select a folder or connect the extension"
    ],
    [
      "Git repository",
      Boolean(workspace?.git.isRepository),
      workspace?.git.commit ?? "Initialize Git in the project"
    ],
    [
      "Project config",
      workspace?.configStatus === "configured",
      "Create .agent/project.yml to enable GitHub/deployment"
    ],
    ["AI providers", providerCount > 0, `${providerCount} provider(s) configured`]
  ] as const;
  return (
    <section className="card setup">
      <p className="eyebrow">FIRST-RUN DIAGNOSTICS</p>
      <h2>Setup & connections</h2>
      {checks.map(([name, ok, detail]) => (
        <div className="check" key={name}>
          <span className={ok ? "check-ok" : "check-warn"}>{ok ? "✓" : "!"}</span>
          <div>
            <strong>{name}</strong>
            <small>{detail}</small>
          </div>
        </div>
      ))}
      <div className="provider-actions">
        <button className="secondary" onClick={onSelect}>
          Select workspace fallback
        </button>
        <button className="secondary" onClick={onRetest}>
          Retest environment
        </button>
        <button className="secondary" onClick={onRepair}>
          Repair runtime
        </button>
        <button className="secondary" onClick={onInstructions}>
          Open instructions
        </button>
      </div>
      <h3>Core environment & integrations</h3>
      {!environment && <p className="lead">Run diagnostics to inspect local tools.</p>}
      {environment?.checks.map((check) => (
        <div className="check" key={check.id}>
          <span className={check.level === "PASS" ? "check-ok" : "check-warn"}>
            {check.level === "PASS" ? "✓" : "!"}
          </span>
          <div>
            <strong>
              {check.name} · {check.level}
            </strong>
            <small>{check.detail}</small>
            {check.resolvedPath && <code>{check.resolvedPath}</code>}
            {check.repairCommand && <code>Repair: {check.repairCommand}</code>}
            {check.inAppAction && <small>{check.inAppAction}</small>}
            <small>
              {check.blocking ? "Blocks local startup" : "Does not block local startup"}
            </small>
          </div>
        </div>
      ))}
      <h3>Managed optional components</h3>
      {!setupState && <p className="lead">Checking managed components…</p>}
      {setupState?.components.map((component) => (
        <div className="check" key={component.id}>
          <span className={component.status === "available" ? "check-ok" : "check-warn"}>
            {component.status === "available" ? "âœ“" : "!"}
          </span>
          <div>
            <strong>
              {component.name} Â· {component.status.replaceAll("_", " ")}
            </strong>
            <small>{component.detail}</small>
            <small>Used for: {component.requiredFor}</small>
            {component.status !== "available" && component.status !== "not_checked" && (
              <button className="secondary" onClick={() => onInstall(component)}>
                Install with consent
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

interface ProviderCard {
  configuration: Omit<ProviderConfiguration, "secretReference"> & {
    hasSecret: boolean;
    secretReferenceProvider: string | null;
  };
  models: { total: number; enabled: number };
  status: string;
}

type ApiCall = <T>(path: string, init?: RequestInit) => Promise<T>;

function ProvidersPage({
  providers,
  busy,
  api,
  perform,
  refresh
}: {
  providers: ProviderCard[];
  busy: boolean;
  api: ApiCall;
  perform(operation: () => Promise<void>): Promise<void>;
  refresh(): Promise<void>;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [ollamaModel, setOllamaModel] = useState("");
  const [status, setStatus] = useState<Record<string, string>>({});
  const types: ProviderType[] = [
    "openai",
    "anthropic",
    "google",
    "xai",
    "ollama",
    "openai-compatible"
  ];
  const configured = new Set(providers.map((provider) => provider.configuration.type));

  const add = (type: ProviderType): void => {
    void perform(async () => {
      await api("/api/providers", {
        method: "POST",
        body: JSON.stringify(defaultProvider(type))
      });
      await refresh();
      setSelected(type);
    });
  };
  const saveSecret = (id: string): void => {
    void perform(async () => {
      const result = await api<{ masked: string }>(`/api/providers/${id}/secret`, {
        method: "POST",
        body: JSON.stringify({ secret })
      });
      setSecret("");
      setStatus((current) => ({ ...current, [id]: `Stored securely as ${result.masked}` }));
      await refresh();
    });
  };
  const test = (id: string): void => {
    void perform(async () => {
      setStatus((current) => ({ ...current, [id]: "Testing connection…" }));
      const result = await api<{ connected: boolean; message: string }>(
        `/api/providers/${id}/test`,
        { method: "POST", body: "{}" }
      );
      setStatus((current) => ({
        ...current,
        [id]: result.connected ? `Connected · ${result.message}` : result.message
      }));
    });
  };
  const testWithoutSaving = (id: string): void => {
    void perform(async () => {
      const result = await api<{ connected: boolean; message: string }>(
        `/api/providers/${id}/test-secret`,
        { method: "POST", body: JSON.stringify({ secret }) }
      );
      setSecret("");
      setStatus((current) => ({
        ...current,
        [id]: result.connected
          ? `Credential valid (not saved) · ${result.message}`
          : `Credential test failed · ${result.message}`
      }));
    });
  };
  const discover = (id: string): void => {
    void perform(async () => {
      const result = await api<{ models: DiscoveredModel[] }>(
        `/api/providers/${id}/refresh-models`,
        { method: "POST", body: "{}" }
      );
      setStatus((current) => ({
        ...current,
        [id]: `${result.models.length} model(s) discovered`
      }));
      await refresh();
    });
  };
  const updateProvider = (id: string, patch: Record<string, unknown>): void => {
    void perform(async () => {
      await api(`/api/providers/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      await refresh();
    });
  };
  const deleteSecret = (id: string): void => {
    if (!window.confirm("Delete this stored credential? Active cloud routes may stop working."))
      return;
    void perform(async () => {
      await api(`/api/providers/${id}/secret`, { method: "DELETE" });
      setStatus((current) => ({ ...current, [id]: "Credential deleted" }));
      await refresh();
    });
  };
  const removeProvider = (id: string): void => {
    if (!window.confirm("Remove this provider, its model assignments, and its stored credential?"))
      return;
    void perform(async () => {
      await api(`/api/providers/${id}?deleteSecret=true`, { method: "DELETE" });
      setSelected(null);
      await refresh();
    });
  };
  const detectOllama = (id: string): void => {
    void perform(async () => {
      const result = await api<{ installed: boolean; running: boolean; version: string | null }>(
        "/api/ollama/detect",
        { method: "POST", body: JSON.stringify({ providerId: id }) }
      );
      setStatus((current) => ({
        ...current,
        [id]: result.running
          ? `Ollama ${result.version ?? "version unknown"} is running`
          : "Ollama is unavailable. Install it, then start the Ollama service."
      }));
    });
  };
  const pullOllama = (id: string): void => {
    if (!ollamaModel.trim()) return;
    void perform(async () => {
      const plan = await api<{
        model: string;
        knownDownloadSizeBytes: number | null;
        targetDrive: string;
        freeDiskBytes: number;
        memoryBytes: number;
        gpuAcceleration: string;
        suitability: string;
      }>("/api/ollama/models/pull-plan", {
        method: "POST",
        body: JSON.stringify({ providerId: id, model: ollamaModel })
      });
      const size =
        plan.knownDownloadSizeBytes === null
          ? "unknown"
          : `${(plan.knownDownloadSizeBytes / 1024 ** 3).toFixed(1)} GB`;
      const confirmed = window.confirm(
        `Download ${plan.model}?\nKnown size: ${size}\nFree disk on ${plan.targetDrive}: ${(plan.freeDiskBytes / 1024 ** 3).toFixed(1)} GB\nSystem memory: ${(plan.memoryBytes / 1024 ** 3).toFixed(1)} GB\nGPU acceleration: ${plan.gpuAcceleration}\n\n${plan.suitability}`
      );
      if (!confirmed) return;
      const result = await api<{ progress: Array<{ status: string }> }>("/api/ollama/models/pull", {
        method: "POST",
        body: JSON.stringify({ providerId: id, model: ollamaModel, confirmed: true })
      });
      setStatus((current) => ({
        ...current,
        [id]: result.progress.at(-1)?.status ?? "Pull completed"
      }));
      setOllamaModel("");
      discover(id);
    });
  };

  return (
    <section className="provider-page">
      <div className="review-head">
        <div>
          <p className="eyebrow">SECURE SETUP CENTER</p>
          <h2>AI providers</h2>
          <p className="lead">
            Add only the providers you use. Credentials go directly to Windows Credential Manager
            and are immediately cleared here.
          </p>
        </div>
        <span className="badge success">{providers.length} configured</span>
      </div>
      <div className="provider-grid">
        {types.map((type) => {
          const provider = providers.find((item) => item.configuration.type === type);
          const details = providerDetails[type];
          if (!provider) {
            return (
              <article className="provider-card unconfigured" key={type}>
                <div className="provider-logo">{details.label.slice(0, 2)}</div>
                <h3>{details.label}</h3>
                <p>{details.description}</p>
                <span className="badge">Not configured</span>
                <button className="secondary" onClick={() => add(type)}>
                  Configure
                </button>
              </article>
            );
          }
          const isSelected = selected === provider.configuration.id;
          return (
            <article className="provider-card" key={provider.configuration.id}>
              <div className="provider-card-head">
                <div className="provider-logo connected">{details.label.slice(0, 2)}</div>
                <span className={`badge ${provider.status === "connected" ? "success" : "warn"}`}>
                  {provider.status.replaceAll("_", " ")}
                </span>
              </div>
              <h3>{provider.configuration.displayName}</h3>
              <p>
                {provider.models.enabled}/{provider.models.total} models enabled
              </p>
              <small>{status[provider.configuration.id] ?? "Not tested this session"}</small>
              <div className="provider-actions">
                <button
                  className="secondary"
                  onClick={() => setSelected(isSelected ? null : provider.configuration.id)}
                >
                  {isSelected ? "Close" : "Configure"}
                </button>
                <button className="secondary" onClick={() => test(provider.configuration.id)}>
                  Test
                </button>
              </div>
              {isSelected && (
                <div className="provider-wizard">
                  <ol>
                    <li className="done">Provider selected</li>
                    <li
                      className={
                        provider.configuration.hasSecret || type === "ollama" ? "done" : ""
                      }
                    >
                      Authentication
                    </li>
                    <li>Connection & discovery</li>
                    <li>Enable models and assign roles</li>
                  </ol>
                  {type !== "ollama" && (
                    <>
                      <a href={details.setupUrl} target="_blank" rel="noreferrer">
                        Open official provider setup page ↗
                      </a>
                      <label htmlFor={`secret-${provider.configuration.id}`}>API key</label>
                      <div className="secret-entry">
                        <input
                          id={`secret-${provider.configuration.id}`}
                          type="password"
                          autoComplete="off"
                          value={secret}
                          onChange={(event) => setSecret(event.target.value)}
                          placeholder={
                            provider.configuration.hasSecret
                              ? "Credential stored · enter to replace"
                              : "Paste API key"
                          }
                        />
                        <button
                          className="primary"
                          disabled={!secret || busy}
                          onClick={() => saveSecret(provider.configuration.id)}
                        >
                          Store securely
                        </button>
                        <button
                          className="secondary"
                          disabled={!secret || busy}
                          onClick={() => testWithoutSaving(provider.configuration.id)}
                        >
                          Test without saving
                        </button>
                      </div>
                      {provider.configuration.hasSecret && (
                        <button
                          className="secondary danger"
                          onClick={() => deleteSecret(provider.configuration.id)}
                        >
                          Delete stored key
                        </button>
                      )}
                    </>
                  )}
                  <label htmlFor={`endpoint-${provider.configuration.id}`}>Provider endpoint</label>
                  <input
                    id={`endpoint-${provider.configuration.id}`}
                    type="url"
                    defaultValue={provider.configuration.baseUrl}
                    onBlur={(event) => {
                      if (event.target.value !== provider.configuration.baseUrl) {
                        updateProvider(provider.configuration.id, {
                          baseUrl: event.target.value,
                          updatedAt: new Date().toISOString()
                        });
                      }
                    }}
                  />
                  {type === "ollama" && (
                    <>
                      <button
                        className="secondary"
                        onClick={() => detectOllama(provider.configuration.id)}
                      >
                        Detect Ollama
                      </button>
                      <label htmlFor="ollama-model">Model to pull</label>
                      <div className="secret-entry">
                        <input
                          id="ollama-model"
                          value={ollamaModel}
                          onChange={(event) => setOllamaModel(event.target.value)}
                          placeholder="Example: qwen2.5-coder:7b"
                        />
                        <button
                          className="secondary"
                          disabled={!ollamaModel.trim()}
                          onClick={() => pullOllama(provider.configuration.id)}
                        >
                          Review & pull
                        </button>
                      </div>
                    </>
                  )}
                  <button className="secondary" onClick={() => discover(provider.configuration.id)}>
                    Refresh available models
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      updateProvider(provider.configuration.id, {
                        enabled: !provider.configuration.enabled,
                        updatedAt: new Date().toISOString()
                      })
                    }
                  >
                    {provider.configuration.enabled ? "Disable provider" : "Enable provider"}
                  </button>
                  <button
                    className="secondary danger"
                    onClick={() => removeProvider(provider.configuration.id)}
                  >
                    Remove provider
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {!configured.has("ollama") && (
        <p className="lead">
          Local-only operation remains available after configuring Ollama; no cloud provider is
          required.
        </p>
      )}
    </section>
  );
}

function RoutingPage({
  models,
  api,
  perform
}: {
  models: DiscoveredModel[];
  api: ApiCall;
  perform(operation: () => Promise<void>): Promise<void>;
}): React.JSX.Element {
  const [sample, setSample] = useState(
    "Review a contained API change and propose integration tests."
  );
  const [decision, setDecision] = useState<RoutingDecision | null>(null);
  const [budget, setBudget] = useState("5");
  const [profile, setProfile] = useState("balanced");
  const [strategyId, setStrategyId] = useState<StrategyId>("balanced_multi_agent");
  const [strategyCost, setStrategyCost] = useState("");
  const [strategyLocalOnly, setStrategyLocalOnly] = useState(false);
  const [strategyDescription, setStrategyDescription] = useState(
    "Use specialized models for different responsibilities while keeping the workflow controller authoritative."
  );

  useEffect(() => {
    void perform(async () => {
      const config = await api<RoutingConfig>("/api/routing/config");
      setProfile(config.profile);
      if (config.strategy) {
        setStrategyId(config.strategy.id);
        setStrategyCost(config.strategy.maximumCost?.toString() ?? "");
        setStrategyLocalOnly(config.strategy.localOnly ?? false);
        setStrategyDescription(config.strategy.description);
      }
    });
  }, [api, perform]);

  const simulate = (): void => {
    void perform(async () => {
      const result = await api<RoutingDecision>("/api/routing/simulate", {
        method: "POST",
        body: JSON.stringify({
          id: "simulator",
          runId: "simulator",
          title: sample.slice(0, 80),
          description: sample,
          role: "planning",
          expectedInputTokens: Math.ceil(sample.length / 4) + 2_000,
          expectedOutputTokens: 1_000,
          requiredTools: false,
          requiredVision: false,
          repositoryWrite: false,
          sensitive: false,
          likelyFiles: [],
          dependencies: [],
          risk: /security|auth|production|secret/i.test(sample) ? "critical" : "medium"
        })
      });
      setDecision(result);
    });
  };
  const toggle = (model: DiscoveredModel): void => {
    void perform(async () => {
      await api(`/api/models/${model.providerId}/${encodeURIComponent(model.modelId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          enabled: !model.enabled,
          roles: model.roles.length ? model.roles : ["planning", "balanced", "fallback"]
        })
      });
      model.enabled = !model.enabled;
    });
  };
  const saveBudget = (): void => {
    void perform(async () => {
      await api("/api/budgets", {
        method: "PATCH",
        body: JSON.stringify({
          perRunLimit: Number(budget),
          perTaskLimit: Math.max(0.1, Number(budget) / 5),
          dailyLimit: Number(budget) * 4,
          monthlyLimit: Number(budget) * 40,
          warningPercent: 80
        })
      });
    });
  };
  const saveRoutingConfig = (): void => {
    void perform(async () => {
      await api("/api/routing/config", {
        method: "PATCH",
        body: JSON.stringify({
          profile,
          strategy: {
            id: strategyId,
            version: "1.0",
            name: strategyId
              .split("_")
              .map((word) => (word.length ? word.charAt(0).toUpperCase() + word.slice(1) : ""))
              .join(" "),
            description: strategyDescription,
            maximumCost: strategyCost.trim() ? Number(strategyCost) : null,
            localOnly: strategyLocalOnly
          }
        })
      });
    });
  };
  const assignRole = (model: DiscoveredModel, role: string): void => {
    void perform(async () => {
      await api(`/api/models/${model.providerId}/${encodeURIComponent(model.modelId)}`, {
        method: "PATCH",
        body: JSON.stringify({ roles: [role, "fallback"] })
      });
    });
  };

  return (
    <section className="routing-page">
      <div className="review-head">
        <div>
          <p className="eyebrow">DETERMINISTIC · NO PAID CALL</p>
          <h2>Model routing</h2>
          <p className="lead">
            Balanced is recommended. Capability requirements always outrank price.
          </p>
        </div>
        <span className="badge success">Balanced profile</span>
      </div>
      <div className="routing-layout">
        <article className="card model-manager">
          <h3>Discovered models</h3>
          {models.length === 0 && (
            <p className="lead">Configure a provider and refresh its models.</p>
          )}
          {models.map((model) => (
            <div className="model-row" key={`${model.providerId}:${model.modelId}`}>
              <div>
                <strong>{model.displayName}</strong>
                <small>
                  {model.providerId} · {model.local ? "local" : "cloud"} · context{" "}
                  {model.contextWindow?.toLocaleString() ?? "unknown"}
                </small>
              </div>
              <span>{model.roles.join(", ") || "no roles"}</span>
              <select
                aria-label={`Routing role for ${model.displayName}`}
                value={model.roles.find((role) => role !== "fallback") ?? "balanced"}
                onChange={(event) => assignRole(model, event.target.value)}
              >
                {[
                  "local_trivial",
                  "economy",
                  "balanced",
                  "frontier",
                  "coding",
                  "prompt_review",
                  "security_review",
                  "verification"
                ].map((role) => (
                  <option key={role} value={role}>
                    {role.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
              <button className="secondary" onClick={() => toggle(model)}>
                {model.enabled ? "Disable" : "Enable"}
              </button>
            </div>
          ))}
        </article>
        <article className="card simulator">
          <p className="eyebrow">ROUTING SIMULATOR</p>
          <h3>Preview a route</h3>
          <textarea value={sample} onChange={(event) => setSample(event.target.value)} />
          <button className="primary" onClick={simulate}>
            Simulate without model call
          </button>
          {decision && (
            <div className="decision">
              <strong>
                {decision.selectedProviderId} / {decision.selectedModelId}
              </strong>
              <p>
                {decision.taskTier} · estimated ${decision.estimatedCost?.toFixed(4) ?? "unknown"} ·{" "}
                {decision.verificationPolicy}
              </p>
              <small>{decision.reasonCodes.join(" · ")}</small>
              <details>
                <summary>{decision.rejectedCandidates.length} rejected candidates</summary>
                {decision.rejectedCandidates.map((candidate) => (
                  <div key={`${candidate.providerId}:${candidate.modelId}`}>
                    {candidate.providerId}/{candidate.modelId}: {candidate.reasons.join(", ")}
                  </div>
                ))}
              </details>
            </div>
          )}
          <div className="budget-entry">
            <label htmlFor="routing-profile">Routing profile</label>
            <select
              id="routing-profile"
              value={profile}
              onChange={(event) => setProfile(event.target.value)}
            >
              <option value="maximum_savings">Maximum savings</option>
              <option value="balanced">Balanced (recommended)</option>
              <option value="maximum_quality">Maximum quality</option>
              <option value="maximum_privacy">Maximum privacy</option>
              <option value="custom">Custom</option>
            </select>
            <button className="secondary" onClick={saveRoutingConfig}>
              Save routing configuration
            </button>
            <label htmlFor="strategy-id">Strategy</label>
            <select
              id="strategy-id"
              value={strategyId}
              onChange={(event) => setStrategyId(event.target.value as StrategyId)}
            >
              <option value="balanced_multi_agent">Balanced multi-agent</option>
              <option value="cost_optimized">Cost optimized</option>
              <option value="maximum_quality">Maximum quality</option>
              <option value="privacy_first_local">Privacy first local</option>
            </select>
            <label htmlFor="strategy-cost">Maximum strategy spend</label>
            <input
              id="strategy-cost"
              type="number"
              min="0"
              step="0.5"
              value={strategyCost}
              onChange={(event) => setStrategyCost(event.target.value)}
            />
            <label htmlFor="strategy-local-only">
              <input
                id="strategy-local-only"
                type="checkbox"
                checked={strategyLocalOnly}
                onChange={(event) => setStrategyLocalOnly(event.target.checked)}
              />
              Local-only strategy
            </label>
            <label htmlFor="strategy-description">Strategy description</label>
            <textarea
              id="strategy-description"
              value={strategyDescription}
              onChange={(event) => setStrategyDescription(event.target.value)}
            />
            <button className="secondary" onClick={saveRoutingConfig}>
              Save strategy
            </button>
            <label htmlFor="run-budget">Maximum cost per run (USD)</label>
            <input
              id="run-budget"
              type="number"
              min="0"
              step="0.5"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            />
            <button className="secondary" onClick={saveBudget}>
              Save budget
            </button>
          </div>
        </article>
      </div>
    </section>
  );
}

function CostDashboard({ usage }: { usage: Array<Record<string, unknown>> }): React.JSX.Element {
  const cost = usage.reduce(
    (sum, item) => sum + Number(item.actual_cost ?? item.estimated_cost ?? 0),
    0
  );
  const cached = usage.reduce((sum, item) => sum + Number(item.cached_tokens ?? 0), 0);
  const providers = new Set(usage.map((item) => String(item.provider_id)));
  return (
    <section className="card dashboard">
      <p className="eyebrow">NORMALIZED USAGE</p>
      <h2>Token & cost dashboard</h2>
      <div className="metric-grid">
        <div>
          <span>Current month</span>
          <strong>${cost.toFixed(4)}</strong>
        </div>
        <div>
          <span>Model tasks</span>
          <strong>{usage.length}</strong>
        </div>
        <div>
          <span>Providers used</span>
          <strong>{providers.size}</strong>
        </div>
        <div>
          <span>Cached tokens</span>
          <strong>{cached.toLocaleString()}</strong>
        </div>
      </div>
      <p className="lead">
        Actual provider cost is shown when returned; otherwise the configured model price produces
        an estimate. Unknown prices remain unknown.
      </p>
    </section>
  );
}

function ParallelView({ run }: { run: RunView | null }): React.JSX.Element {
  const nodes = run?.events.slice(-8) ?? [];
  return (
    <section className="card">
      <p className="eyebrow">BOUNDED TASK DAG</p>
      <h2>Parallel execution</h2>
      <p className="lead">
        Independent read-only tasks may run concurrently. Code writers require isolated worktrees
        and non-overlapping file ownership; production actions remain serial.
      </p>
      <div className="dag">
        {nodes.length ? (
          nodes.map((event, index) => (
            <div key={event.operationId}>
              <i>{index + 1}</i>
              <strong>{event.state}</strong>
              <span>{event.status}</span>
            </div>
          ))
        ) : (
          <p>No active workers.</p>
        )}
      </div>
    </section>
  );
}

function VerificationView({ run }: { run: RunView | null }): React.JSX.Element {
  return (
    <section className="card">
      <p className="eyebrow">EVIDENCE OVERRIDES MODEL CONFIDENCE</p>
      <h2>Verification</h2>
      <div className="verification-list">
        {(run?.events ?? []).slice(-10).map((event) => (
          <div key={event.operationId}>
            <span className={event.status === "passed" ? "check-ok" : "check-warn"}>
              {event.status === "passed" ? "✓" : "!"}
            </span>
            <div>
              <strong>{event.message}</strong>
              <small>{event.operationId}</small>
            </div>
          </div>
        ))}
        {!run && (
          <p className="lead">
            Claims, file hashes, command exits, conflicts, and unknowns appear here during a run.
          </p>
        )}
      </div>
    </section>
  );
}

function defaultProvider(type: ProviderType): ProviderConfiguration {
  const now = new Date().toISOString();
  const baseUrl: Record<ProviderType, string> = {
    openai: "https://api.openai.com",
    anthropic: "https://api.anthropic.com",
    google: "https://generativelanguage.googleapis.com",
    xai: "https://api.x.ai",
    ollama: "http://127.0.0.1:11434",
    "openai-compatible": "http://127.0.0.1:1234"
  };
  return {
    id: type,
    type,
    displayName: providerDetails[type].label,
    enabled: true,
    baseUrl: baseUrl[type],
    secretReference: null,
    organization: null,
    project: null,
    mode: type === "openai" ? "responses" : type === "ollama" ? "native" : "chat-completions",
    modelsPath:
      type === "google"
        ? "/v1beta/models"
        : type === "ollama"
          ? "/api/tags"
          : type === "xai"
            ? "/v1/language-models"
            : "/v1/models",
    timeoutMs: 120_000,
    tlsVerification: true,
    sensitiveHeadersReference: null,
    nonSecretHeaders: {},
    manualModels: [],
    createdAt: now,
    updatedAt: now
  };
}

const providerDetails: Record<
  ProviderType,
  { label: string; description: string; setupUrl: string }
> = {
  openai: {
    label: "OpenAI",
    description: "Responses API, tools, structured output, and dynamic models.",
    setupUrl: "https://platform.openai.com/api-keys"
  },
  anthropic: {
    label: "Anthropic",
    description: "Claude Messages, tools, caching, and token counting.",
    setupUrl: "https://console.anthropic.com/settings/keys"
  },
  google: {
    label: "Google Gemini",
    description: "Gemini streaming, function calling, and discovered models.",
    setupUrl: "https://aistudio.google.com/app/apikey"
  },
  xai: {
    label: "xAI",
    description: "Grok streaming, structured output, tools, and model metadata.",
    setupUrl: "https://console.x.ai/"
  },
  ollama: {
    label: "Ollama",
    description: "Private models running on this computer.",
    setupUrl: "https://ollama.com/download/windows"
  },
  "openai-compatible": {
    label: "Custom",
    description: "LM Studio or another compatible local/cloud endpoint.",
    setupUrl: "https://lmstudio.ai/"
  }
};

function getDesktopClientId(): string {
  const key = "personal-codex-agent-client-id";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem(key, created);
  return created;
}

function EmptySection({
  section,
  run,
  workspace
}: {
  section: Section;
  run: RunView | null;
  workspace: WorkspaceAnalysis | null;
}): React.JSX.Element {
  const copy: Record<string, string> = {
    "Run History": "Completed and interrupted runs are stored locally in SQLite.",
    "Project Configuration":
      "Project quality, GitHub, deployment, smoke-test, and rollback commands come only from .agent/project.yml.",
    Settings:
      "Provider, logging, data location, and safe execution defaults are local to this machine.",
    Help: "See the bundled setup, architecture, security, testing, and troubleshooting guides."
  };
  return (
    <section className="card empty-page">
      <p className="eyebrow">{section.toUpperCase()}</p>
      <h2>{section}</h2>
      <p>{copy[section]}</p>
      {section === "Run History" && run && (
        <div className="history-row">
          <strong>{run.run.originalPrompt.slice(0, 80)}</strong>
          <span>{run.run.state}</span>
        </div>
      )}
      {section === "Project Configuration" && workspace && (
        <code>{workspace.snapshot.path}\.agent\project.yml</code>
      )}
    </section>
  );
}

const icons: Record<Section, string> = {
  "New Run": "+",
  "Active Run": "◉",
  "Run History": "↺",
  "Project Configuration": "⌘",
  "Setup & Connections": "◇",
  "AI Providers": "✦",
  "Model Routing": "⇄",
  "Cost Dashboard": "$",
  "Parallel Execution": "⋈",
  Verification: "✓",
  Settings: "⚙",
  Help: "?"
};
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
