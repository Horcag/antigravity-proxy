# Installer ownership and cleanup

The installer acquires ownership proof before publishing an object. Files and
directories remain pinned by an open descriptor in the installer shell. A
symlink is retained through a physical hard link in a private directory on the
same filesystem; its target is never followed. Renaming transfers the existing
proof. Re-observing a public pathname does not create replacement proof.

Acquisition requires an installer-owned parent without group or other write
permissions. Ancestors must be root- or installer-owned and protected against
replacement; sticky shared ancestors are accepted only for protected owned
entries. Publication relies on these trusted parents. This boundary does not
claim protection against another privileged process deliberately racing the
installer.

Recursive cleanup additionally requires a protected subtree. Directories and
regular files must remain installer-owned without group or other write
permissions. A complete inventory records entry identities, metadata, symlink
targets and file hashes. Failed traversal, unexpected descendants or changed
content refuse cleanup. This inventory uses bounded descriptor resources even
for dependency trees. Known migration transfers update only the recorded
remaining children; cleanup does not adopt new entries. Cross-filesystem
migration publication is refused before moving the source.

Cleanup detaches an entry into a private quarantine, verifies the retained
object and subtree, and then removes it. A concurrent replacement is preserved.
If safe restoration is impossible, the quarantine remains for inspection.
Incomplete build staging whose contents cannot be proven also remains rather
than being recursively deleted without authority.

Both install and rollback release their proof resources on exit. Commands that
may create persistent children run without ownership descriptors; the parent
keeps its references through recovery. Releasing proof does not delete retained
foreign data or unresolved quarantines.

The regressions cover metadata collisions, file and directory substitution,
injected descendants, writable entries, incomplete traversal, symlink referents,
small descriptor limits, publication failures and recovery lifecycle. Source
checks and PR integration do not activate the installer or establish live proxy
acceptance.
