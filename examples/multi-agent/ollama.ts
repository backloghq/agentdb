/**
 * Ollama chat API wrapper with optional JSON mode.
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

  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  const data = await res.json() as { message: { content: string } };
  return data.message.content;
}
