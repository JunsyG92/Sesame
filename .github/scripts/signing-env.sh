#!/usr/bin/env bash
# Exports to the following steps only the signing variables that are set, so
# that electron-builder signs/notarises when secrets exist and silently builds
# unsigned installers otherwise (an empty CSC_LINK would make it fail).
set -euo pipefail
export_if_set() {
  local name="$1"
  if [ -n "${!name:-}" ]; then
    {
      echo "${name}<<__SESAME_EOF__"
      printf '%s\n' "${!name}"
      echo "__SESAME_EOF__"
    } >> "$GITHUB_ENV"
    echo "${name}: configured"
  fi
}
for name in CSC_LINK CSC_KEY_PASSWORD WIN_CSC_LINK WIN_CSC_KEY_PASSWORD \
  APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  export_if_set "$name"
done
# The App Store Connect key is provided as content; electron-builder wants a file.
if [ -n "${APPLE_API_KEY_CONTENT:-}" ]; then
  key_file="$RUNNER_TEMP/apple-api-key.p8"
  printf '%s' "$APPLE_API_KEY_CONTENT" > "$key_file"
  echo "APPLE_API_KEY=$key_file" >> "$GITHUB_ENV"
  echo "APPLE_API_KEY: configured"
fi
if [ -z "${CSC_LINK:-}" ] && [ "$(uname)" = "Darwin" ]; then
  echo "CSC_IDENTITY_AUTO_DISCOVERY=false" >> "$GITHUB_ENV"
  echo "No macOS certificate: building an unsigned, non-notarised app."
fi
