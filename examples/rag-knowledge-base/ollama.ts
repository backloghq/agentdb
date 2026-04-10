/**
 * Ollama chat + embedding API wrapper.
 */
export async function askOllama(
  systemPrompt: string,
  userMessage: string,
  opts?: { json?: boolean; model?: string },
): Promise<string> {
  const res = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts?.model ?? "llama3.2",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      ...(opts?.json ? { format: "json" } : {}),
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Ollama error ${res.status}`);
  const data = await res.json() as { message: { content: string } };
  return data.message.content;
}

export async function embed(text: string, model = "nomic-embed-text"): Promise<number[]> {
  const res = await fetch("http://localhost:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed error ${res.status}`);
  const data = await res.json() as { embedding: number[] };
  return data.embedding;
}
