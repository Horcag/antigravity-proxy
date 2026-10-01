import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const library = join(process.cwd(), 'scripts/release-lib.sh');
const roots: string[] = [];

function fixture(program: string) {
  const root = mkdtempSync(join(tmpdir(), 'proxy-object-ownership-'));
  roots.push(root);
  const result = spawnSync('bash', ['-c', `set -Eeuo pipefail
source "$1"
proof_root=$2
ownership_init
declare -A migration_staged_file_tokens=()
${program}`, 'ownership-test', library, root], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, RELEASE_TEST_MODE: '1', ROOT_PREFIX: root },
  });
  return { root, result };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release object ownership', () => {
  it('closes proof descriptors before spawning persistent commands', () => {
    const { root, result } = fixture(`
printf 'owned\n' > "$proof_root/file"
ownership_acquire token "$proof_root/file" file "$proof_root"
descriptor=\${ownership_fds[$token]}
ownership_without_references bash -c '[[ ! -e /proc/$$/fd/$1 ]]' child "$descriptor"
ownership_matches "$proof_root/file" "$token" file
ownership_release_all
`);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(root)).toEqual(['file']);
  });

  for (const failure of ['create', 'acquire', 'publish']) {
    it(`removes private link staging after ${failure} failure without touching its destination`, () => {
      const { root, result } = fixture(`
ln -s original "$proof_root/destination"
${failure === 'create' ? 'ln() { return 7; }' : failure === 'acquire' ? 'ln() { [[ $1 != -P ]] || return 7; command ln "$@"; }' : 'mv() { return 7; }'}
if publish_owned_link "$proof_root/destination" replacement token; then exit 90; fi
ownership_release_all
`);
      expect(result.status, result.stderr).toBe(0);
      expect(readlinkSync(join(root, 'destination'))).toBe('original');
      expect(readdirSync(root)).toEqual(['destination']);
    });
  }

  it('refuses cross-filesystem migration before publishing any target', () => {
    const { root, result } = fixture(`
mkdir "$proof_root/target"
printf 'retained\n' > "$proof_root/staged"
stat() {
  if [[ $1 == -c && $2 == %d && $4 == "$proof_root/target" ]]; then printf '999999999\n'; else command stat "$@"; fi
}
publish_staged_migration_file "$proof_root/staged" "$proof_root/target/file" migration
`);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('cross-filesystem');
    expect(readFileSync(join(root, 'staged'), 'utf8')).toBe('retained\n');
    expect(readdirSync(join(root, 'target'))).toEqual([]);
  });

  it('never nests a migration source inside a concurrent destination directory', () => {
    const { root, result } = fixture(`
printf 'retained\n' > "$proof_root/staged"
mv() {
  mkdir "$proof_root/destination"
  printf 'foreign\n' > "$proof_root/destination/sentinel"
  command mv "$@"
}
publish_staged_migration_file "$proof_root/staged" "$proof_root/destination" migration
`);
    expect(result.status, result.stderr).toBe(1);
    expect(readFileSync(join(root, 'staged'), 'utf8')).toBe('retained\n');
    expect(readdirSync(join(root, 'destination'))).toEqual(['sentinel']);
  });

  it('seals a dependency-shaped tree without exhausting a small descriptor limit', () => {
    const { root, result } = fixture(`
ulimit -n 64
mkdir "$proof_root/tree"
for ((i=0; i<160; i++)); do
  mkdir "$proof_root/tree/package-$i"
  for ((j=0; j<8; j++)); do printf 'dependency\n' > "$proof_root/tree/package-$i/file-$j"; done
done
ownership_acquire token "$proof_root/tree" directory "$proof_root"
ownership_seal "$token" "$proof_root/tree"
safe_cleanup_owned_path "$proof_root/tree" "$token" directory dependencies ''
ownership_release_all
`);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(root)).toEqual([]);
  }, 35_000);

  it('refuses writable empty descendants and replaceable ancestors', () => {
    const { root, result } = fixture(`
mkdir -p "$proof_root/tree/writable" "$proof_root/ancestor/private"
chmod 0777 "$proof_root/tree/writable" "$proof_root/ancestor"
ownership_acquire token "$proof_root/tree" directory "$proof_root"
if ownership_seal "$token" "$proof_root/tree"; then exit 90; fi
printf 'retained\n' > "$proof_root/ancestor/private/file"
if ownership_acquire unsafe "$proof_root/ancestor/private/file" file; then exit 91; fi
ownership_release_all
`);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, 'tree/writable'))).toBe(true);
    expect(readFileSync(join(root, 'ancestor/private/file'), 'utf8')).toBe('retained\n');
  });

  it('refuses writable regular files even beneath protected directories', () => {
    const { root, result } = fixture(`
mkdir "$proof_root/tree"
printf 'retained\n' > "$proof_root/tree/file"
chmod 0666 "$proof_root/tree/file"
ownership_acquire token "$proof_root/tree" directory "$proof_root"
if ownership_seal "$token" "$proof_root/tree"; then exit 90; fi
ownership_release_all
`);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'tree/file'), 'utf8')).toBe('retained\n');
  });

  it('refuses partial traversal during sealing and verification', () => {
    const { root, result } = fixture(`
mkdir "$proof_root/tree"
printf 'retained\n' > "$proof_root/tree/file"
ownership_acquire token "$proof_root/tree" directory "$proof_root"
find() { command find "$@"; return 7; }
if ownership_seal "$token" "$proof_root/tree"; then exit 90; fi
unset -f find
ownership_seal "$token" "$proof_root/tree"
find() { command find "$@"; return 7; }
if safe_cleanup_owned_path "$proof_root/tree" "$token" directory partial ''; then exit 91; fi
unset -f find
ownership_release_all
`);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'tree/file'), 'utf8')).toBe('retained\n');
  });

  for (const kind of ['file', 'directory', 'link']) {
    it(`preserves a substituted ${kind} despite a legacy identity collision`, () => {
      const { root, result } = fixture(`
p="$proof_root/object"
kind=${kind}
case "$kind" in
  file) printf 'original\n' > "$p" ;;
  directory) mkdir "$p"; printf 'original\n' > "$p/original" ;;
  link) ln -s missing-original "$p" ;;
esac
ownership_acquire token "$p" "$kind" "$proof_root"
if [[ $kind == directory ]]; then ownership_seal "$token" "$p"; fi
legacy_identity=$(file_identity "$p")
rm -rf -- "$p"
case "$kind" in
  file) printf 'replacement\n' > "$p" ;;
  directory) mkdir "$p"; printf 'replacement\n' > "$p/sentinel" ;;
  link) ln -s missing-replacement "$p" ;;
esac
file_identity() { printf '%s\n' "$legacy_identity"; }
[[ $(file_identity "$p") == "$legacy_identity" ]]
if safe_cleanup_owned_path "$p" "$token" "$kind" replacement ''; then exit 90; fi
ownership_release_all
`);
      expect(result.status, result.stderr).toBe(0);
      const path = join(root, 'object');
      if (kind === 'file') expect(readFileSync(path, 'utf8')).toBe('replacement\n');
      if (kind === 'directory') expect(readFileSync(join(path, 'sentinel'), 'utf8')).toBe('replacement\n');
      if (kind === 'link') expect(readlinkSync(path)).toBe('missing-replacement');
    });
  }

  it('retains injected directory children and edits to an owned file', () => {
    const { root, result } = fixture(`
mkdir "$proof_root/object"
printf 'owned\n' > "$proof_root/object/owned"
ownership_acquire token "$proof_root/object" directory "$proof_root"
ownership_seal "$token" "$proof_root/object"
printf 'injected\n' > "$proof_root/object/foreign"
if safe_cleanup_owned_path "$proof_root/object" "$token" directory injected ''; then exit 90; fi
printf 'original\n' > "$proof_root/file"
ownership_acquire file_token "$proof_root/file" file "$proof_root"
printf 'modified\n' > "$proof_root/file"
if safe_cleanup_owned_path "$proof_root/file" "$file_token" file edited ''; then exit 91; fi
ownership_release_all
`);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'object/foreign'), 'utf8')).toBe('injected\n');
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('modified\n');
  });

  it('cleans exact unchanged objects and releases all proof resources', () => {
    const { root, result } = fixture(`
before_fds=$(find /proc/$BASHPID/fd -mindepth 1 -maxdepth 1 | wc -l)
mkdir "$proof_root/directory"
printf 'owned\n' > "$proof_root/directory/child"
printf 'owned\n' > "$proof_root/file"
ln -s missing-target "$proof_root/link"
for kind in directory file link; do
  p="$proof_root/$kind"
  ownership_acquire token "$p" "$kind" "$proof_root"
  if [[ $kind == directory ]]; then ownership_seal "$token" "$p"; fi
  safe_cleanup_owned_path "$p" "$token" "$kind" exact ''
done
ownership_release_all
after_fds=$(find /proc/$BASHPID/fd -mindepth 1 -maxdepth 1 | wc -l)
[[ "$before_fds" == "$after_fds" ]]
`);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(root)).toEqual([]);
  });

  it('cleans an unchanged sealed subtree from a failed transaction EXIT trap', () => {
    const { root, result } = fixture(`
mkdir "$proof_root/directory"
printf 'owned\n' > "$proof_root/directory/child"
ownership_acquire token "$proof_root/directory" directory "$proof_root"
ownership_seal "$token" "$proof_root/directory"
trap 'status=$?; set +e; safe_cleanup_owned_path "$proof_root/directory" "$token" directory failed ""; cleanup_status=$?; ownership_release_all; [[ $cleanup_status == 0 ]] || exit 91; exit "$status"' EXIT
exit 7
`);
    expect(result.status, result.stderr).toBe(7);
    expect(readdirSync(root)).toEqual([]);
  });

  it('pins the symlink itself without acquiring or modifying its referent', () => {
    const { root, result } = fixture(`
printf 'referent\n' > "$proof_root/referent"
ln -s referent "$proof_root/link"
ownership_acquire token "$proof_root/link" link "$proof_root"
safe_cleanup_owned_path "$proof_root/link" "$token" link exact ''
ownership_release_all
`);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'referent'), 'utf8')).toBe('referent\n');
    expect(readdirSync(root)).toEqual(['referent']);
  });

  it('rejects a dropped token and acquisition through an unprotected parent', () => {
    const { root, result } = fixture(`
printf 'owned\n' > "$proof_root/file"
ownership_acquire token "$proof_root/file" file "$proof_root"
ownership_drop "$token"
if safe_cleanup_owned_path "$proof_root/file" "$token" file dropped ''; then exit 90; fi
mkdir "$proof_root/unprotected"
chmod 0777 "$proof_root/unprotected"
printf 'foreign\n' > "$proof_root/unprotected/file"
if ownership_acquire bad "$proof_root/unprotected/file" file "$proof_root/unprotected"; then exit 91; fi
ownership_release_all
`);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('owned\n');
    expect(readFileSync(join(root, 'unprotected/file'), 'utf8')).toBe('foreign\n');
  });

  it('refuses missing proof without aborting the remaining cleanup lifecycle', () => {
    const { root, result } = fixture(`
printf 'retained\n' > "$proof_root/file"
ownership_acquire token "$proof_root/file" file "$proof_root"
if safe_cleanup_owned_path "$proof_root/file" '' file missing ''; then exit 90; fi
ownership_matches "$proof_root/file" "$token" file
ownership_release_all
`);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('retained\n');
  });

  it('retains a concurrent original-path replacement after quarantine detach', () => {
    const { root, result } = fixture(`
printf 'owned\n' > "$proof_root/file"
ownership_acquire token "$proof_root/file" file "$proof_root"
substitute_cleanup_test_entry() { printf 'concurrent\n' > "$2"; }
if safe_cleanup_owned_path "$proof_root/file" "$token" file concurrent checkpoint; then exit 90; fi
[[ -n "$owned_quarantine_path" && $(cat "$owned_quarantine_path") == owned ]]
ownership_release_all
`);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('concurrent\n');
    expect(readdirSync(root).some((name) => name.includes('.quarantine.'))).toBe(true);
  });

  it('places quarantine outside a directory writable by the service user', () => {
    const { root, result } = fixture(`
printf 'owned\n' > "$proof_root/file"
ownership_acquire token "$proof_root/file" file "$proof_root"
mkdir "$proof_root/service"
chmod 0777 "$proof_root/service"
mv "$proof_root/file" "$proof_root/service/file"
ownership_transfer "$token" "$proof_root/service/file"
substitute_cleanup_test_entry() {
  [[ $(dirname "$owned_quarantine_dir") == "$proof_root" ]] || exit 91
  printf 'foreign\n' > "$2"
}
if safe_cleanup_owned_path "$proof_root/service/file" "$token" file service checkpoint; then exit 90; fi
[[ $(cat "$owned_quarantine_path") == owned ]]
ownership_release_all
`);
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(root, 'service'))).toEqual(['file']);
    expect(readFileSync(join(root, 'service/file'), 'utf8')).toBe('foreign\n');
    expect(readdirSync(root).some((name) => name.includes('.quarantine.'))).toBe(true);
  });

  it('keeps a parent pin valid across a rollback subshell', () => {
    const { root, result } = fixture(`
printf 'owned\n' > "$proof_root/file"
ownership_acquire token "$proof_root/file" file "$proof_root"
( ownership_matches "$proof_root/file" "$token" file )
ownership_matches "$proof_root/file" "$token" file
safe_cleanup_owned_path "$proof_root/file" "$token" file exact ''
ownership_release_all
`);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, 'file'))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});
