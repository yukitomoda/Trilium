import { setTimeout as delay } from "node:timers/promises";

import { ApiError, type GenerateContentResponse, GoogleGenAI } from "@google/genai";

import { type Segment, validateTranslation } from "./segments";

export interface GeminiOptions {
    apiKey: string;
    model: string;
    prompt: string;
    glossary: Record<string, string>;
    fetch?: typeof fetch;
    retryDelayMs?: number;
}

/** Uses the official SDK in Gemini API mode; credentials stay out of saved errors. */
export async function translateBatch(units: Segment[], options: GeminiOptions) {
    const client = new GoogleGenAI({
        apiKey: options.apiKey, enterprise: false, vertexai: false,
        httpOptions: {
            timeout: 120_000, retryOptions: { attempts: 1 }, fetch: options.fetch
        }
    });
    const schema = {
        type: "object", required: [ "translations" ],
        properties: {
            translations: {
                type: "array", items: {
                    type: "object", required: [ "id", "translation" ],
                    properties: { id: { type: "string" }, translation: { type: "string" } }
                }
            }
        }
    };
    for (let attempt = 0; attempt < 4; attempt++) {
        let data: GenerateContentResponse;
        try {
            data = await client.models.generateContent({
                model: options.model,
                contents: [ { role: "user", parts: [ { text: JSON.stringify({
                    glossary: options.glossary,
                    units: units.map(({ id, source, context }) => ({ id, source, context }))
                }) } ] } ],
                config: {
                    systemInstruction: options.prompt,
                    responseMimeType: "application/json", responseJsonSchema: schema
                }
            });
        } catch (error) {
            const status = error instanceof ApiError ? error.status : undefined;
            const retryable = status === undefined || status === 429 || status >= 500;
            if (retryable && attempt < 3) {
                await delay((options.retryDelayMs ?? 1000) * 2 ** attempt);
                continue;
            }
            // SDK messages can contain request details: persist only the HTTP status.
            throw new Error(status === undefined
                ? "Gemini SDK request failed or timed out (4 attempts)"
                : `Gemini HTTP ${status}; check key, model and quota`);
        }
        const candidate = data.candidates?.[0];
        if (candidate?.finishReason !== "STOP") {
            throw new Error("Incomplete Gemini translation; nothing saved for this batch");
        }
        const parts: { thought?: boolean; text?: string }[] = candidate.content?.parts ?? [];
        const text = parts.filter((part) => !part.thought)
            .map((part) => part.text ?? "").join("");
        let result: { translations?: { id: string; translation: string }[] };
        try { result = JSON.parse(text); } catch {
            throw new Error("Gemini returned invalid JSON");
        }
        if (!Array.isArray(result.translations) || result.translations.length !== units.length) {
            throw new Error("Gemini returned an unexpected translation count");
        }
        const expected = new Map(units.map((unit) => [ unit.id, unit ]));
        const translations = new Map<string, string>();
        for (const entry of result.translations) {
            const unit = expected.get(entry.id);
            if (!unit || translations.has(entry.id)) {
                throw new Error("Unexpected or duplicate unit ID");
            }
            validateTranslation(unit.source, entry.translation);
            translations.set(entry.id, entry.translation);
        }
        return { translations, modelVersion: data.modelVersion, usage: data.usageMetadata };
    }
    throw new Error("Gemini retry limit reached");
}
