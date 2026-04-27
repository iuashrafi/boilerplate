-- AlterTable
ALTER TABLE "recordings" ADD COLUMN     "prompt_id" UUID;

-- CreateTable
CREATE TABLE "prompts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
