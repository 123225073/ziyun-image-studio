#!/usr/bin/env bash
set -euo pipefail

version=$(node -p 'require("./package.json").version')
[[ "$RELEASE_TAG" == "v$version" && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
commit=$(git rev-parse HEAD)
notes=".github/release-notes-$RELEASE_TAG.md"
test -s "$notes"
latest=$(gh api "repos/$GH_REPO/releases/latest" --jq .id)
names=("ZiyunStudio-$version-mac-arm64.dmg" "ZiyunStudio-$version-mac-x64.dmg")
for name in "${names[@]}"; do test -s "assets/$name"; done
(cd assets && sha256sum "${names[@]}" > SHA256SUMS.txt)
names+=(SHA256SUMS.txt)

# The public version and previously published files are immutable. A rerun
# may resume uploads to its own draft after an interrupted network transfer.
if [[ -n "$(git ls-remote --tags origin "refs/tags/$RELEASE_TAG")" ]]; then
  git fetch --no-tags origin "refs/tags/$RELEASE_TAG"
  test "$(git rev-parse 'FETCH_HEAD^{commit}')" = "$commit"
fi
if gh release view "$RELEASE_TAG" --json isDraft,targetCommitish > draft.json 2>/dev/null; then
  jq -e --arg commit "$commit" '.isDraft and .targetCommitish == $commit' draft.json >/dev/null
else
  gh release create "$RELEASE_TAG" --draft --latest=false --target "$commit" \
    --title "子云影像工坊 $version · macOS" --notes-file "$notes"
fi
gh release upload "$RELEASE_TAG" "assets/${names[0]}" "assets/${names[1]}" assets/SHA256SUMS.txt --clobber
verified=$(mktemp -d)
gh release download "$RELEASE_TAG" --dir "$verified"
(cd "$verified" && sha256sum --check --strict SHA256SUMS.txt)
gh release view "$RELEASE_TAG" --json isDraft,assets > draft.json
jq -e '.isDraft and (.assets | length) == 3' draft.json >/dev/null
for name in "${names[@]}"; do
  cmp -- "assets/$name" "$verified/$name"
  size=$(stat -c %s "assets/$name")
  digest=$(sha256sum "assets/$name" | cut -d' ' -f1)
  jq -e --arg name "$name" --arg digest "sha256:$digest" --argjson size "$size" \
    '.assets[] | select(.name == $name and .state == "uploaded" and .size == $size and .digest == $digest)' draft.json >/dev/null
  printf 'Verified GitHub attachment %s (%s bytes, SHA-256 %s)\n' "$name" "$size" "$digest"
done
gh release edit "$RELEASE_TAG" --target "$commit" --draft=false --prerelease=false --latest=false
gh release view "$RELEASE_TAG" --json isDraft,isPrerelease --jq '(.isDraft == false and .isPrerelease == false)' | grep -x true
test "$(gh api "repos/$GH_REPO/commits/$RELEASE_TAG" --jq .sha)" = "$commit"
test "$(gh api "repos/$GH_REPO/releases/latest" --jq .id)" = "$latest"
