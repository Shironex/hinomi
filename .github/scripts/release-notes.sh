#!/usr/bin/env bash
# Print the GitHub release notes for a tag:
#   1. the version's section of CHANGELOG.md (or a short line when it has none),
#   2. Install,
#   3. Pull requests merged into the base branch in the release range, oldest first,
#   4. the full changelog compare link.
#
# Usage: release-notes.sh <tag> <previous-tag-or-empty> <version-without-v> <image> [prerelease]
#
# Needs git history and tags, and `gh` with a token that can read pull requests
# (GH_TOKEN, and GITHUB_REPOSITORY as owner/name). It is read only, so it is safe to run
# locally as a dry run against any past tag:
#   GH_TOKEN=$(gh auth token) GITHUB_REPOSITORY=Shironex/hinomi \
#     .github/scripts/release-notes.sh v0.2.0 v0.1.0 0.2.0 ghcr.io/shironex/hinomi
# RELEASE_BASE_BRANCH (default main) is the branch whose merged PRs are listed.
set -euo pipefail

tag=$1
prev=$2
version=$3
image=$4
prerelease=${5:-false}

repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
base=${RELEASE_BASE_BRANCH:-main}

if [[ -n $prev ]]; then range="${prev}..${tag}"; else range="$tag"; fi

# 1. The changelog section, read from the tag itself, without its heading line.
section=$(git show "${tag}:CHANGELOG.md" 2>/dev/null | awk -v v="$version" '
  /^## / {
    if (inside) exit
    if ($2 == v) { inside = 1; next }
  }
  inside { print }
' | sed -e :a -e '/^[[:space:]]*$/{$d;N;ba' -e '}' | sed '/./,$!d') || section=""

if [[ -n $section ]]; then
  printf '%s\n' "$section"
elif [[ $prerelease == true ]]; then
  echo "Pre-release ${version} of Hinomi. It does not move the \`latest\` image tag."
else
  echo "Hinomi ${version}."
fi

# 2. Install.
cat <<INSTALL

### Install

\`\`\`sh
docker pull ${image}:${version}
\`\`\`

Or with the bundled compose file: \`HINOMI_VERSION=${version} docker compose up -d\`. The full guide is in [docs/self-hosting.md](https://github.com/${repo}/blob/main/docs/self-hosting.md). Verify the image with \`gh attestation verify oci://${image}:${version} -R ${repo}\`.
INSTALL

# 3. Pull requests. The pulls endpoint is keyed by commit, so a rebase-merged commit
# resolves to the PR that landed it exactly. A PR is listed once, oldest (lowest number) first.
# The previous release's own PR ("chore(release): <prev>") is left out.
prev_release_title=""
[[ -n $prev ]] && prev_release_title="chore(release): ${prev#v}"

# One commit's merged PRs on the base branch as tab separated rows. Retries a few times
# because a release should not fail on one flaky API call.
pulls_of() {
  local attempt
  for attempt in 1 2 3 4; do
    if gh api "repos/${repo}/commits/$1/pulls" --paginate \
      --jq ".[] | select(.merged_at != null and .base.ref == \"${base}\") | [.merged_at, .number, .title, .user.login] | @tsv"; then
      return 0
    fi
    sleep $((attempt * 2))
  done
  return 1
}

printf '\n### Pull requests\n\n'
while IFS= read -r sha; do
  pulls_of "$sha"
done < <(git rev-list --reverse "$range") |
  sort -t$'\t' -k2,2n -u |
  while IFS=$'\t' read -r _ number title author; do
    [[ $title == "$prev_release_title" ]] && continue
    echo "- ${title} by @${author} in #${number}"
  done

# 4. Compare link.
echo
if [[ -n $prev ]]; then
  echo "**Full changelog**: https://github.com/${repo}/compare/${prev}...${tag}"
else
  echo "**Full changelog**: https://github.com/${repo}/commits/${tag}"
fi
