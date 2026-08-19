import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { projectSessionEntryList } from "./session-accessor.sqlite-entry-cache.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import type { SessionEntryListScope, SessionEntrySummary } from "./session-accessor.types.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";

/**
 * Visits SQLite session entries without building or retaining a store-wide cache snapshot.
 * Callers may retain selected rows, but the accessor releases every other parsed entry before
 * advancing the SQLite iterator.
 */
export function scanSessionEntriesReadOnly(
  scope: SessionEntryListScope,
  visit: (summary: SessionEntrySummary) => void,
): number {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    assertCanonicalSqliteSessionKeysCurrent(database);
    const rows = iterateSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_nodes")
        .select(["session_key", "entry_json", "updated_at"])
        .orderBy("session_key"),
    );
    let count = 0;
    for (const row of rows) {
      if (isInternalSessionEffectsKey(row.session_key)) {
        continue;
      }
      const entry = parseSessionEntryJson(row);
      if (!entry) {
        continue;
      }
      visit({
        sessionKey: row.session_key,
        entry: scope.projection === "list" ? projectSessionEntryList(entry) : entry,
      });
      count += 1;
    }
    return count;
  }, toDatabaseOptions(resolved));
  return result.found ? result.value : 0;
}
