// Regenerate DCL from the same policy both data backends enforce.
import { writeFileSync } from "node:fs";
import { AGENT_TABLES, principalName, type Principal } from "../src/data/policy.ts";
const setup: string[] = ["-- Generated from src/data/policy.ts by scripts/generate-principal-sql.ts.\n-- ADD USER WITH is supported by the local Lightning parser (not listed in the guide)."];
const reverse: string[] = ["-- Reverse only the Lotline runtime principals and grants."];
for (const [agent, tables] of Object.entries(AGENT_TABLES)) {
  const role = principalName(agent as Principal), user = '${ZETARIS_' + agent.toUpperCase() + '_USER}', password = '${ZETARIS_' + agent.toUpperCase() + '_PASSWORD}';
  setup.push(`ADD USER WITH (name '${role}', email '${user}', password '${password}');`, `CREATE ROLE '${role}' DESCRIBE BY 'Lotline ${agent} read-only tables';`, `ASSIGN USER '${user}' TO ROLE '${role}';`);
  for (const table of tables) {
    const type = table.startsWith("hospital.") ? "DATASOURCE" : table.startsWith("fda_live_views.") ? "VIEW" : "LIGHTNING DATABASE";
    setup.push(`GRANT SELECT ON ${type} TABLE ${table} TO ROLE '${role}';`);
    reverse.push(`REVOKE SELECT ON ${type} TABLE ${table} FROM ROLE '${role}';`);
  }
  reverse.push(`REVOKE USER '${user}' FROM ROLE '${role}';`, `DROP USER '${user}';`, `DROP ROLE '${role}';`);
}
writeFileSync("scripts/setup_zetaris_principals.sql", setup.join("\n") + "\n");
writeFileSync("scripts/teardown_zetaris_principals.sql", reverse.join("\n") + "\n");
