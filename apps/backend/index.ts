import express from "express";
import cors from "cors";
import "dotenv/config";
import { PrismaClient, RecordingStatus } from "@prisma/client";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
const prisma = new PrismaClient();

const PORT = Number(process.env.PORT ?? 8080);
const AWS_REGION = process.env.AWS_REGION ?? "ap-south-1";
const S3_BUCKET = process.env.S3_BUCKET;
const UPLOAD_URL_EXPIRES_SECONDS = Number(
  process.env.S3_UPLOAD_URL_EXPIRES_SECONDS ?? 15 * 60,
);

const s3 = new S3Client({ region: AWS_REGION });

app.use(cors());
app.use(express.json({ limit: "1mb" }));

type PrepareRecordingBody = {
  sha256?: unknown;
  displayName?: unknown;
  contactName?: unknown;
  recordedAt?: unknown;
  durationMs?: unknown;
  sizeBytes?: unknown;
  deviceId?: unknown;
};

type ConfirmRecordingBody = {
  recordingId?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function getFileExtension(displayName: string) {
  const extension = displayName.split(".").pop();

  if (!extension || extension === displayName) {
    return "";
  }

  return `.${extension.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

function getS3Key(sha256: string, displayName: string) {
  return `recordings/${sha256}${getFileExtension(displayName)}`;
}

function validatePrepareBody(body: unknown) {
  const errors: string[] = [];

  if (!isRecord(body)) {
    return { errors: ["JSON request body is required"] };
  }

  const prepareBody = body as PrepareRecordingBody;

  if (!isNonEmptyString(prepareBody.sha256)) errors.push("sha256 is required");
  if (!isNonEmptyString(prepareBody.displayName)) {
    errors.push("displayName is required");
  }
  if (!isPositiveInteger(prepareBody.recordedAt)) {
    errors.push("recordedAt must be a positive Unix timestamp in ms");
  }
  if (!isPositiveInteger(prepareBody.durationMs)) {
    errors.push("durationMs must be a positive integer");
  }
  if (!isPositiveInteger(prepareBody.sizeBytes)) {
    errors.push("sizeBytes must be a positive integer");
  }
  if (!isNonEmptyString(prepareBody.deviceId))
    errors.push("deviceId is required");
  if (
    prepareBody.contactName !== undefined &&
    prepareBody.contactName !== null &&
    typeof prepareBody.contactName !== "string"
  ) {
    errors.push("contactName must be a string");
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    value: {
      sha256: prepareBody.sha256 as string,
      displayName: prepareBody.displayName as string,
      contactName: (prepareBody.contactName as string | undefined) ?? null,
      recordedAt: new Date(prepareBody.recordedAt as number),
      durationMs: prepareBody.durationMs as number,
      sizeBytes: prepareBody.sizeBytes as number,
      deviceId: prepareBody.deviceId as string,
    },
  };
}

function validateConfirmBody(body: unknown) {
  if (!isRecord(body)) {
    return { errors: ["JSON request body is required"] };
  }

  const confirmBody = body as ConfirmRecordingBody;

  if (!isNonEmptyString(confirmBody.recordingId)) {
    return { errors: ["recordingId is required"] };
  }

  return { value: { recordingId: confirmBody.recordingId } };
}

async function getUploadUrl(s3Key: string, sizeBytes: number) {
  if (!S3_BUCKET) {
    throw new Error("S3_BUCKET is not configured");
  }

  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    ContentLength: sizeBytes,
  });

  const uploadUrl = await getSignedUrl(s3, command, {
    expiresIn: UPLOAD_URL_EXPIRES_SECONDS,
  });
  const uploadUrlExpiresAt = new Date(
    Date.now() + UPLOAD_URL_EXPIRES_SECONDS * 1000,
  ).toISOString();

  return { uploadUrl, uploadUrlExpiresAt };
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/recordings/prepare", async (req, res, next) => {
  try {
    const parsed = validatePrepareBody(req.body);

    if ("errors" in parsed) {
      return res.status(400).json({ errors: parsed.errors });
    }

    const { displayName, ...recordingData } = parsed.value;
    const s3Key = getS3Key(recordingData.sha256, displayName);
    const existingRecording = await prisma.recording.findUnique({
      where: { sha256: recordingData.sha256 },
    });

    if (
      existingRecording &&
      existingRecording.status !== RecordingStatus.pending
    ) {
      return res.status(409).json({
        error: "recording_already_uploaded",
        recordingId: existingRecording.id,
        status: existingRecording.status,
      });
    }

    const recording =
      existingRecording ??
      (await prisma.recording.create({
        data: {
          ...recordingData,
          s3Key,
          status: RecordingStatus.pending,
        },
      }));

    const signedUpload = await getUploadUrl(
      recording.s3Key,
      recording.sizeBytes,
    );

    return res.status(existingRecording ? 200 : 201).json({
      recordingId: recording.id,
      ...signedUpload,
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/recordings/confirm", async (req, res, next) => {
  try {
    const parsed = validateConfirmBody(req.body);

    if ("errors" in parsed) {
      return res.status(400).json({ errors: parsed.errors });
    }

    const recording = await prisma.recording.findUnique({
      where: { id: parsed.value.recordingId },
    });

    if (!recording) {
      return res.status(404).json({ error: "recording_not_found" });
    }

    await prisma.recording.update({
      where: { id: recording.id },
      data: {
        status: RecordingStatus.uploaded,
        uploadedAt: new Date(),
      },
    });

    return res.json({
      status: "uploaded",
      analysisStatus: "queued",
    });
  } catch (error) {
    return next(error);
  }
});

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(error);

    if (
      error instanceof Error &&
      error.message === "S3_BUCKET is not configured"
    ) {
      return res.status(500).json({ error: "s3_bucket_not_configured" });
    }

    return res.status(500).json({ error: "internal_server_error" });
  },
);

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
