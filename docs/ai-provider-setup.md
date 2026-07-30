# AI provider setup

Open **AI Providers** in the desktop app. Configure only the providers you need; one working provider or Ollama is sufficient.

For OpenAI, Anthropic, Google Gemini, or xAI:

1. Select **Configure**, then open the linked official provider page.
2. Create an API key on that provider's site. This external step is required because the app cannot create provider accounts or keys.
3. Paste the key into the password field and choose **Store securely**. The renderer clears the field and the daemon writes the value to Windows Credential Manager.
4. Choose **Test**, then **Refresh available models**.
5. Open **Model Routing**, enable specific discovered models, and assign roles.
6. Set a routing profile and budget. Use the simulator before any live request.

Provider endpoints default to the official OpenAI, Anthropic, Gemini, and xAI APIs. The endpoint field supports local mock servers and approved enterprise gateways. Remote non-HTTPS endpoints are rejected; loopback HTTP is allowed for local servers.

For a custom OpenAI-compatible provider, set its base URL, store an API key if required, and refresh `/v1/models`. Manual IDs are preserved when configured through the daemon API. Chat-completions streaming, tool calls, structured output, cancellation, and normalized usage are supported to the extent returned by the server.

The app never returns a complete stored key. **Delete stored key** removes it after confirmation. Removing a provider can also remove its credential and cascades its active model assignments.

Live diagnostic requests require explicit confirmation. Mock-backed tests do not use real credentials or incur provider cost.
