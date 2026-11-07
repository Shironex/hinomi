#!/usr/bin/env bash
# Self test for release-notes.sh: a throwaway git repo and a stub `gh`, no network.
#   .github/scripts/release-notes.test.sh
set -euo pipefail

script=$(cd "$(dirname "$0")" && pwd)/release-notes.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir "$work/bin" "$work/repo"
# The stub answers commits/<sha>/pulls from files named after the commit subject:
# c1 and c2 land PR 5 (de-duplicated), c3 lands PR 4 (lower number, listed first),
# c4 is the previous release's own PR (left out), c5 only has an unmerged PR.
cat > "$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
sha=${2#repo*/commits/}; sha=${sha%/pulls}
subject=$(git -C "$STUB_REPO" log -1 --format=%s "$sha")
case $subject in
  c1 | c2) echo '[{"merged_at":"2026-01-02T00:00:00Z","number":5,"title":"feat(web): second","user":{"login":"ann"},"base":{"ref":"main"}}]' ;;
  c3) echo '[{"merged_at":"2026-01-03T00:00:00Z","number":4,"title":"fix(server): first","user":{"login":"bob"},"base":{"ref":"main"}}]' ;;
  c4) echo '[{"merged_at":"2026-01-01T00:00:00Z","number":3,"title":"chore(release): 1.0.0","user":{"login":"ann"},"base":{"ref":"main"}}]' ;;
  c5) echo '[{"merged_at":null,"number":6,"title":"wip","user":{"login":"ann"},"base":{"ref":"main"}}]' ;;
  *) echo '[]' ;;
esac | jq -r "$jqx"
STUB
# Pull the --jq expression out of the argument list.
sed -i.bak 's|^sha=|jqx=.; args=("$@"); for ((i=0;i<${#args[@]};i++)); do [[ ${args[i]} == --jq ]] \&\& jqx=${args[i+1]}; done\nsha=|' "$work/bin/gh"
chmod +x "$work/bin/gh"

cd "$work/repo"
git init -q -b main
git config user.name test
git config user.email test@example.com
git config commit.gpgsign false
printf '# Changelog\n\n## 1.1.0 (2026-01-05)\n\nShort intro.\n\n### Highlights\n\n- one\n\n## 1.0.0 (2026-01-01)\n\nOld.\n' > CHANGELOG.md
git add . && git commit -q -m c4 && git tag v1.0.0
for c in c1 c2 c3 c5; do git commit -q --allow-empty -m "$c"; done
git tag v1.1.0
git tag v1.2.0-rc.1

export PATH="$work/bin:$PATH" STUB_REPO="$work/repo" GITHUB_REPOSITORY=acme/app GH_TOKEN=x
fail() { echo "FAIL: $1" >&2; exit 1; }

out=$("$script" v1.1.0 v1.0.0 1.1.0 ghcr.io/acme/app false)
expected_start=$'Short intro.\n\n### Highlights\n\n- one\n\n### Install'
[[ $out == "$expected_start"* ]] || fail "changelog section missing or has its heading"
[[ $out != *"Old."* ]] || fail "previous version section leaked in"
grep -q '^docker pull ghcr.io/acme/app:1.1.0$' <<< "$out" || fail "docker pull line"
grep -q 'HINOMI_VERSION=1.1.0 docker compose up -d' <<< "$out" || fail "compose line"
grep -q 'gh attestation verify oci://ghcr.io/acme/app:1.1.0 -R acme/app' <<< "$out" || fail "attestation line"
prs=$(sed -n '/^### Pull requests$/,/^\*\*Full changelog/p' <<< "$out" | grep '^- ')
[[ $prs == $'- fix(server): first by @bob in #4\n- feat(web): second by @ann in #5' ]] || fail "pull request list: $prs"
tail -n1 <<< "$out" | grep -qx '\*\*Full changelog\*\*: https://github.com/acme/app/compare/v1.0.0...v1.1.0' || fail "compare link"

# No changelog section: the pre-release fallback line, same sections after it.
out=$("$script" v1.2.0-rc.1 v1.1.0 1.2.0-rc.1 ghcr.io/acme/app true)
[[ $out == "Pre-release 1.2.0-rc.1 of Hinomi. It does not move the \`latest\` image tag."$'\n\n### Install'* ]] || fail "pre-release fallback"
grep -q '^### Pull requests$' <<< "$out" || fail "pre-release pull requests section"
grep -q 'compare/v1.1.0...v1.2.0-rc.1' <<< "$out" || fail "pre-release compare link"

echo "release-notes: ok"
