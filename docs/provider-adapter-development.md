# Provider adapter development

Implement `AiProvider` from `@agent/ai`; provider-specific request code must not enter the workflow engine. An adapter supplies capabilities, configuration validation, connection testing, dynamic model discovery, optional token counting, normalized streaming events, cancellation, and health.

Use `checkedFetch` for bounded timeouts and normalized failures. Never include response bodies, authentication headers, custom sensitive headers, or keys in errors. Emit normalized usage and preserve provider-only fields under metadata.

Add the adapter to the daemon factory, extend the provider type schema, and pass the shared mock contract suite: validation, discovery, streaming text/tools, usage, structured output, cancellation, timeout, invalid model, and rate-limit behavior. Live tests must be opt-in and must never be reported as passed without a real credential-backed response.
