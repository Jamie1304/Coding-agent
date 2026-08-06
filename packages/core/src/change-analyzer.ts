import { createHash } from "node:crypto";

/**
 * Classification of a suggested change to a prompt revision.
 */
export type ChangeClassification =
  | "improvement"
  | "neutral"
  | "redundant"
  | "ambiguous"
  | "conflicting"
  | "technically-unrealistic"
  | "unsafe"
  | "untestable"
  | "out-of-pilot-scope"
  | "valid-dependent";

/**
 * Recommended action after analyzing a suggested change.
 */
export type ChangeAction =
  | "accept-as-written"
  | "accept-with-rewording"
  | "suggest-alternative"
  | "split-optional"
  | "ask-question"
  | "reject";

export interface ChangeAnalysis {
  suggestionId: string;
  suggestion: string;
  intendedBenefit: string;
  classification: ChangeClassification;
  effects: {
    userOutcome: string;
    scope: string;
    complexity: string;
    security: string;
    privacy: string;
    cost: string;
    compatibility: string;
    testability: string;
    deliveryRisk: string;
    maintenance: string;
  };
  action: ChangeAction;
  explanation: string;
  proposedAlternative: string | null;
  newQuestions: string[];
  invalidatesApproval: boolean;
}

/**
 * Analyzes proposed changes to a prompt revision using a rule-based engine.
 *
 * The analyzer acts as a critical engineering partner: it does not agree with
 * suggestions merely to satisfy the user. It classifies each suggestion,
 * explains tradeoffs, and recommends the most realistic engineering action.
 */
export class ChangeAnalyzer {
  analyze(suggestion: string, currentContent: string): ChangeAnalysis {
    const lower = suggestion.toLowerCase();
    const id = createHash("sha1").update(suggestion).digest("hex").slice(0, 12);

    let classification: ChangeClassification = "improvement";
    let action: ChangeAction = "accept-as-written";
    let explanation = "The suggestion improves clarity or specificity.";
    let proposedAlternative: string | null = null;
    const newQuestions: string[] = [];
    let invalidatesApproval = false;

    const intendedBenefit = inferBenefit(suggestion);

    // Detect unsafe suggestions (weakens security invariants)
    if (
      /skip.*auth|bypass.*approval|disable.*validation|remove.*check|no.*test|skip.*test|trust.*all|allow.*all|yolo/i.test(
        suggestion
      )
    ) {
      classification = "unsafe";
      action = "reject";
      explanation =
        "This suggestion weakens a security invariant, approval gate, or test coverage. " +
        "Approval gates and validation cannot be removed without creating a security or reliability regression.";
      proposedAlternative =
        "Define the specific scenario where the check causes a problem, then design a targeted exception that preserves the invariant for all other cases.";
    }

    // Detect technically unrealistic suggestions
    else if (
      /real.?time|instant|zero.?latency|100%.*uptime|always.*available|unlimited/i.test(suggestion)
    ) {
      classification = "technically-unrealistic";
      action = "reject";
      explanation =
        "This requirement cannot be guaranteed in a distributed system or local desktop application. " +
        "Absolute availability and zero-latency are not achievable goals.";
      proposedAlternative =
        "Replace with a measurable SLO: define the acceptable latency percentile and the graceful degradation behavior when the target is missed.";
    }

    // Detect untestable suggestions
    else if (
      /feel.*natural|be.*intuitive|should.*just.*work|magic|automatically.*understand/i.test(
        suggestion
      )
    ) {
      classification = "untestable";
      action = "reject";
      explanation =
        "Subjective quality terms are not testable acceptance criteria. " +
        "A test must be able to pass or fail deterministically.";
      proposedAlternative =
        "Define the specific user action and the expected observable outcome that proves the behavior is correct.";
    }

    // Detect out-of-pilot-scope suggestions
    else if (
      /deploy.*production|publish.*npm|release.*package|mobile.*app|native.*ios|android/i.test(
        suggestion
      )
    ) {
      classification = "out-of-pilot-scope";
      action = "split-optional";
      explanation =
        "This capability is outside the current pilot scope (local desktop agent with Git-based delivery). " +
        "Including it now would delay the pilot definition-of-done.";
      proposedAlternative =
        "Create a separate backlog item for this capability after the pilot is complete.";
    }

    // Detect conflicting suggestions
    else if (suggestionConflictsWithContent(suggestion, currentContent)) {
      classification = "conflicting";
      action = "ask-question";
      explanation =
        "This suggestion conflicts with an existing requirement in the current specification. " +
        "Both cannot be true simultaneously.";
      newQuestions.push(
        "Which requirement should take precedence, and what is the business reason for choosing it?"
      );
      invalidatesApproval = true;
    }

    // Detect redundant suggestions
    else if (redundantWithContent(suggestion, currentContent)) {
      classification = "redundant";
      action = "accept-as-written";
      explanation =
        "This suggestion is already expressed in the current specification. " +
        "No material change is needed, but the wording can be consolidated.";
    }

    // Detect ambiguous suggestions that need clarification
    else if (
      /etc\.|and\s+so\s+on|and\s+more|other\s+things|various|several\s+improvements/i.test(
        suggestion
      )
    ) {
      classification = "ambiguous";
      action = "ask-question";
      explanation =
        "This suggestion is too vague to implement deterministically. " +
        "Each item must be expressed as a specific, testable requirement.";
      newQuestions.push(
        "Which specific behaviors or items are required, and in what priority order?"
      );
    }

    // Detect migration-requiring changes
    else if (
      /change.*schema|rename.*table|rename.*column|alter.*database|remove.*field/i.test(suggestion)
    ) {
      classification = "improvement";
      action = "accept-with-rewording";
      explanation =
        "This schema change is valid but requires an explicit migration plan to preserve existing data.";
      proposedAlternative = suggestion + " — with a versioned migration and rollback procedure.";
      newQuestions.push(
        "What is the migration strategy for existing records affected by this change?"
      );
      invalidatesApproval = true;
    }

    // Default: material improvement
    else if (
      /add.*test|improve.*coverage|add.*validation|clarify|make.*explicit|specify|define/i.test(
        lower
      )
    ) {
      classification = "improvement";
      action = "accept-as-written";
      explanation =
        "This suggestion improves testability, specificity, or clarity without adding scope or risk.";
      invalidatesApproval = true; // Any material content change invalidates prior approval
    }

    // Minor wording with no material change
    else if (suggestion.length < 50 && /rephrase|reword|clarify.*wording/i.test(lower)) {
      classification = "neutral";
      action = "accept-as-written";
      explanation = "This is a wording preference with no material implementation effect.";
      invalidatesApproval = false;
    }

    // General improvement with scope expansion
    else if (/also.*implement|add.*feature|extend.*to|support.*for/i.test(lower)) {
      classification = "improvement";
      action = "ask-question";
      explanation =
        "This suggestion expands the scope. Scope expansion during the revision phase is valid but " +
        "requires confirming that the new behavior fits the current pilot timeline.";
      newQuestions.push(
        "Does this scope expansion remain achievable within the current pilot definition-of-done?"
      );
      invalidatesApproval = true;
    }

    return {
      suggestionId: id,
      suggestion,
      intendedBenefit,
      classification,
      effects: buildEffects(classification, suggestion),
      action,
      explanation,
      proposedAlternative,
      newQuestions,
      invalidatesApproval
    };
  }
}

function inferBenefit(suggestion: string): string {
  const lower = suggestion.toLowerCase();
  if (/test|coverage/.test(lower)) return "Improves test coverage and defect detection confidence";
  if (/security|auth|credential/.test(lower)) return "Strengthens security or access control";
  if (/performance|faster|latency/.test(lower)) return "Improves perceived or actual performance";
  if (/error|failure|recovery/.test(lower)) return "Improves resilience and error recovery";
  if (/simplif|clarif|remov/.test(lower)) return "Reduces complexity or ambiguity";
  return "Increases specification precision or completeness";
}

function buildEffects(
  classification: ChangeClassification,
  suggestion: string
): ChangeAnalysis["effects"] {
  const isRisky = ["unsafe", "conflicting", "technically-unrealistic"].includes(classification);
  const expandsScope = /also|extend|add.*feature|support.*for/.test(suggestion.toLowerCase());
  return {
    userOutcome: isRisky ? "May degrade reliability or security" : "Aligns with the stated goal",
    scope: expandsScope ? "Expands scope" : "Within current scope",
    complexity: expandsScope
      ? "Increases implementation complexity"
      : "No material complexity change",
    security:
      classification === "unsafe"
        ? "Weakens security invariant — do not accept"
        : "No security regression",
    privacy: "No direct privacy impact unless data handling changes",
    cost: expandsScope ? "May increase implementation time" : "No cost impact",
    compatibility: ["conflicting", "migration-requiring"].includes(classification)
      ? "May break existing behavior"
      : "Compatible with existing behavior",
    testability:
      classification === "untestable"
        ? "Cannot be tested deterministically"
        : "Testable with automated assertions",
    deliveryRisk: isRisky ? "High — may introduce regression" : expandsScope ? "Medium" : "Low",
    maintenance: expandsScope
      ? "Adds long-term maintenance surface"
      : "No additional maintenance burden"
  };
}

function suggestionConflictsWithContent(suggestion: string, content: string): boolean {
  const lower = suggestion.toLowerCase();
  // Detect if suggestion contradicts an explicit requirement in the spec
  if (/must\s+not|cannot|never\s+allowed/.test(lower)) {
    // Look for the same keyword in the content as an allowed operation
    const forbidden = lower.match(/must\s+not\s+(\w+)/)?.[1];
    if (forbidden && new RegExp(forbidden, "i").test(content)) {
      return true;
    }
  }
  return false;
}

function redundantWithContent(suggestion: string, content: string): boolean {
  // Check if core keywords of the suggestion already appear prominently in the spec
  const words = suggestion
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 5);
  if (words.length < 2) return false;
  const matchCount = words.filter((word) => content.toLowerCase().includes(word)).length;
  return matchCount >= Math.ceil(words.length * 0.7);
}
