/**
 * Gemini REST API wrapper — zero dependencies, just fetch.
 * Uses gemini-3-flash-preview with structured JSON output.
 */
export async function askGemini(
  systemPrompt: string,
  userMessage: string,
  opts?: { json?: boolean; schema?: Record<string, unknown> },
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Set GEMINI_API_KEY env var (https://aistudio.google.com/apikey)");

  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userMessage }] }],
  };

  if (opts?.json) {
    body.generationConfig = {
      responseMimeType: "application/json",
      ...(opts.schema ? { responseJsonSchema: opts.schema } : {}),
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;
  const fetchOpts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };

  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, fetchOpts);

    if ((res.status === 503 || res.status === 429) && attempt < MAX_RETRIES) {
      const wait = 5 * Math.pow(2, attempt - 1); // exponential backoff: 5s, 10s, 20s, 40s
      console.error(`[gemini] ${res.status} — retrying in ${wait}s (${attempt}/${MAX_RETRIES})...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini ${res.status}: ${err}`);
    }

    const data = await res.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    return data.candidates[0].content.parts[0].text;
  }

  throw new Error("Gemini: all retries exhausted");
}
