#!/usr/bin/env bash
# Print release notes grouped by conventional commit type.
# Usage: release-notes.sh <git-range-or-rev> <version-without-v> <image> [prerelease]
set -euo pipefail

range=$1
version=$2
image=$3
prerelease=${4:-false}

new="" bugs="" perf="" refac="" docs="" ci="" deps="" misc=""
breaking=""
total=0

# One record per commit: short sha, subject, body, separated by control characters.
while IFS= read -r -d $'\x1e' record; do
  record=${record#$'\n'}
  [[ -z $record ]] && continue
  sha=${record%%$'\x1f'*}
  rest=${record#*$'\x1f'}
  subject=${rest%%$'\x1f'*}
  body=${rest#*$'\x1f'}

  re='^([a-z]+)(\(([^)]*)\))?(!)?: (.+)$'
  [[ $subject =~ $re ]] || continue
  type=${BASH_REMATCH[1]}
  scope=${BASH_REMATCH[3]}
  bang=${BASH_REMATCH[4]}
  summary=${BASH_REMATCH[5]}

  line="- "
  [[ -n $scope ]] && line+="**${scope}:** "
  line+="${summary} (${sha})"
  total=$((total + 1))

  if [[ -n $bang || $body == *"BREAKING CHANGE"* ]]; then
    breaking+="${line}"$'\n'
  fi

  if [[ $scope == deps ]]; then
    deps+="${line}"$'\n'
  else
    case $type in
      feat) new+="${line}"$'\n' ;;
      fix) bugs+="${line}"$'\n' ;;
      perf) perf+="${line}"$'\n' ;;
      refactor) refac+="${line}"$'\n' ;;
      docs) docs+="${line}"$'\n' ;;
      build | ci) ci+="${line}"$'\n' ;;
      *) misc+="${line}"$'\n' ;;
    esac
  fi
done < <(git log --no-merges --reverse --format='%h%x1f%s%x1f%b%x1e' "$range")

if [[ $prerelease == true ]]; then
  echo "Pre-release ${version} of Hinomi. It does not move the \`latest\` image tag."
else
  echo "Hinomi ${version}: ${total} changes."
fi
echo
echo '```sh'
echo "docker pull ${image}:${version}"
echo '```'

if [[ -n $breaking ]]; then
  printf '\n## Breaking changes\n\n%s' "$breaking"
fi

section() {
  [[ -n $2 ]] || return 0
  printf '\n## %s\n\n%s' "$1" "$2"
}
section "What's New" "$new"
section "Bug Fixes" "$bugs"
section "Performance" "$perf"
section "Refactoring" "$refac"
section "Documentation" "$docs"
section "Build and CI" "$ci"
section "Dependencies" "$deps"
section "Under the Hood" "$misc"
