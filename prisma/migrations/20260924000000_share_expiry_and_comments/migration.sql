-- AlterTable
ALTER TABLE "ShareRelation" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ShareRelation_expiresAt_idx" ON "ShareRelation"("expiresAt");

-- CreateTable
CREATE TABLE IF NOT EXISTS "DocComment" (
    "id" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "anchor" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DocComment_docId_createdAt_idx" ON "DocComment"("docId", "createdAt" DESC);

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DocComment_docId_fkey'
  ) THEN
    ALTER TABLE "DocComment" ADD CONSTRAINT "DocComment_docId_fkey"
      FOREIGN KEY ("docId") REFERENCES "Doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DocComment_userId_fkey'
  ) THEN
    ALTER TABLE "DocComment" ADD CONSTRAINT "DocComment_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
