import { ApiError, type BatchJob, type GenerateContentResponse, GoogleGenAI } from "@google/genai";

import { type Segment, validateTranslation } from "./segments";

export interface BatchRequest {
    key: string;
    pageId: string;
    units: Segment[];
}
export interface GeminiOptions {
    apiKey: string;
    model: string;
    prompt: string;
    glossary: Record<string, string>;
    fetch?: typeof fetch;
}
export interface BatchService {
    create(requests: BatchRequest[], displayName: string): Promise<BatchJob>;
    get(name: string): Promise<BatchJob>;
}

export function parseBatchResponse(data: GenerateContentResponse, requests: BatchRequest[]) {
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason !== "STOP") throw new Error("Incomplete Gemini batch response");
    const text = candidate.content?.parts?.filter((part) => !part.thought)
        .map((part) => part.text ?? "").join("") ?? "";
    let result: { requestKey: string; translations: { id: string; translation: string }[] };
    try { result = JSON.parse(text); } catch { throw new Error("Invalid batch response JSON"); }
    const request = requests.find((request) => request.key === result?.requestKey);
    if (!request || !Array.isArray(result.translations)
        || result.translations.length !== request.units.length) {
        throw new Error("Unexpected batch request key or translation count");
    }
    const expected = new Map(request.units.map((unit) => [ unit.id, unit ]));
    const translations: Record<string, string> = {};
    for (const entry of result.translations) {
        const unit = expected.get(entry.id);
        if (!unit || Object.hasOwn(translations, entry.id)) {
            throw new Error("Unexpected or duplicate translation ID");
        }
        validateTranslation(unit.source, entry.translation);
        translations[entry.id] = entry.translation;
    }
    return { key: request.key, translations, modelVersion: data.modelVersion,
        usage: data.usageMetadata };
}

/** SDK retries are disabled: batch creation is not idempotent. */
export function createBatchService(options: GeminiOptions): BatchService {
    const client = new GoogleGenAI({
        apiKey: options.apiKey, enterprise: false, vertexai: false,
        httpOptions: { timeout: 120_000, retryOptions: { attempts: 1 }, fetch: options.fetch }
    });
    async function safe<T>(operation: () => Promise<T>): Promise<T> {
        try { return await operation(); } catch (error) {
            const status = error instanceof ApiError ? error.status : undefined;
            // Never persist SDK messages, which can include request details.
            throw new Error(status ? `Gemini Batch API HTTP ${status}`
                : "Gemini Batch API request failed");
        }
    }
    return {
        create(requests, displayName) {
            const src = requests.map((request) => ({
                metadata: { key: request.key },
                contents: [ { role: "user", parts: [ { text: JSON.stringify({
                    requestKey: request.key, glossary: options.glossary,
                    units: request.units.map(({ id, source, context }) => ({ id, source, context }))
                }) } ] } ],
                config: {
                    systemInstruction: options.prompt,
                    responseMimeType: "application/json",
                    responseJsonSchema: {
                        type: "object", required: [ "requestKey", "translations" ],
                        properties: {
                            requestKey: { type: "string", enum: [ request.key ] },
                            translations: { type: "array", items: {
                                type: "object", required: [ "id", "translation" ],
                                properties: { id: { type: "string" },
                                    translation: { type: "string" } }
                            } }
                        }
                    }
                }
            }));
            if (Buffer.byteLength(JSON.stringify(src), "utf8") > 19_000_000) {
                throw new Error("Inline batch exceeds 19 MB; reduce --limit");
            }
            return safe(() => client.batches.create({ model: options.model, src,
                config: { displayName } }));
        },
        get(name) { return safe(() => client.batches.get({ name })); }
    };
}
