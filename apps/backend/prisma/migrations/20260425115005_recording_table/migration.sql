-- CreateEnum
CREATE TYPE "RecordingStatus" AS ENUM ('pending', 'uploaded', 'analysing', 'done');

-- CreateTable
CREATE TABLE "recordings" (
    "id" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "contact_name" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "s3_key" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "status" "RecordingStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_at" TIMESTAMP(3),

    CONSTRAINT "recordings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recordings_sha256_key" ON "recordings"("sha256");
