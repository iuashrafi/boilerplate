import "dotenv/config";
import OpenAI, { APIError } from "openai";
import { ChatCompletionMessageParam } from "openai/resources";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export default async function talkToChatGPT(
  chat: ChatCompletionMessageParam[],
  overrides: any = {},
) {
  overrides.api_key = overrides.api_key || OPENAI_API_KEY;
  // overrides.gpt_version = overrides.gpt_version ?? "gpt-4o";
  overrides.max_tokens = overrides.max_tokens ?? 2000;
  overrides.temperature = overrides.temperature ?? 1;
  overrides.max_retry = overrides.max_retry ?? 3;

  const openAiClient = new OpenAI({
    apiKey: OPENAI_API_KEY,
    maxRetries: overrides.max_retry || 3,
  });

  try {
    const response = await openAiClient.chat.completions.create({
      model: overrides.gpt_version ?? "gpt-4.1-mini",
      max_tokens: overrides.max_tokens,
      temperature: overrides.temperature,
      messages: chat,
      response_format: overrides.response_format,
    });

    const responseText = response.choices[0].message.content?.trim();
    if (!responseText) {
      throw new Error("No response from OpenAI");
    }

    return { response: responseText, usage: response.usage! };
  } catch (error) {
    if (error instanceof APIError) {
      const meta: Record<string, string | number | boolean> = {
        status: error.status ?? "unknown",
        code: error.code ?? "unknown",
        model: overrides.gpt_version ?? "gpt-4.1-mini",
      };
    }

    throw error;
  }
}
