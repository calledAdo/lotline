-- Removes everything register_zetaris_sources.sql creates. SchemaStore views and their
-- container have no SQL drop in this Zetaris build; remove them in Data Explorer if needed.
DROP DATASOURCE hospital;
DROP LIGHTNING DATABASE TABLE fda_snapshot.recalls;
DROP LIGHTNING DATABASE TABLE fda_snapshot.shortages;
DROP LIGHTNING DATABASE TABLE fda_snapshot.ndc_packages;
DROP LIGHTNING DATABASE fda_snapshot;
DROP LIGHTNING DATABASE TABLE wholesaler.catalog;
DROP LIGHTNING DATABASE wholesaler;
DROP LIGHTNING DATABASE TABLE fda_live.shortages_raw;
DROP LIGHTNING DATABASE TABLE fda_live.recalls_raw;
DROP LIGHTNING DATABASE fda_live;
DROP LIGHTNING DATABASE TABLE fda_updates.recall_updates;
DROP LIGHTNING DATABASE fda_updates;
