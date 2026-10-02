-- G-GZR3-1: Financify's own outcome beside the authority's, so a finding can
-- count where the apps disagree. Additive. The columns fill on the next
-- grain rebuild, which the worker runs once after every start.
-- AlterTable
ALTER TABLE "order_grain" ADD COLUMN     "financifyOutcome" TEXT,
ADD COLUMN     "financifyStatus" TEXT;
