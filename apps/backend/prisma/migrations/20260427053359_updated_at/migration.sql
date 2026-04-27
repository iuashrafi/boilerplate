/*
  Warnings:

  - Added the required column `updated_at` to the `prompts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `recordings` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "prompts" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "recordings" ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;
