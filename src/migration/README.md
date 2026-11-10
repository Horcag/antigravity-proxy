# EasyCLI import recovery

Run `migration import-easycli --stdin` offline, with the destination service stopped.
Before importing, retain a backup of the destination configuration, encrypted account
database and its encryption key. Follow the repository backup procedure for SQLite;
copying a live database file alone may omit committed WAL data.

The importer validates the complete input and prepares original account snapshots
before saving. If a persistence operation throws, it restores every prepared account
(including an operation that may have committed before throwing), removes newly
prepared rows, and restores the previous effective configuration. A successful
compensation reports `previous state restored`. If any restoration fails, it continues
the other restoration attempts and reports `partial migration; restore destination
backup before retry`, with a safe phase and failure count. Errors omit credentials.

This compensation handles errors observed by the running process. It is not an atomic
transaction across configuration and SQLite, and cannot recover a killed process,
power loss or system crash. Restore the retained destination backup before retrying
an interrupted import or an import reporting partial migration. Configuration recovery
uses ConfigManager, so formatting and materialized defaults may differ from the original
file while its effective settings are restored.

Import refreshes credentials and profile metadata while preserving existing expired or
review-required status, reason, quota restrictions and active selection. Source `active`
metadata cannot silently reactivate a locally suspended account. Enable it through the
console's explicit review flow after resolving the upstream restriction. Import result
counts describe the persisted account states. Exact snapshot compensation uses the
separate low-level write path so an interrupted blocked-state import can still restore
an originally active account.
