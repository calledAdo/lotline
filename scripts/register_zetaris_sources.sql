-- Registers every Lotline source in Zetaris. Run with:  npm run setup:zetaris
-- One statement per call; ${VAR} placeholders are filled from .env by scripts/zsql.mjs,
-- so no credential is written in this file. Re-runs: drop first with teardown_zetaris_sources.sql.

-- 1. The hospital's own system of record (PostgreSQL): item master, lots by location,
--    dispensing history and open purchase orders. NDCs here are 11-digit, unhyphenated.
CREATE DATASOURCE hospital DESCRIBE BY "Riverside General pharmacy system - synthetic" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "jdbc:postgresql://host.docker.internal:55433/hospital",
  username "${HOSPITAL_DB_USER}",
  password "${HOSPITAL_DB_PASSWORD}",
  fetchsize "1000"
);
REGISTER DATASOURCE TABLES ("locations", "item_master", "inventory_lots", "dispensing_daily", "purchase_orders") FROM hospital;

-- 2. openFDA snapshot (JSON Lines in object storage): recalls, shortages and NDC directory
--    packages for the molecules in scope. NDCs here are hyphenated, in three layouts.
CREATE LIGHTNING DATABASE fda_snapshot DESCRIBE BY "openFDA snapshot - recalls, shortages, NDC directory";
CREATE LIGHTNING FILESTORE TABLE recalls FROM fda_snapshot FORMAT JSON OPTIONS (
  path "s3a://lotline/fda/recalls/", awsAccessKeyId "${S3_ACCESS_KEY}", awsSecretAccessKey "${S3_SECRET_KEY}"
);
CREATE LIGHTNING FILESTORE TABLE shortages FROM fda_snapshot FORMAT JSON OPTIONS (
  path "s3a://lotline/fda/shortages/", awsAccessKeyId "${S3_ACCESS_KEY}", awsSecretAccessKey "${S3_SECRET_KEY}"
);
CREATE LIGHTNING FILESTORE TABLE ndc_packages FROM fda_snapshot FORMAT JSON OPTIONS (
  path "s3a://lotline/fda/ndc_packages/", awsAccessKeyId "${S3_ACCESS_KEY}", awsSecretAccessKey "${S3_SECRET_KEY}"
);

-- 3. Wholesaler catalog (CSV export in object storage): orderable NDCs and the
--    wholesaler's own availability status, which can disagree with FDA's.
CREATE LIGHTNING DATABASE wholesaler DESCRIBE BY "MedLine Distribution catalog export - fictional";
CREATE LIGHTNING FILESTORE TABLE catalog FROM wholesaler FORMAT CSV OPTIONS (
  path "s3a://lotline/wholesaler/catalog/", awsAccessKeyId "${S3_ACCESS_KEY}", awsSecretAccessKey "${S3_SECRET_KEY}",
  header "true", delimiter ","
);

-- 4. Live openFDA (REST tables, re-fetched on query): today's shortage list and ongoing
--    recalls for the molecules in scope. Used to check the snapshot is still current.
CREATE LIGHTNING DATABASE fda_live DESCRIBE BY "openFDA live API - shortages and ongoing recalls";
CREATE LIGHTNING REST TABLE shortages_raw FROM fda_live REQUEST (
  endpoint "https://api.fda.gov/drug/shortages.json?search=generic_name:(ropivacaine+dextrose+ketorolac+%22sodium+bicarbonate%22+furosemide+clindamycin)&limit=1000",
  method "GET", http_encoding "URLENCODED", response_type "JSON", insecure_ssl "false"
) HEADER () BODY ();
CREATE LIGHTNING REST TABLE recalls_raw FROM fda_live REQUEST (
  endpoint "https://api.fda.gov/drug/enforcement.json?search=status:Ongoing+AND+product_description:(ropivacaine+dextrose+ketorolac+%22sodium+bicarbonate%22+furosemide+clindamycin)&limit=1000",
  method "GET", http_encoding "URLENCODED", response_type "JSON", insecure_ssl "false"
) HEADER () BODY ();
CREATE SCHEMASTORE CONTAINER fda_live_views;
CREATE SCHEMASTORE VIEW shortages WITH CONTAINER fda_live_views AS
SELECT s.package_ndc, s.generic_name, s.company_name, s.availability, s.status, s.shortage_reason,
       s.related_info, s.presentation, s.update_date, s.update_type
FROM fda_live.shortages_raw LATERAL VIEW explode(results) AS s;
CREATE SCHEMASTORE VIEW recalls WITH CONTAINER fda_live_views AS
SELECT r.recall_number, r.status, r.classification, r.recalling_firm, r.reason_for_recall,
       r.product_description, r.code_info, r.report_date, r.recall_initiation_date
FROM fda_live.recalls_raw LATERAL VIEW explode(results) AS r;

-- 5. Recall change feed (JSON in object storage): revisions to ongoing recalls, such as
--    expansions to more lots. scripts/drill.ts writes clearly labelled drill revisions here.
CREATE LIGHTNING DATABASE fda_updates DESCRIBE BY "Recall revisions feed - includes labelled drills";
CREATE LIGHTNING FILESTORE TABLE recall_updates FROM fda_updates FORMAT JSON OPTIONS (
  path "s3a://lotline/fda/recall_updates/", awsAccessKeyId "${S3_ACCESS_KEY}", awsSecretAccessKey "${S3_SECRET_KEY}"
);
