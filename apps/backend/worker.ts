import "dotenv/config";
import { RecordingStatus } from "@prisma/client";
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import talkToChatGPT from "./services/openaiService";
import { prisma } from "./lib/prisma";

const AWS_REGION = process.env.AWS_REGION ?? "ap-south-1";
const S3_BUCKET = process.env.S3_BUCKET;
const ANALYSIS_QUEUE_URL = process.env.ANALYSIS_QUEUE_URL;
const SQS_VISIBILITY_TIMEOUT_SECONDS = Number(
  process.env.SQS_VISIBILITY_TIMEOUT_SECONDS ?? 10 * 60,
);
const ELEVENLABS_STT_MODEL = "scribe_v2";
const OPENAI_ANALYSIS_MODEL = "gpt-4.1-mini";
const ELEVENLABS_SPEECH_TO_TEXT_URL =
  "https://api.elevenlabs.io/v1/speech-to-text";

const CALL_RECORDING_PROMPT_NAME = "call_recording_prompt_1";

const sqs = new SQSClient({ region: AWS_REGION });
const s3 = new S3Client({ region: AWS_REGION });

type AnalysisQueueMessage = {
  recordingId?: unknown;
};

let shouldStop = false;

process.on("SIGINT", () => {
  shouldStop = true;
});

process.on("SIGTERM", () => {
  shouldStop = true;
});

function requireConfig() {
  const missing = [];

  if (!S3_BUCKET) missing.push("S3_BUCKET");
  if (!ANALYSIS_QUEUE_URL) missing.push("ANALYSIS_QUEUE_URL");
  if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!process.env.ELEVENLABS_API_KEY) missing.push("ELEVENLABS_API_KEY");

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

function parseQueueMessage(body: string | undefined) {
  if (!body) {
    throw new Error("SQS message body is empty");
  }

  const parsed = JSON.parse(body) as AnalysisQueueMessage;

  if (
    typeof parsed.recordingId !== "string" ||
    parsed.recordingId.length === 0
  ) {
    throw new Error("SQS message body must include recordingId");
  }

  return { recordingId: parsed.recordingId };
}

async function getRecordingAudio(s3Key: string) {
  const object = await s3.send(
    new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
    }),
  );

  if (!object.Body || typeof object.Body.transformToByteArray !== "function") {
    throw new Error("S3 object body is not readable");
  }

  return Buffer.from(await object.Body.transformToByteArray());
}

function getFilenameFromS3Key(s3Key: string) {
  return s3Key.split("/").pop() ?? "recording.m4a";
}

async function transcribeRecording(audioBuffer: Buffer, filename: string) {
  const audioArrayBuffer = audioBuffer.buffer.slice(
    audioBuffer.byteOffset,
    audioBuffer.byteOffset + audioBuffer.byteLength,
  ) as ArrayBuffer;
  const formData = new FormData();
  formData.append("model_id", ELEVENLABS_STT_MODEL);
  formData.append("tag_audio_events", "true");
  formData.append("diarize", "true");
  formData.append("file", new Blob([audioArrayBuffer]), filename);

  const response = await fetch(ELEVENLABS_SPEECH_TO_TEXT_URL, {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "",
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(
      `ElevenLabs STT failed with ${response.status}: ${await response.text()}`,
    );
  }

  const transcription = (await response.json()) as {
    text?: unknown;
    transcripts?: Array<{ text?: unknown; channel_index?: unknown }>;
  };

  if (typeof transcription.text === "string") {
    return transcription.text;
  }

  if (Array.isArray(transcription.transcripts)) {
    return transcription.transcripts
      .map((transcript) => {
        const speaker =
          typeof transcript.channel_index === "number"
            ? `speaker_${transcript.channel_index}`
            : "speaker";
        const text = typeof transcript.text === "string" ? transcript.text : "";

        return text ? `${speaker}: ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  throw new Error("ElevenLabs STT response did not include transcript text");
}

async function analyseTranscript(transcript: string, systemPrompt: string) {
  const { response: analysisJson } = await talkToChatGPT(
    [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          "Analyze this call transcript.",
          "Return JSON matching the requested schema.",
          "",
          transcript,
        ].join("\n"),
      },
    ],
    {
      gpt_version: OPENAI_ANALYSIS_MODEL,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "recording_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              transcript: { type: "string" },
              summary: { type: "string" },
              sentiment: {
                type: "string",
                enum: ["positive", "neutral", "negative", "mixed", "unknown"],
              },
              keyTopics: { type: "array", items: { type: "string" } },
              actionItems: { type: "array", items: { type: "string" } },
              followUpRequired: { type: "boolean" },
            },
            required: [
              "transcript",
              "summary",
              "sentiment",
              "keyTopics",
              "actionItems",
              "followUpRequired",
            ],
          },
        },
      },
    },
  );

  return JSON.parse(analysisJson);
}

async function processRecording(recordingId: string) {
  console.log(`[worker] Processing recording: ${recordingId}`);

  const prompt = await prisma.prompt.findFirst({
    where: { name: CALL_RECORDING_PROMPT_NAME },
  });

  if (!prompt) {
    throw new Error(`Prompt '${CALL_RECORDING_PROMPT_NAME}' not found in DB`);
  }

  const recording = await prisma.recording.findUnique({
    where: { id: recordingId },
  });

  if (!recording) {
    console.warn(`[worker] Recording ${recordingId} not found; skipping`);
    return;
  }

  if (recording.status === RecordingStatus.pending) {
    throw new Error(`Recording ${recordingId} has not been uploaded yet`);
  }

  await prisma.recording.update({
    where: { id: recording.id },
    data: { status: RecordingStatus.analysing },
  });
  console.log(`[worker] Status -> analysing | recording: ${recordingId}`);

  console.log(`[worker] Fetching audio from S3: ${recording.s3Key}`);
  const audioBuffer = await getRecordingAudio(recording.s3Key);
  console.log(`[worker] Audio fetched (${audioBuffer.byteLength} bytes)`);

  console.log(`[worker] Transcribing with ElevenLabs scribe_v2`);
  const transcript = await transcribeRecording(
    audioBuffer,
    getFilenameFromS3Key(recording.s3Key),
  );
  console.log(`[worker] Transcription done (${transcript.length} chars)`);

  console.log(`[worker] Sending transcript to OpenAI for analysis`);
  const analysis = await analyseTranscript(transcript, prompt.content);
  console.log(`[worker] Analysis complete | sentiment: ${analysis.sentiment}`);

  await prisma.recording.update({
    where: { id: recording.id },
    data: { analysis, status: RecordingStatus.done, promptId: prompt.id },
  });
  console.log(
    `[worker] Saved analysis to DB | recording: ${recordingId} | status -> done`,
  );
}

async function pollQueue() {
  requireConfig();

  console.log("Recording analysis worker started");

  while (!shouldStop) {
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: ANALYSIS_QUEUE_URL,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 20,
        VisibilityTimeout: SQS_VISIBILITY_TIMEOUT_SECONDS,
      }),
    );

    for (const message of response.Messages ?? []) {
      try {
        const { recordingId } = parseQueueMessage(message.Body);
        await processRecording(recordingId);

        if (message.ReceiptHandle) {
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: ANALYSIS_QUEUE_URL,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        }
      } catch (error) {
        console.error("Failed to process recording analysis job", error);
      }
    }
  }

  console.log("Recording analysis worker stopped");
}

pollQueue().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
