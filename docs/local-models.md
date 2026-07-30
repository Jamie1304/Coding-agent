# Local models with Ollama

1. Install Ollama from the official Windows download page.
2. Start the Ollama service.
3. In **AI Providers**, configure Ollama and select **Detect Ollama**.
4. Refresh models to read locally installed models from `http://127.0.0.1:11434`.
5. Enable a model and assign suitable roles in **Model Routing**.

Model downloads are never automatic. Pulling requires explicit confirmation and reports streamed progress. Before confirming a large download, review its model name and published size, free space on the target drive, RAM/VRAM needs, and whether GPU acceleration is available. The daemon API requires `confirmed: true`; deletion also requires confirmation.

Small local models are useful for classification, file ranking, log summaries, and privacy-sensitive trivial work. Their coding and long-context quality can be materially lower than frontier cloud models. Configure context limits conservatively and use deterministic verification.

If detection fails, confirm that `ollama --version` works, the service is running, and `/api/version` responds on the loopback endpoint. The app reports unavailable state without claiming a real local run occurred.
