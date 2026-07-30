# Hallucination reduction

AI output cannot be guaranteed hallucination-free. This application therefore treats model statements as proposals, not proof.

Repository claims require deterministic evidence:

- File claims must resolve inside the approved workspace and may include a SHA-256 hash.
- Test and command claims require a matching command artifact with exit code zero.
- Structured output must validate against its JSON Schema.
- External claims without local evidence remain **unknown**.

Missing files, fabricated paths, missing test artifacts, invalid schemas, and nonzero commands are rejected. Tool results and tests override model confidence. Unknown results require escalation and cannot be reported as success.

Large or critical work can require independent verification, preferably using a different provider. Agreement between models is supporting review, not evidence by itself.
