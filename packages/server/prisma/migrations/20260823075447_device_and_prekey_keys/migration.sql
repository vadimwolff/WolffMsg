/*
  Warnings:

  - The primary key for the `prekeys` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `prekeys` table. All the data in the column will be lost.
  - Added the required column `keyId` to the `prekeys` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "prekeys" DROP CONSTRAINT "prekeys_pkey",
DROP COLUMN "id",
ADD COLUMN     "keyId" TEXT NOT NULL,
ADD CONSTRAINT "prekeys_pkey" PRIMARY KEY ("deviceId", "keyId");
