-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "country" CHAR(2),
ADD COLUMN     "countryInferred" BOOLEAN NOT NULL DEFAULT false;
